"use client";

/** Learned-context approval inbox: the queue of things the AI inferred it
 *  wants to remember (risk observations / strategy directives from autonomous
 *  runs or document ingestion) awaiting the owner's explicit approve/reject.
 *  A queued item is NOT in the brain — nothing influences the AI until it is
 *  approved here, and an approval NEVER changes numeric risk limits. Honesty
 *  note: an approved 'risk' observation is recorded durably (advisory row) but
 *  is NOT yet retrieved into runs — listLearnedContextForDecision only reads
 *  fact-tier rows — so the copy says "recorded", never "the AI reads it".
 *  (The daily Learning Review can also approve queued items in "decide" mode;
 *  the stored row does not record whether a human or the review approved it.)
 *
 *  Console rules honored: asymmetric friction (reject is one tap; approve —
 *  which adds standing influence — shows exactly what will be applied first),
 *  optimistic UI with toast + reconciliation on failure, honest provenance on
 *  every card, non-blocking error notices, light/dark via --con-* tokens. */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Brain, ChevronDown, ChevronRight, RefreshCw, Settings } from "lucide-react";
import {
  approvePendingLearnedContext,
  deleteLearnedContextItem,
  directiveBlockPreview,
  fetchLearnedContext,
  fetchPendingLearnedContext,
  rejectPendingLearnedContext,
  type PendingLearnedItem
} from "../lib/learned-context";
import { isOwnerAuthoredLearnedSource } from "@/lib/learned-context/directive-block";
import type { LearnedContextRow } from "@/lib/types";
import { useConsoleData } from "../lib/useConsoleData";
import { useToast } from "../ui/toast";
import { Ago, Btn, Card, Chip, Tooltip } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { SymbolButton } from "../ui/symbol-drilldown";

const POLL_MS = 60_000;

/** Small header link from each Learning Review block to the Learning Review model-selection card
 *  in Settings (its #learning-review anchor, ALL YOUR ACCOUNTS section). */
function LearningReviewModelSettingsLink() {
  return (
    <Tooltip content="Configure the daily Learning Review — the model that audits these learned items — in Settings.">
      <Link
        href="/console/settings#learning-review"
        className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] transition-colors hover:text-[color:var(--con-fg)]"
      >
        <Settings size={12} aria-hidden /> Model settings
      </Link>
    </Tooltip>
  );
}

const ORIGIN_LABEL: Record<PendingLearnedItem["origin"], string> = {
  autonomous: "autonomous run",
  ingest: "document ingestion",
  chat: "chat" // defensive: chat-origin risk items are hard-capped server-side and never queued
};

