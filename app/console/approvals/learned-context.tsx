"use client";

/** Learned-context approval inbox: the queue of things the AI inferred it
 *  wants to remember (risk observations / strategy directives from autonomous
 *  runs or document ingestion) awaiting the owner's explicit approve/reject.
 *  A queued item is NOT in the brain — nothing influences the AI until it is
 *  approved here, and an approval NEVER changes numeric risk limits. Honesty
 *  note: an approved 'risk' observation is recorded durably (advisory row) but
 *  is NOT yet retrieved into runs — listLearnedContextForDecision only reads
 *  fact-tier rows — so the copy says "recorded", never "the AI reads it".
 *
 *  Console rules honored: asymmetric friction (reject is one tap; approve —
 *  which adds standing influence — shows exactly what will be applied first),
 *  optimistic UI with toast + reconciliation on failure, honest provenance on
 *  every card, non-blocking error notices, light/dark via --con-* tokens. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, RefreshCw } from "lucide-react";
import {
  approvePendingLearnedContext,
  directiveBlockPreview,
  fetchPendingLearnedContext,
  rejectPendingLearnedContext,
  type PendingLearnedItem
} from "../lib/learned-context";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";

const POLL_MS = 60_000;

const ORIGIN_LABEL: Record<PendingLearnedItem["origin"], string> = {
  autonomous: "autonomous run",
  ingest: "document ingestion",
  chat: "chat" // defensive: chat-origin risk items are hard-capped server-side and never queued
};

function tierMeta(tier: PendingLearnedItem["riskTier"]): { label: string; tone: "warn" | "accent"; explain: string } {
  return tier === "risk"
    ? {
        label: "Risk observation",
        tone: "warn",
        explain:
          "A risk-related takeaway. Approving records it durably in the learned-context store; it is not yet fed back into runs, and it never changes your numeric risk limits."
      }
    : {
        label: "Strategy directive",
        tone: "accent",
        explain:
          "A standing instruction. Approving appends an attributed block to your strategy prompt; your existing prompt is preserved."
      };
}

// ── Provenance line ──────────────────────────────────────────────────────────

function Provenance({ item }: { item: PendingLearnedItem }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
      <span title="Which part of the system produced this candidate.">
        From <span className="text-[color:var(--con-muted)]">{ORIGIN_LABEL[item.origin] ?? item.origin}</span>
      </span>
      <span title="What the producer cited as the basis for this item.">
        Source <span className="text-[color:var(--con-muted)]">{item.source}</span>
      </span>
      <span title="The type of learned item: a pattern, a decision, or a fact.">
        Kind <span className="text-[color:var(--con-muted)]">{item.kind}</span>
      </span>
      {item.classifierReason && (
        <span title="Why the fail-closed classifier routed this to your confirmation queue instead of storing it automatically.">
          Why it queued <span className="text-[color:var(--con-muted)]">{item.classifierReason}</span>
        </span>
      )}
    </div>
  );
}

// ── What approval actually does (honest, tier-specific) ─────────────────────

function ApprovalEffect({ item, withPreview }: { item: PendingLearnedItem; withPreview: boolean }) {
  if (item.riskTier === "strategy-directive") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
          Approving appends this attributed block to your strategy prompt — additive only; your existing prompt is
          preserved, and re-approving replaces the same block instead of duplicating it. The date is stamped at
          approval time.
        </p>
        {withPreview && (
          <pre
            title="The exact block approval appends to your strategy prompt. The date is stamped at approval time."
            className="con-mono overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3 text-[11px] leading-relaxed text-[color:var(--con-muted)]"
          >
            {directiveBlockPreview(item)}
          </pre>
        )}
      </div>
    );
  }
  return (
    <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
      Approving records this observation durably in the learned-context store — kept and auditable, but{" "}
      <strong className="font-semibold text-[color:var(--con-muted)]">not yet fed back into runs</strong> (today only
      fact-tier items and approved strategy directives reach the AI). It also{" "}
      <strong className="font-semibold text-[color:var(--con-muted)]">never</strong> changes your numeric risk limits —
      those only move when you edit them yourself in Guardrails.
    </p>
  );
}

// ── Single item card ─────────────────────────────────────────────────────────

function LearnedItemCard({
  item,
  busy,
  onApprove,
  onReject
}: {
  item: PendingLearnedItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const tier = tierMeta(item.riskTier);
  return (
    <article className="con-card overflow-hidden transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--con-line)] px-4 py-3">
        <Chip tone={tier.tone} title={tier.explain}>
          <Brain size={11} /> {tier.label}
        </Chip>
        <span
          className="min-w-0 break-words text-[length:var(--con-fs-sm)] font-semibold"
          title="What this learned item is about."
        >
          {item.subject}
        </span>
        {item.symbol && (
          <span className="con-mono text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]" title="The ticker this item is about.">
            <SymbolButton symbol={item.symbol} showLogo={false} />
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Ago iso={item.createdAt} />
        </span>
      </header>

      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[length:var(--con-fs-sm)] leading-relaxed" title="The learned statement, verbatim.">
          {item.value}
        </p>
        <ApprovalEffect item={item} withPreview={false} />
        <Provenance item={item} />
      </div>

      <footer className="flex items-center gap-2 border-t border-[color:var(--con-line)] px-4 py-3">
        <Btn
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={onApprove}
          title="Opens a confirmation showing exactly what approving applies — nothing commits yet."
        >
          Approve…
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onReject}
          title="Discard this candidate immediately. Nothing is applied anywhere."
        >
          Reject
        </Btn>
        <span
          className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]"
          title="A queued item sits outside the AI's memory. It only takes effect if you approve it."
        >
          Not applied until you approve
        </span>
      </footer>
    </article>
  );
}

// ── The inbox ────────────────────────────────────────────────────────────────

export function LearnedContextInbox() {
  const { refresh } = useConsoleData();
  const toast = useToast();
  const [items, setItems] = useState<PendingLearnedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingLearnedItem | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  /** IDs this session has confirmed approved/rejected. A load that started
   *  BEFORE an action can resolve AFTER it — filtering these out stops a stale
   *  response from resurrecting an already-resolved card. */
  const resolvedIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await fetchPendingLearnedContext(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setItems(data.filter((i) => !resolvedIds.current.has(i.id)));
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      // Non-blocking: keep the last good list rendered; surface a notice instead.
      setError(err instanceof Error ? err.message : "Could not load the learned-context queue.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      inFlight.current?.abort();
    };
  }, [load]);

  const reject = async (item: PendingLearnedItem) => {
    setBusyId(item.id);
    inFlight.current?.abort(); // a load already in flight predates this action — never let it apply
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev)); // optimistic
    try {
      await rejectPendingLearnedContext(item.id);
      resolvedIds.current.add(item.id); // confirmed resolved — stale loads must not resurrect it
      toast.push("info", `Rejected "${item.subject}"`, "Discarded. Nothing was applied anywhere.");
      void load(); // converge with the server's truth
    } catch (err) {
      toast.push("neg", "Rejection failed", err instanceof Error ? err.message : String(err));
      void load(); // reconcile with the server's truth (restores the card if it is still pending)
    } finally {
      setBusyId(null);
    }
  };

  const approve = async (item: PendingLearnedItem) => {
    setConfirming(null);
    setBusyId(item.id);
    inFlight.current?.abort(); // a load already in flight predates this action — never let it apply
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev)); // optimistic
    try {
      await approvePendingLearnedContext(item.id);
      resolvedIds.current.add(item.id); // confirmed resolved — stale loads must not resurrect it
      toast.push(
        "pos",
        `Approved "${item.subject}"`,
        item.riskTier === "strategy-directive"
          ? "The attributed block was appended to your strategy prompt."
          : "Recorded in the learned-context store. It is not yet fed into runs, and your numeric risk limits are unchanged."
      );
      void load(); // converge with the server's truth
      // A directive approval edits the strategy prompt, which lives in the shared
      // console snapshot — refresh it so Strategy shows the new prompt immediately.
      if (item.riskTier === "strategy-directive") void refresh();
    } catch (err) {
      toast.push("neg", "Approval failed", err instanceof Error ? err.message : String(err));
      void load();
    } finally {
      setBusyId(null);
    }
  };

  const count = items?.length ?? 0;

  return (
    <section className="mt-2 flex flex-col gap-3" aria-label="Learned context awaiting review">
      <div className="flex items-center justify-between gap-3">
        <h2
          className="flex items-center gap-2 text-[length:var(--con-fs-md)] font-bold"
          title="Things the system inferred it wants to remember — risk observations and strategy directives. They wait here until you approve or reject each one; nothing influences the AI until you approve it."
        >
          <Brain size={16} aria-hidden />
          Learned context{" "}
          {count > 0 && (
            <span
              className="con-num text-[color:var(--con-accent)]"
              title={`${count} learned item${count === 1 ? "" : "s"} awaiting your decision.`}
            >
              ({count})
            </span>
          )}
        </h2>
        <button
          type="button"
          className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] transition-colors hover:text-[color:var(--con-fg)]"
          onClick={() => void load()}
          aria-label="Refresh learned-context queue"
          title="Re-check the server for pending learned context now (it also refreshes automatically)."
        >
          <RefreshCw size={12} aria-hidden /> Refresh
        </button>
      </div>

      {error && (
        <Card>
          <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]">
            <strong>Couldn&apos;t refresh this queue.</strong> {error}{" "}
            {items && items.length > 0 ? "The list below may be stale." : ""}
          </p>
        </Card>
      )}

      {items === null && !error && (
        <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Checking for pending learned context…</p>
      )}

      {items !== null && items.length === 0 && !error && (
        <Card>
          <div className="py-6 text-center">
            <p className="font-semibold">Nothing learned is waiting on you.</p>
            <p className="mx-auto mt-1 max-w-md text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              When an autonomous run or an ingested document makes the system infer something it wants to remember — a
              risk observation or a strategy directive — it queues here first. You decide what sticks: nothing
              influences the AI until you approve it, and approvals never touch your numeric risk limits.
            </p>
          </div>
        </Card>
      )}

      {items?.map((item) => (
        <LearnedItemCard
          key={item.id}
          item={item}
          busy={busyId === item.id}
          onApprove={() => setConfirming(item)}
          onReject={() => void reject(item)}
        />
      ))}

      {/* Approve confirmation: approval adds standing influence, so it shows
          exactly what will be applied before committing (reject stays one tap). */}
      <Sheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming ? `Approve ${tierMeta(confirming.riskTier).label.toLowerCase()}?` : undefined}
      >
        {confirming && (
          <div className="flex flex-col gap-3">
            <p className="text-[length:var(--con-fs-sm)] leading-relaxed" title="What this learned item is about.">
              <span className="font-semibold">{confirming.subject}</span>
              {confirming.symbol ? (
                <span className="con-mono text-[color:var(--con-muted)]" title="The ticker this item is about.">
                  {" "}
                  · <SymbolButton symbol={confirming.symbol} showLogo={false} />
                </span>
              ) : null}
            </p>
            <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]" title="The learned statement, verbatim.">
              {confirming.value}
            </p>
            <ApprovalEffect item={confirming} withPreview />
            <Provenance item={confirming} />
            <div className="mt-1 flex items-center justify-end gap-2">
              <Btn variant="ghost" onClick={() => setConfirming(null)} title="Close without applying anything. The item stays in the queue.">
                Cancel
              </Btn>
              <Btn
                variant="primary"
                disabled={busyId === confirming.id}
                onClick={() => void approve(confirming)}
                title={
                  confirming.riskTier === "strategy-directive"
                    ? "Append the block above to your strategy prompt now."
                    : "Record this observation durably now. It is not yet fed into runs; numeric risk limits are unchanged."
                }
              >
                Approve
              </Btn>
            </div>
          </div>
        )}
      </Sheet>
    </section>
  );
}
