"use client";

// AI Assistant console (the "manual AI order placement" surface). The user converses; the chat
// backend (POST /api/chat) may return a draft order ticket; the user runs a policy dry-run, stages
// it as a real `proposed` TradeProposal (POST /api/proposals/from-draft), then confirms inline —
// which calls the EXISTING approve→executeProposal rail. The assistant never executes on its own.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { ExecutionState } from "@/lib/execution-mode";
import { humanizeLlmError } from "@/lib/llm-errors";
import { LLM_REQUIRED_CHAT_MESSAGE } from "@/lib/llm-required";
import { Button, Card, Chip, EmptyState, inputClass } from "./primitives";
import { Markdown } from "./markdown";
import { ModelPicker } from "./model-picker";
import { CHAT_MODEL_GROUPS, CUSTOM_MODEL_ID_SEED, DEFAULT_LLM_MODEL } from "./llm-model-catalog";
import { cn } from "./cn";

interface ChatDraft {
  draft_id: string;
  symbol: string;
  side: string;
  qty: number;
  order_type: string;
  limit_usd: number | null;
  rationale: string;
  account_label: string;
  is_real: boolean;
  blocked: boolean;
  warnings: string[];
  executed: boolean;
}
interface Citation {
  source: string;
  chunk_id?: string;
  as_of?: string;
  url?: string;
}
interface ChatReply {
  text: string;
  draft: ChatDraft | null;
  citations: Citation[];
  intent: string;
  model?: string;
}
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  model?: string;
  citations?: Citation[];
  draft?: ChatDraft | null;
}

type DraftPhase = "draft" | "checking" | "checked" | "sending" | "proposed" | "placing" | "done" | "rejecting" | "rejected" | "discarded";
interface DraftState {
  phase: DraftPhase;
  decision?: { approved: boolean; reasons: string[]; escalatable?: boolean };
  estimatedNotional?: number;
  proposalId?: string;
}

function destination(state: ExecutionState): { text: string; tone: "info" | "up" | "down"; live: boolean } {
  if (state.mode === "broker/live") return { text: `Brokerage${state.accountLabel ? " · " + state.accountLabel : ""}`, tone: "down", live: true };
  if (state.mode === "broker/paper") return { text: `Paper${state.accountLabel ? " · " + state.accountLabel : ""} · broker sandbox`, tone: "up", live: false };
  return { text: "Test · local simulation", tone: "info", live: false };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function readPlainError(res: Response, fallback: string): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let message = raw.trim();
  try {
    const parsed = JSON.parse(message) as { error?: unknown; summary?: unknown; message?: unknown };
    if (typeof parsed.summary === "string") message = parsed.summary;
    else if (typeof parsed.message === "string") message = parsed.message;
    else if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error === "object" && "error" in parsed.error && typeof (parsed.error as { error?: unknown }).error === "string") {
      message = String((parsed.error as { error: string }).error);
    }
  } catch {
    if (message.startsWith("<")) message = "";
  }
  // Turn a raw provider error (e.g. "gemini 401: API key not valid") into a plain-English,
  // provider-aware sentence. The provider + HTTP status are parsed from the message text itself
  // (the route's own status is 500, so we don't pass it).
  if (message) message = humanizeLlmError(message);
  return new Error(message || `${fallback} (${res.status}).`);
}

// Router-matched suggested prompts (co-versioned with classifyIntent so a chip never dead-ends).
// NB: knowledge example says 8-K, not 10-K — only 8-K catalysts are indexed today.
const SUGGESTIONS: Array<{ category: string; prompt: string }> = [
  { category: "Ask", prompt: "What is AAPL trading at?" },
  { category: "Knowledge", prompt: "Any recent 8-K catalysts for TSLA?" },
  { category: "Portfolio", prompt: "How are my positions doing?" },
  { category: "Watchlist", prompt: "What's on my watchlist?" },
  { category: "Alert", prompt: "Alert me if AAPL drops below 180" },
  { category: "Track", prompt: "Add NVDA to my watchlist" },
  { category: "Draft", prompt: "Draft a buy of 10 AAPL at 200" }
];