function sourceLabel(value?: string): string {
  if (!value) return "-";
  const map: Record<string, string> = {
    "market_scan": "Market scan",
    "candidate": "Candidate",
    "rag": "Retrieved evidence",
    "red_team": "Red team",
    "policy": "Policy gate",
    "outcome": "Outcome",
    "learning": "Learning",
    "coaching": "Coaching",
    "framework": "Framework",
    "override": "Owner override",
    "safety": "Safety",
    "owner-chat": "Owner chat",
    "experience-memory": "Experience memory",
    "document-ingest": "Document ingest",
    "autonomous-run": "Autonomous run"
  };
  return map[value] ?? value.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function kindLabel(value?: string): string {
  if (!value) return "-";
  const map: Record<string, string> = {
    "pattern": "Pattern",
    "decision": "Decision",
    "fact": "Fact"
  };
  return map[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
}

function capitalizeFirstLetter(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function tierMeta(tier: PendingLearnedItem["riskTier"]): { label: string; tone: "warn" | "accent"; explain: string } {
  return tier === "risk"
    ? {
        label: "Risk observation",
        tone: "warn",
        explain:
          "A risk-related takeaway.  Approving records it durably in the learned-context store; it is not yet fed back into runs, and it never changes your numeric risk limits."
      }
    : {
        label: "Strategy directive",
        tone: "accent",
        explain:
          "A standing instruction.  Approving appends an attributed block to your strategy prompt; your existing prompt is preserved."
      };
}

// ── Provenance line ──────────────────────────────────────────────────────────

function Provenance({ item }: { item: PendingLearnedItem }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
      <Tooltip content="Which part of the system produced this candidate.">
        <span>
          From <span className="text-[color:var(--con-muted)]">{ORIGIN_LABEL[item.origin] ?? item.origin}</span>
        </span>
      </Tooltip>
      <Tooltip content="What the producer cited as the basis for this item.">
        <span>
          Source <span className="text-[color:var(--con-muted)]">{sourceLabel(item.source)}</span>
        </span>
      </Tooltip>
      <Tooltip content="The type of learned item: a pattern, a decision, or a fact.">
        <span>
          Kind <span className="text-[color:var(--con-muted)]">{kindLabel(item.kind)}</span>
        </span>
      </Tooltip>
      {item.classifierReason && (
        <Tooltip
          content="Why the fail-closed classifier routed this to your confirmation queue instead of storing it automatically.">
          <span>Queued because <span className="text-[color:var(--con-muted)]">{capitalizeFirstLetter(item.classifierReason.trim())}</span>
          </span>
        </Tooltip>
      )}
    </div>
  );
}

// ── Learning Review "left for you" note (defer verdict) ─────────────────────

/** Shown only when the daily Learning Review LLM reviewed this item and could not confidently
 *  decide it — it left the item pending and explained why. Distinct from Provenance's
 *  classifierReason: that's why INGEST queued it here; this is why the REVIEWER, having looked,
 *  still left it for a human. */
function ReviewerNote({ item }: { item: PendingLearnedItem }) {
  if (!item.reviewNote) return null;
  return (
    <Tooltip content="The daily Learning Review model looked at this item and could not confidently decide, so it left the item here for you and explained why.">
      <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
        Left for you because{" "}
        <span className="text-[color:var(--con-muted)]">{item.reviewNote}</span>
      </p>
    </Tooltip>
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
        {!isOwnerAuthoredLearnedSource(item.source) && (
          <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
            You did not write this text yourself, so the block records where it came from, and any span that reads as an
            instruction to the AI is replaced with a QUARANTINED_INSTRUCTION_LIKE_DATA marker before it lands.  Your own
            directives are never altered.
          </p>
        )}
        {withPreview && (
          <pre
            title="The exact block approval appends to your strategy prompt.  The date is stamped at approval time."
            className="con-mono overflow-x-auto whitespace-pre-wrap break-words rounded-[var(--con-radius-sm)] border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-xs)] leading-relaxed text-[color:var(--con-muted)]"
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
        <Tooltip content="What this learned item is about.">
          <span
            className="min-w-0 break-words text-[length:var(--con-fs-sm)] font-semibold">
            {item.subject}
          </span>
        </Tooltip>
        {item.symbol && (
          <Tooltip content="The ticker this item is about.">
            <span
              className="con-mono text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              <SymbolButton symbol={item.symbol} />
            </span>
          </Tooltip>
        )}
        <div className="flex-1" />
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Ago iso={item.createdAt} />
        </span>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        <Tooltip content="The learned statement, verbatim.">
          <p className="text-[length:var(--con-fs-sm)] leading-relaxed">
            {item.value}
          </p>
        </Tooltip>
        <ApprovalEffect item={item} withPreview={false} />
        <Provenance item={item} />
        <ReviewerNote item={item} />
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
          title="Discard this candidate immediately.  Nothing is applied anywhere."
        >
          Reject
        </Btn>
        <Tooltip
          content="A queued item sits outside the AI's memory.  It only takes effect if you approve it.">
          <span
            className="ml-auto text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
            Not applied until you approve
          </span>
        </Tooltip>
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
      toast.push("info", `Rejected "${item.subject}"`, "Discarded.  Nothing was applied anywhere.");
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
          : "Recorded in the learned-context store.  It is not yet fed into runs, and your numeric risk limits are unchanged."
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
        <Tooltip
          content="Things the system inferred it wants to remember — risk observations and strategy directives.  They wait here until you approve or reject each one; nothing influences the AI until you approve it.">
          <h2
            className="flex items-center gap-2 text-[length:var(--con-fs-md)] font-bold">
            <Brain size={16} aria-hidden />
            Learned context{" "}
            {count > 0 && (
              <Tooltip
                content={`${count} learned item${count === 1 ? "" : "s"} awaiting your decision.`}>
                <span className="con-num text-[color:var(--con-accent)]">({count})</span>
              </Tooltip>
            )}
          </h2>
        </Tooltip>
        <div className="flex items-center gap-3">
          <LearningReviewModelSettingsLink />
          <Tooltip
            content="Re-check the server for pending learned context now (it also refreshes automatically).">
            <button
              type="button"
              className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] transition-colors hover:text-[color:var(--con-fg)]"
              onClick={() => void load()}
              aria-label="Refresh learned-context queue">
              <RefreshCw size={12} aria-hidden /> Refresh
            </button>
          </Tooltip>
        </div>
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
            <p className="font-semibold">Nothing's waiting for your review.</p>
            <p className="mx-auto mt-1 max-w-md text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              When an autonomous run or an ingested document makes the system infer something about risk or
              strategy — a position-size change, a new stop/take-profit rule, an autonomy-level shift — it queues
              here first. You decide what sticks: nothing takes effect until you approve it, and approving never
              changes a numeric risk limit directly (that still only happens when you edit it yourself in
              Guardrails). Most of what the AI learns — plain facts and patterns — never needs your approval at all;
              see everything it's recorded so far below.
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
            <Tooltip content="What this learned item is about.">
              <p className="text-[length:var(--con-fs-sm)] leading-relaxed">
                <span className="font-semibold">{confirming.subject}</span>
                {confirming.symbol ? (
                  <Tooltip content="The ticker this item is about.">
                    <span className="con-mono text-[color:var(--con-muted)]">
                      {" "}· <SymbolButton symbol={confirming.symbol} />
                    </span>
                  </Tooltip>
                ) : null}
              </p>
            </Tooltip>
            <Tooltip content="The learned statement, verbatim.">
              <p
                className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
                {confirming.value}
              </p>
            </Tooltip>
            <ApprovalEffect item={confirming} withPreview />
            <Provenance item={confirming} />
            <div className="mt-1 flex items-center justify-end gap-2">
              <Btn variant="ghost" onClick={() => setConfirming(null)} title="Close without applying anything.  The item stays in the queue.">
                Cancel
              </Btn>
              <Btn
                variant="primary"
                disabled={busyId === confirming.id}
                onClick={() => void approve(confirming)}
                title={
                  confirming.riskTier === "strategy-directive"
                    ? "Append the block above to your strategy prompt now."
                    : "Record this observation durably now.  It is not yet fed into runs; numeric risk limits are unchanged."
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

// ── The learned-facts archive (browse + delete what's actually been recorded) ──
//
// This is the OTHER side of learning: most of what the AI records — plain facts and patterns —
// never touches the queue above at all (silent passthrough, see classify.ts). This section is
// where that silent majority becomes visible and erasable, alongside anything approved above.
// Read + delete only; nothing here is applied by viewing it, and deleting is immediate/permanent.

const ARCHIVE_POLL_MS = 120_000;

function factTierChipTone(tier: LearnedContextRow["riskTier"]): "accent" | "warn" {
  return tier === "fact" ? "accent" : "warn";
}

function factTierChipLabel(tier: LearnedContextRow["riskTier"]): string {
  if (tier === "risk") return "Risk observation";
  if (tier === "strategy-directive") return "Strategy directive";
  return "Fact";
}

function LearnedFactCard({
  item,
  busy,
  onDelete
}: {
  item: LearnedContextRow;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <article className="con-card overflow-hidden transition-colors hover:bg-[color:var(--con-surface-2)] focus-within:bg-[color:var(--con-surface-2)]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color:var(--con-line)] px-4 py-3">
        <Chip tone={factTierChipTone(item.riskTier)} title="How this row was classified when it was recorded.">
          <Brain size={11} /> {factTierChipLabel(item.riskTier)}
        </Chip>
        <Tooltip content="What this row is about.">
          <span
            className="min-w-0 break-words text-[length:var(--con-fs-sm)] font-semibold">
            {item.subject}
          </span>
        </Tooltip>
        {item.symbol && (
          <Tooltip content="The ticker this row is about.">
            <span
              className="con-mono text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
              <SymbolButton symbol={item.symbol} />
            </span>
          </Tooltip>
        )}
        {item.scope === "shared" && (
          <Chip tone="muted" title="Contributed to the shared pool other opted-in users can read.  Deleting it removes it for them too.">
            Shared
          </Chip>
        )}
        <div className="flex-1" />
        <span className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Ago iso={item.assertedAt} />
        </span>
      </header>
      <div className="flex flex-col gap-2 px-4 py-3">
        <Tooltip content="The learned statement, verbatim.">
          <p className="text-[length:var(--con-fs-sm)] leading-relaxed">
            {item.value}
          </p>
        </Tooltip>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          <Tooltip content="Which part of the system produced this row.">
            <span>
              From <span className="text-[color:var(--con-muted)]">{ORIGIN_LABEL[item.origin] ?? item.origin}</span>
            </span>
          </Tooltip>
          <Tooltip content="What the producer cited as the basis for this row.">
            <span>
              Source <span className="text-[color:var(--con-muted)]">{sourceLabel(item.source)}</span>
            </span>
          </Tooltip>
          <Tooltip content="The type of learned row: a pattern, a decision, or a fact.">
            <span>
              Kind <span className="text-[color:var(--con-muted)]">{kindLabel(item.kind)}</span>
            </span>
          </Tooltip>
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t border-[color:var(--con-line)] px-4 py-3">
        <Btn
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onDelete}
          title="Erase this row.  The AI stops seeing it immediately; if it was shared, other users lose it too."
        >
          Delete
        </Btn>
      </footer>
    </article>
  );
}

export function LearnedFactsArchive() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LearnedContextRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<LearnedContextRow | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  /** IDs this session has confirmed deleted. A load that started BEFORE a delete can resolve AFTER
   *  it — filtering these out stops a stale response from resurrecting an already-deleted card. */
  const resolvedIds = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const data = await fetchLearnedContext(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setItems(data.filter((i) => !resolvedIds.current.has(i.id)));
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Could not load learned context.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  // Only fetch/poll while the archive is expanded — it's secondary to the approval queue above,
  // so there's no reason to pay the request cost while it's collapsed.
  useEffect(() => {
    if (!open) return;
    void load();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, ARCHIVE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [open, load]);

  const doDelete = async (item: LearnedContextRow) => {
    setConfirmingDelete(null);
    setBusyId(item.id);
    inFlight.current?.abort(); // a load already in flight predates this action — never let it resurrect the row
    setItems((prev) => (prev ? prev.filter((i) => i.id !== item.id) : prev)); // optimistic
    try {
      await deleteLearnedContextItem(item.id);
      resolvedIds.current.add(item.id); // confirmed deleted — stale loads must not resurrect it
      toast.push("info", `Deleted "${item.subject}"`, "Removed.  The AI no longer sees this row.");
    } catch (err) {
      toast.push("neg", "Delete failed", err instanceof Error ? err.message : String(err));
      void load(); // reconcile with the server's truth (restores the card if the delete didn't land)
    } finally {
      setBusyId(null);
    }
  };

  const count = items?.length ?? 0;

  return (
    <section className="mt-2 flex flex-col gap-3" aria-label="Learned context recorded so far">
      <Tooltip
        content="Everything the AI has actually recorded — silent facts it never needed to ask about, plus anything you approved above.  Read and delete only; nothing here gets re-applied by viewing it.">
        <button
          type="button"
          className="flex items-center gap-2 text-[length:var(--con-fs-md)] font-bold"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}>
          {open ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
          What the AI has learned so far
          {open && count > 0 && <span className="con-num text-[color:var(--con-accent)]">({count})</span>}
        </button>
      </Tooltip>
      {open && (
        <>
          <div className="flex items-center justify-end gap-3">
            <LearningReviewModelSettingsLink />
            <Tooltip
              content="Re-check the server for recorded learned context now (it also refreshes automatically while open).">
              <button
                type="button"
                className="flex items-center gap-1.5 text-[length:var(--con-fs-xs)] font-semibold text-[color:var(--con-faint)] transition-colors hover:text-[color:var(--con-fg)]"
                onClick={() => void load()}
                aria-label="Refresh learned-context archive">
                <RefreshCw size={12} aria-hidden /> Refresh
              </button>
            </Tooltip>
          </div>

          {error && (
            <Card>
              <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]">
                <strong>Couldn&apos;t refresh this list.</strong> {error}{" "}
                {items && items.length > 0 ? "The list below may be stale." : ""}
              </p>
            </Card>
          )}

          {items === null && !error && (
            <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-faint)]">Loading learned context…</p>
          )}

          {items !== null && items.length === 0 && !error && (
            <Card>
              <p className="py-4 text-center text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                Nothing recorded yet. As the AI infers facts, patterns, or you approve items above, they&apos;ll show
                up here.
              </p>
            </Card>
          )}

          {items?.map((item) => (
            <LearnedFactCard key={item.id} item={item} busy={busyId === item.id} onDelete={() => setConfirmingDelete(item)} />
          ))}

          {/* Delete is permanent, unlike reject above (which discards a candidate that was never
              applied) — so it gets the same confirm-before-commit treatment as approve. */}
          <Sheet
            open={confirmingDelete !== null}
            onClose={() => setConfirmingDelete(null)}
            title={confirmingDelete ? "Delete this learned row?" : undefined}
          >
            {confirmingDelete && (
              <div className="flex flex-col gap-3">
                <p className="text-[length:var(--con-fs-sm)] leading-relaxed">
                  <span className="font-semibold">{confirmingDelete.subject}</span>
                  {confirmingDelete.symbol ? (
                    <span className="con-mono text-[color:var(--con-muted)]">
                      {" "}
                      · <SymbolButton symbol={confirmingDelete.symbol} />
                    </span>
                  ) : null}
                </p>
                <p className="text-[length:var(--con-fs-sm)] leading-relaxed text-[color:var(--con-muted)]">
                  {confirmingDelete.value}
                </p>
                <p className="text-[length:var(--con-fs-xs)] leading-snug text-[color:var(--con-faint)]">
                  This is permanent. The AI stops seeing this row immediately
                  {confirmingDelete.scope === "shared"
                    ? " — including other users who read it from the shared pool."
                    : "."}
                </p>
                <div className="mt-1 flex items-center justify-end gap-2">
                  <Btn variant="ghost" onClick={() => setConfirmingDelete(null)} title="Close without deleting anything.">
                    Cancel
                  </Btn>
                  <Btn
                    variant="primary"
                    disabled={busyId === confirmingDelete.id}
                    onClick={() => void doDelete(confirmingDelete)}
                    title="Erase this row now.  This cannot be undone."
                  >
                    Delete
                  </Btn>
                </div>
              </div>
            )}
          </Sheet>
        </>
      )}
    </section>
  );
}