// Chat-model selector (custom ModelPicker: provider logos + relative price tiers). The chosen model is
// sent as a per-request `model` hint to /api/chat, which routes it to the right provider by name
// (claude-*→Anthropic, grok-*→xAI, gemini-*→Gemini, mistral-*→Mistral, deepseek-*→DeepSeek, else
// OpenAI). Tiers ($/$$/$$$) are relative blended cost. Selection is sticky via localStorage. Per-
// provider key availability comes from /api/chat/providers; unkeyed providers show "no key" + disabled.
const DEFAULT_CHAT_MODEL = DEFAULT_LLM_MODEL;
const CHAT_MODEL_STORAGE_KEY = "assistant.chatModel";

export function AssistantView({
  executionState,
  approveProposal,
  rejectProposal,
  defaultModel
}: {
  executionState: ExecutionState;
  approveProposal: (proposalId: string) => Promise<void>;
  rejectProposal: (proposalId: string) => Promise<void>;
  /** Initial chat model. Overridden by a sticky localStorage choice; defaults to the catalog default. */
  defaultModel?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [model, setModel] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY);
      if (saved) return saved;
    }
    return defaultModel ?? DEFAULT_CHAT_MODEL;
  });
  // Per-provider key availability for the picker. undefined = not yet loaded (treat as available so we
  // never flash "no key" before the check resolves); after load, false = no usable key for that provider.
  const [providerStatus, setProviderStatus] = useState<Partial<Record<string, boolean>>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dest = destination(executionState);

  // Gate chat when NO real LLM provider has a usable key (mirrors the /api/chat 412). The offline Mock
  // model is the only keyless path, so it's never gated. providerStatus is {} until loaded → treat as
  // available so we don't flash the gate before the check resolves (fail open, like the picker).
  const isMockModel = model.trim().toLowerCase() === "mock";
  const providerKeys = Object.keys(providerStatus);
  const noLlmConfigured = !isMockModel && providerKeys.length > 0 && providerKeys.every((p) => providerStatus[p] === false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/chat-history?limit=50");
        if (!res.ok) return;
        const body = (await res.json()) as { turns: Array<{ id: string; role: "user" | "assistant"; text: string; model?: string | null }> };
        if (!cancelled) setMessages(body.turns.map((t) => ({ id: t.id, role: t.role, text: t.text, model: t.model ?? undefined })));
      } catch {
        /* history is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Which providers have a usable key (so the picker can mark/disable ones that don't). Fail open:
  // on error, leave statuses unset → every provider stays selectable. Re-checked on window focus and
  // tab visibility so that connecting a key in Settings (then returning to this tab) immediately
  // unlocks chat — otherwise providerStatus would stay stale until a full reload.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/chat/providers");
        if (!res.ok) return;
        const body = (await res.json()) as { providers?: Partial<Record<string, boolean>> };
        if (!cancelled && body.providers) setProviderStatus(body.providers);
      } catch {
        /* availability is best-effort; default to all selectable */
      }
    };
    void refresh();
    const onFocus = () => void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, drafts]);

  // Persist the chat-model choice so it survives reloads (client-side only — no DB migration).
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, model);
  }, [model]);

  const patchDraft = (msgId: string, patch: Partial<DraftState>) =>
    setDrafts((d) => ({ ...d, [msgId]: { ...(d[msgId] ?? { phase: "draft" }), ...patch } as DraftState }));

  const send = useCallback(async (override?: string) => {
    const message = (typeof override === "string" ? override : input).trim();
    if (!message || sending) return;
    if (noLlmConfigured) {
      toast.error(LLM_REQUIRED_CHAT_MESSAGE);
      return;
    }
    setInput("");
    const stamp = Date.now();
    setMessages((m) => [...m, { id: `u-${stamp}`, role: "user", text: message }]);
    setSending(true);
    try {
      // Per-send idempotency key: the server dedupes the recorded user turn on it, so a
      // double submit (or any future retry of this exact send) can't duplicate the prompt
      // in the saved transcript.
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, model, clientTurnId: crypto.randomUUID() })
      });
      if (!res.ok) throw await readPlainError(res, "Chat request failed");
      const reply = (await res.json()) as ChatReply;
      const id = `a-${stamp}`;
      setMessages((m) => [...m, { id, role: "assistant", text: reply.text, citations: reply.citations, draft: reply.draft, model: reply.model }]);
      if (reply.draft) setDrafts((d) => ({ ...d, [id]: { phase: "draft" } }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Chat request failed.");
      setMessages((m) => [...m, { id: `e-${stamp}`, role: "assistant", text: "Sorry — something went wrong handling that." }]);
    } finally {
      setSending(false);
    }
  }, [input, model, sending, noLlmConfigured]);

  async function checkPolicy(msgId: string, draft: ChatDraft) {
    patchDraft(msgId, { phase: "checking" });
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, dryRun: true })
      });
      const body = await readJson(res);
      if (!res.ok) {
        const reasons = (body.reasons as string[]) ?? [(body.error as string) ?? "Rejected."];
        patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons } });
        return;
      }
      const checkedDecision = body.decision as { approved: boolean; reasons: string[]; escalatable?: boolean };
      // Additive server flag: refused ONLY for escalatable reasons (e.g. an "ask"-mode wash-sale
      // lock) => the draft is still stageable; staging creates a pending card the user approves
      // with the priced cost on it.
      if (body.escalatable === true) checkedDecision.escalatable = true;
      patchDraft(msgId, {
        phase: "checked",
        decision: checkedDecision,
        estimatedNotional: body.estimatedNotional as number | undefined
      });
    } catch (e) {
      patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons: [e instanceof Error ? e.message : "Policy check failed."] } });
    }
  }

  async function sendToApprovals(msgId: string, draft: ChatDraft) {
    patchDraft(msgId, { phase: "sending" });
    try {
      const res = await fetch("/api/proposals/from-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft })
      });
      const body = await readJson(res);
      if (!res.ok) {
        const reasons = (body.reasons as string[]) ?? [(body.error as string) ?? "Could not stage."];
        toast.warning("Could not stage the order", { description: reasons.join("\n") });
        patchDraft(msgId, { phase: "checked", decision: { approved: false, reasons } });
        return;
      }
      patchDraft(msgId, { phase: "proposed", proposalId: body.proposalId as string, estimatedNotional: body.estimatedNotional as number | undefined });
      toast.success("Staged — confirm to place.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Staging failed.");
      patchDraft(msgId, { phase: "checked" });
    }
  }

  async function confirmPlace(msgId: string, proposalId: string) {
    patchDraft(msgId, { phase: "placing" });
    try {
      await approveProposal(proposalId); // existing rail: re-evaluates + executes (paper/live) + toasts + reloads
      patchDraft(msgId, { phase: "done" });
    } catch {
      patchDraft(msgId, { phase: "proposed" });
    }
  }

  async function rejectStaged(msgId: string, proposalId: string) {
    patchDraft(msgId, { phase: "rejecting" });
    try {
      await rejectProposal(proposalId); // existing rail: marks the proposed row rejected + toasts + reloads
      patchDraft(msgId, { phase: "rejected" });
    } catch {
      patchDraft(msgId, { phase: "proposed" });
    }
  }

  return (
    <Card className="flex h-full min-h-[28rem] flex-col p-0">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <span className="text-sm font-medium text-fg">Assistant</span>
          <span className="text-xs text-muted">drafts orders you confirm — it never places on its own</span>
        </div>
        <div className="flex items-center gap-2">
          {(!CHAT_MODEL_GROUPS.flatMap(g => g.options).some(o => o.value === model) || model === "custom") && (
            <input
              type="text"
              className="h-7 w-[10rem] rounded border border-line bg-surface px-2 text-xs text-fg focus:outline-none focus:ring-1 focus:ring-accent"
              value={model === "custom" ? "" : model}
              placeholder="Model ID (e.g. gpt-5.5)"
              onChange={(e) => {
                const val = e.target.value;
                setModel(val || "custom");
                window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, val || "custom");
              }}
            />
          )}
          <ModelPicker
            className="w-[12rem]"
            value={CHAT_MODEL_GROUPS.flatMap(g => g.options).some(o => o.value === model) ? model : "custom"}
            groups={CHAT_MODEL_GROUPS}
            providerStatus={providerStatus}
            onChange={(m) => {
              if (m === "custom") {
                setModel(CUSTOM_MODEL_ID_SEED);
                window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, CUSTOM_MODEL_ID_SEED);
              } else {
                setModel(m);
                window.localStorage.setItem(CHAT_MODEL_STORAGE_KEY, m);
              }
              // Move focus straight to the prompt box so the user can type right after picking a model.
              inputRef.current?.focus();
            }}
          />
          <Chip tone={dest.tone}>{dest.text}</Chip>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="grid h-full place-items-center">
            <div className="max-w-xl text-center">
              <EmptyState
                icon={<Sparkles size={20} />}
                title="Ask the assistant"
                hint="Try one of these — orders always come back as a draft you confirm."
              />
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.prompt}
                    onClick={() => void send(s.prompt)}
                    disabled={sending || noLlmConfigured}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-fg transition hover:border-accent hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="text-[10px] uppercase tracking-wide text-muted">{s.category}</span>
                    <span className="ml-1.5">{s.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn("max-w-[42rem] rounded-lg px-3 py-2 text-sm", m.role === "user" ? "bg-accent/15 text-fg" : "bg-surface-2 text-fg")}
              title={m.role === "assistant" && m.model ? `Answered by ${m.model}` : undefined}
            >
              {m.role === "assistant" ? (
                <Markdown>{m.text}</Markdown>
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
              )}
              {m.citations && m.citations.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.citations.map((c, i) =>
                    c.url ? (
                      <a key={i} href={c.url} target="_blank" rel="noopener noreferrer">
                        <Chip tone="neutral" className="text-[10px] underline decoration-dotted">
                          {c.chunk_id ?? c.source}
                        </Chip>
                      </a>
                    ) : (
                      <Chip key={i} tone="neutral" className="text-[10px]">
                        {c.chunk_id ?? c.source}
                      </Chip>
                    )
                  )}
                </div>
              )}
              {m.draft && (
                <DraftOrderCard
                  draft={m.draft}
                  state={drafts[m.id] ?? { phase: "draft" }}
                  dest={dest}
                  onCheck={() => checkPolicy(m.id, m.draft!)}
                  onSend={() => sendToApprovals(m.id, m.draft!)}
                  onConfirm={(pid) => confirmPlace(m.id, pid)}
                  onReject={(pid) => rejectStaged(m.id, pid)}
                  onDiscard={() => patchDraft(m.id, { phase: "discarded" })}
                />
              )}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> thinking…
          </div>
        )}
      </div>

      <div className="border-t border-line p-3">
        {noLlmConfigured && (
          <p className="mb-2 flex items-center gap-1.5 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
            <AlertTriangle size={14} /> {LLM_REQUIRED_CHAT_MESSAGE}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className={cn(inputClass, "min-h-[2.5rem] flex-1 resize-none")}
            rows={1}
            placeholder={noLlmConfigured ? "Connect an LLM provider in Settings to chat…" : "Ask a question, or describe an order to draft…"}
            value={input}
            disabled={noLlmConfigured}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button onClick={() => void send()} disabled={sending || !input.trim() || noLlmConfigured} size="md">
            <Send size={16} /> Send
          </Button>
        </div>
      </div>
    </Card>
  );
}

function money(n: number | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—";
}

function DraftOrderCard({
  draft,
  state,
  dest,
  onCheck,
  onSend,
  onConfirm,
  onReject,
  onDiscard
}: {
  draft: ChatDraft;
  state: DraftState;
  dest: { text: string; tone: "info" | "up" | "down"; live: boolean };
  onCheck: () => void;
  onSend: () => void;
  onConfirm: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onDiscard: () => void;
}) {
  if (state.phase === "discarded") {
    return <div className="mt-2 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-muted">Draft discarded.</div>;
  }
  const sideUp = draft.side.toUpperCase();
  const orderLine = `${sideUp} ${draft.qty} ${draft.symbol} · ${draft.order_type}${draft.order_type === "limit" && draft.limit_usd != null ? ` @ $${draft.limit_usd}` : ""}`;
  const blocked = state.decision && !state.decision.approved;
  // An escalatable refusal (ask-mode wash sale) is stageable: staging creates a pending-approval
  // card that carries the priced reason; the authoritative gate re-runs at confirm time.
  const escalatable = Boolean(blocked && state.decision?.escalatable);

  return (
    <div className="mt-2 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium text-fg">{orderLine}</span>
        <Chip tone={dest.tone}>{dest.text}</Chip>
      </div>
      {draft.rationale && <p className="mt-1 text-xs text-muted">{draft.rationale}</p>}

      {state.decision && (
        <div
          className={cn(
            "mt-2 rounded-md px-2.5 py-1.5 text-xs",
            escalatable ? "bg-warn/10 text-warn" : blocked ? "bg-down/10 text-down" : "bg-up/10 text-up"
          )}
        >
          <div className="flex items-center gap-1.5 font-medium">
            {blocked ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
            {escalatable ? "Needs your call" : blocked ? "Blocked by policy" : "Passes policy"}{" "}
            {state.estimatedNotional != null && <span className="text-muted">· est. {money(state.estimatedNotional)}</span>}
          </div>
          {blocked && state.decision.reasons.length > 0 && (
            <ul className={cn("mt-1 list-disc pl-4", escalatable ? "text-warn/90" : "text-down/90")}>
              {state.decision.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {escalatable && (
            <p className="mt-1 text-muted">
              Staging queues it for your approval with this cost on the card — nothing trades until you confirm.
            </p>
          )}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {(state.phase === "draft" || state.phase === "checking" || state.phase === "checked") && (
          <>
            <Button size="sm" variant="subtle" onClick={onCheck} disabled={state.phase === "checking"}>
              {state.phase === "checking" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Check policy
            </Button>
            {state.phase === "checked" && (!blocked || escalatable) && (
              <Button size="sm" onClick={onSend}>
                Stage for approval
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <X size={14} /> Discard
            </Button>
          </>
        )}

        {state.phase === "sending" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> staging…
          </span>
        )}

        {state.phase === "proposed" && state.proposalId && (
          <>
            <Button size="sm" variant={dest.live ? "danger" : "primary"} onClick={() => onConfirm(state.proposalId!)}>
              <Check size={14} /> {dest.live ? `Confirm — places a REAL order against ${draft.symbol}` : "Confirm & place"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReject(state.proposalId!)}>
              <X size={14} /> Reject
            </Button>
            <span className="text-[11px] text-muted">also in the Decision tab</span>
          </>
        )}

        {state.phase === "placing" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> placing…
          </span>
        )}

        {state.phase === "rejecting" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 size={14} className="animate-spin" /> rejecting…
          </span>
        )}

        {state.phase === "done" && (
          <span className="flex items-center gap-1.5 text-xs text-up">
            <Check size={14} /> Submitted via the approvals rail.
          </span>
        )}

        {state.phase === "rejected" && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <X size={14} /> Rejected.
          </span>
        )}
      </div>
    </div>
  );
}
