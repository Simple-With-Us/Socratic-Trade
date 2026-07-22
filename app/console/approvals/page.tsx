"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListFilter, ShieldAlert } from "lucide-react";
import type { PendingProposal } from "@/lib/types";
import { deriveStateInfo, activeConnectedAccount } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { bulkApproveProposals, LiveConfirmationRequiredError, rejectProposal, type ApproveResult } from "../lib/api";
import { fmtMoney } from "../lib/format";
import { fetchPendingLearnedContext } from "../lib/learned-context";
import { isSuccessfulApprovalResult } from "../lib/thesis";
import { ApprovalCard } from "../components/approval-card";
import { AlertCenter } from "../components/alert-center";
import { Card, Chip, Btn, Select, TextInput } from "../ui/primitives";
import { Sheet } from "../ui/sheet";
import { LearnedContextInbox, LearnedFactsArchive } from "./learned-context";
import {
  approvalEstimatedNotional,
  approvalIsLive,
  summarizeBulkSelection,
  summarizePendingProposals,
  triagePendingProposals,
  type ApprovalRealityFilter,
  type ApprovalSideFilter,
  type ApprovalSort
} from "./triage";
import { useToast } from "../ui/toast";
import { destinationLabel } from "../components/nav";

const SIDE_OPTIONS: Array<{ value: ApprovalSideFilter; label: string }> = [
  { value: "all", label: "All ideas" },
  { value: "openings", label: "Openings" },
  { value: "exits", label: "Exits" }
];

const REALITY_OPTIONS: Array<{ value: ApprovalRealityFilter; label: string }> = [
  { value: "all", label: "Paper + live" },
  { value: "paper", label: "Paper only" },
  { value: "live", label: "Live only" }
];

const SORT_OPTIONS: Array<{ value: ApprovalSort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "confidence", label: "Highest confidence" },
  { value: "notional", label: "Largest notional" },
  { value: "drift", label: "Largest drift" },
  { value: "oldest", label: "Oldest first" }
];

/** How long a "Reject N?" arm stays live before it silently disarms — a
 *  mis-click guard, not a ritual: no typed phrase, no modal, just a second
 *  deliberate click within a few seconds. */
const REJECT_ARM_MS = 4_000;
const BULK_APPROVE_MAX_REQUESTS = 20;

/** Pending learned-context count for the header's "+N learned" chip — the nav
 *  rail's badge folds trade proposals and learned-context items into one
 *  number, but this page only lists proposals, so the header needs its own
 *  read of the same queue to explain the difference. Same 60s/visibility
 *  polling cadence as the nav rail; kept local rather than shared because
 *  DesktopRail/MobileTabBar's hook isn't exported. */
function useLearnedPendingCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchPendingLearnedContext()
        .then((items) => {
          if (!cancelled) setCount(items.length);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      load();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return count;
}

export default function ApprovalsPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<ApprovalSideFilter>("all");
  const [reality, setReality] = useState<ApprovalRealityFilter>("all");
  const [sort, setSort] = useState<ApprovalSort>("newest");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<"approve" | "reject" | null>(null);
  const [liveApproveBatch, setLiveApproveBatch] = useState<PendingProposal[] | null>(null);
  // The reject-count this arm was raised for, or null when disarmed. If the
  // selection changes underneath an armed button (filter change, checkbox
  // toggle), rejectArmedEffective below falls false on its own — no effect
  // needed to keep it in sync, and no ref read during render.
  const [rejectArmedCount, setRejectArmedCount] = useState<number | null>(null);
  const rejectArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const learnedSectionRef = useRef<HTMLDivElement | null>(null);
  const learnedPendingCount = useLearnedPendingCount();
  const pending = useMemo(() => snapshot?.pendingProposals ?? [], [snapshot]);
  const pendingIdSet = useMemo(() => new Set(pending.map((proposal) => proposal.id)), [pending]);
  const effectiveSelectedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (pendingIdSet.has(id)) next.add(id);
    }
    return next;
  }, [selectedIds, pendingIdSet]);
  const filtered = useMemo(
    () => triagePendingProposals(pending, { query, side, reality, sort }),
    [pending, query, side, reality, sort]
  );
  const visibleIdSet = useMemo(() => new Set(filtered.map((proposal) => proposal.id)), [filtered]);
  const summary = useMemo(() => summarizePendingProposals(filtered), [filtered]);
  const selection = useMemo(() => summarizeBulkSelection(filtered, effectiveSelectedIds), [filtered, effectiveSelectedIds]);
  const bulkApproveOverLimit = selection.approveCount > BULK_APPROVE_MAX_REQUESTS;
  const state = snapshot ? deriveStateInfo(snapshot.policy) : null;
  const stopped = snapshot?.policy.systemState === "halted";
  const requiresTypedLiveApproval = snapshot?.policy.requireTypedConfirmation !== false;
  const activeAccountId = snapshot ? activeConnectedAccount(snapshot)?.id : undefined;
  const allVisibleSelected = filtered.length > 0 && filtered.every((proposal) => effectiveSelectedIds.has(proposal.id));
  // A stale arm must never fire against a different set of proposals than the
  // one the owner saw — falls false automatically the instant the selection
  // changes, no effect required to keep it in sync.
  const rejectArmedEffective = rejectArmedCount !== null && rejectArmedCount === selection.rejectCount;

  const clearRejectArm = () => {
    if (rejectArmTimer.current) {
      clearTimeout(rejectArmTimer.current);
      rejectArmTimer.current = null;
    }
    setRejectArmedCount(null);
  };

  // Only cleanup on unmount needed — see rejectArmedEffective above for how
  // selection changes disarm without an effect.
  useEffect(() => {
    return () => {
      if (rejectArmTimer.current) clearTimeout(rejectArmTimer.current);
    };
  }, []);

  const toggleSelected = (proposalId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  };

  const toggleVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const id of visibleIdSet) next.delete(id);
      } else {
        for (const id of visibleIdSet) next.add(id);
      }
      return next;
    });
  };

  const resetSelection = () => setSelectedIds(new Set());

  const finishApproval = (result: ApproveResult) => {
    if (isSuccessfulApprovalResult(result.status)) return "placed";
    if (result.status === "blocked") return "blocked";
    return "other";
  };

  const runBulkApproveBatch = async (selected: PendingProposal[], liveTypedText?: string) => {
    if (selected.length === 0) return;
    setBulkBusy("approve");
    let placed = 0;
    let blocked = 0;
    let failed = 0;
    const failureDetails: string[] = [];
    try {
      const symbolById = new Map(selected.map((proposal) => [proposal.id, proposal.proposal.symbol]));
      const response = await bulkApproveProposals(
        selected.map((proposal) => proposal.id),
        liveTypedText ? { typedText: liveTypedText } : undefined
      );
      for (const result of response.results) {
        const status = finishApproval(result);
        if (status === "placed") placed += 1;
        else if (status === "blocked") blocked += 1;
        else {
          failed += 1;
          const reasons = result.reasons?.filter(Boolean).join("; ");
          const symbol = result.symbol ?? symbolById.get(result.proposalId) ?? "proposal";
          failureDetails.push(`${symbol}: ${reasons || result.status || "approval did not place"}`);
        }
      }
      await refresh();
      resetSelection();
      const detailParts = [`${blocked} blocked on re-check`, failed > 0 ? `${failed} failed` : undefined].filter(Boolean);
      const detail = [...detailParts, ...failureDetails.slice(0, 3)].join(" · ");
      toast.push(
        failed > 0 ? "warn" : "pos",
        `Approved ${placed} proposal${placed === 1 ? "" : "s"}`,
        detail || undefined
      );
    } catch (error) {
      failed += selected.length;
      const reasons =
        error instanceof LiveConfirmationRequiredError
          ? error.reasons.join("; ")
          : error instanceof Error
            ? error.message
            : "request failed";
      toast.push("warn", "Approval batch failed", reasons || "No approvals were submitted.");
    } finally {
      setBulkBusy(null);
    }
  };

  const runBulkApprove = () => {
    const selected = filtered.filter((proposal) => effectiveSelectedIds.has(proposal.id));
    if (selected.length === 0) return;
    if (selected.length > BULK_APPROVE_MAX_REQUESTS) {
      toast.push("warn", "Too many approvals selected", `Select ${BULK_APPROVE_MAX_REQUESTS} or fewer proposals per batch to stay inside the order rate limit.`);
      return;
    }
    if (requiresTypedLiveApproval && selected.some(approvalIsLive)) {
      setLiveApproveBatch(selected);
      return;
    }
    void runBulkApproveBatch(selected);
  };

  const submitLiveApproveBatch = async (typedText: string) => {
    const selected = liveApproveBatch ?? [];
    setLiveApproveBatch(null);
    await runBulkApproveBatch(selected, typedText.trim().toUpperCase());
  };

  const closeLiveApproveBatch = useCallback(() => {
    setLiveApproveBatch(null);
  }, []);

  const runBulkReject = async () => {
    const selected = filtered.filter((proposal) => effectiveSelectedIds.has(proposal.id));
    if (selected.length === 0) return;
    setBulkBusy("reject");
    let rejected = 0;
    let failed = 0;
    try {
      for (const proposal of selected) {
        try {
          await rejectProposal(proposal.id);
          rejected += 1;
        } catch {
          failed += 1;
        }
      }
      await refresh();
      resetSelection();
      toast.push(
        failed > 0 ? "warn" : "info",
        `Rejected ${rejected} proposal${rejected === 1 ? "" : "s"}`,
        failed > 0 ? `${failed} failed` : "The ideas keep being scored after you pass."
      );
    } finally {
      setBulkBusy(null);
    }
  };

  // First click arms a "Reject N? Confirm" state for a few seconds; the
  // second click within that window actually rejects. Deliberately no typed
  // phrase and no modal — this is a mis-click guard, not a ritual.
  const handleBulkRejectClick = () => {
    if (!rejectArmedEffective) {
      setRejectArmedCount(selection.rejectCount);
      rejectArmTimer.current = setTimeout(() => setRejectArmedCount(null), REJECT_ARM_MS);
      return;
    }
    clearRejectArm();
    void runBulkReject();
  };

  const jumpToLearnedContext = () => {
    learnedSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (!snapshot || !state) return null;

  // Intentionally wider than CONSOLE_PAGE_WIDTH: this is a two-column layout (main
  // approvals column + a 360px-fixed aside, xl:grid-cols-[minmax(0,1fr)_360px]),
  // not a single reading column like the other console pages. Capping it to
  // CONSOLE_PAGE_WIDTH's 1024px would starve the main column to satisfy the
  // aside's fixed 360px. Same reasoning as the console home page and the
  // decision-trace ready state — see ./lib/page-width.ts and
  // docs/rollouts/2026-07-08-console-page-width-parity.md.
  return (
    <div className="mx-auto grid max-w-6xl gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[length:var(--con-fs-lg)] font-bold">
              {destinationLabel("/console/approvals")}
              {pending.length > 0 && (
                <>
                  {" "}
                  <span className="con-num text-[color:var(--con-accent)]">
                    ({filtered.length}/{pending.length})
                  </span>
                </>
              )}
            </h1>
            {learnedPendingCount > 0 && (
              <button
                type="button"
                className="con-chip con-chip-accent"
                onClick={jumpToLearnedContext}
                title={`${learnedPendingCount} learned-context item${learnedPendingCount === 1 ? "" : "s"} also awaiting your decision, below trade proposals — this count is why the nav badge reads higher than the number above. Click to jump there.`}
              >
                +{learnedPendingCount} learned
              </button>
            )}
          </div>
          <Chip tone={state.tone === "pos" ? "pos" : state.tone === "neg" ? "neg" : state.tone === "muted" ? "muted" : "warn"}>{state.label}</Chip>
        </div>

        {/* Triage apparatus (stat tiles, search, filters, bulk actions) only earns its
            space when there's a queue to triage — an empty queue leads with the
            empty-state card instead of four zero tiles and disabled controls. */}
        {pending.length > 0 && (
        <Card
          title={
            <span className="flex items-center gap-1.5">
              <ListFilter size={13} /> Triage
            </span>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Visible</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.count}</div>
              </div>
              <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Live</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.liveCount}</div>
              </div>
              <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Risk-reducing exits</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.exitCount}</div>
              </div>
              <div className="rounded-control border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Estimated notional</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{fmtMoney(summary.totalEstimatedNotional)}</div>
              </div>
            </div>

            <div className="grid gap-2 md:grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,0.9fr))]">
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search symbol, thesis, regime, rationale, or red-team note"
                aria-label="Search pending approvals"
              />
              <Select value={side} onChange={(event) => setSide(event.target.value as ApprovalSideFilter)} aria-label="Filter by side">
                {SIDE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Select value={reality} onChange={(event) => setReality(event.target.value as ApprovalRealityFilter)} aria-label="Filter by reality">
                {REALITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
              <Select value={sort} onChange={(event) => setSort(event.target.value as ApprovalSort)} aria-label="Sort pending approvals">
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleVisible}
                  className="h-4 w-4 rounded border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)]"
                />
                Select visible
              </label>
              <Chip tone="muted">{selection.selectedCount} selected</Chip>
              {selection.liveCount > 0 && (
                <Chip tone={requiresTypedLiveApproval ? "warn" : "live"}>
                  {selection.liveCount} live {requiresTypedLiveApproval ? "need typed confirm" : "one-click"}
                </Chip>
              )}
              {bulkApproveOverLimit && <Chip tone="warn">approve max {BULK_APPROVE_MAX_REQUESTS}</Chip>}
              <div className="ml-auto flex flex-wrap gap-2">
                <Btn
                  variant="pos"
                  size="sm"
                  disabled={stopped || bulkBusy !== null || selection.approveCount === 0 || bulkApproveOverLimit}
                  onClick={runBulkApprove}
                  title={
                    stopped
                      ? "The system is stopped, so approval actions are refused."
                      : bulkApproveOverLimit
                        ? `Select ${BULK_APPROVE_MAX_REQUESTS} or fewer proposals per batch to stay inside the order rate limit.`
                      : selection.liveCount > 0 && requiresTypedLiveApproval
                        ? "Approves selected proposals one by one through the existing server path after one batch live-confirm phrase."
                        : "Approves selected proposals one by one through the existing server path."
                  }
                >
                  {bulkBusy === "approve" ? "Approving..." : `Approve selected (${selection.approveCount})`}
                </Btn>
                <Btn
                  variant="dangerOutline"
                  size="sm"
                  disabled={stopped || bulkBusy !== null || selection.rejectCount === 0}
                  onClick={handleBulkRejectClick}
                  title={
                    stopped
                      ? "The system is stopped, so rejection actions are refused."
                      : rejectArmedEffective
                        ? "Click again to reject — rejects each selected proposal through the existing server path."
                        : "Rejects each selected proposal through the existing server path. Click once to arm, then again to confirm."
                  }
                >
                  {bulkBusy === "reject" ? "Rejecting..." : rejectArmedEffective ? `Reject ${selection.rejectCount}? Confirm` : `Reject selected (${selection.rejectCount})`}
                </Btn>
              </div>
            </div>
          </div>
        </Card>
        )}

        {stopped && (
          <Card>
            <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]">
              <strong>The system is stopped.</strong> The server refuses approving or rejecting proposals while stopped —
              start it (or switch to Close-only) from the Stopped button in the top bar first. Run once can still create
              proposals.
            </p>
          </Card>
        )}

        {filtered.length === 0 ? (
          <Card>
            <div className="py-8 text-center">
              {pending.length === 0 ? (
                <>
                  <p className="font-semibold">Nothing waiting for your judgment.</p>
                  <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                    When a run stages a trade that needs your approval, it shows up here.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold">No trade proposals match this triage view.</p>
                  <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                    Adjust the filters above or wait for the next run to stage new ideas.
                  </p>
                </>
              )}
            </div>
          </Card>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((proposal) => (
              <div key={proposal.id} className="flex gap-3">
                <label className="pt-4">
                  <input
                    type="checkbox"
                    checked={effectiveSelectedIds.has(proposal.id)}
                    onChange={() => toggleSelected(proposal.id)}
                    className="h-4 w-4 rounded border-[color:var(--con-line-strong)] bg-[color:var(--con-surface)]"
                    aria-label={`Select ${proposal.proposal.side} ${proposal.proposal.symbol}`}
                  />
                </label>
                <div className="min-w-0 flex-1">
                  <ApprovalCard pending={proposal} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={learnedSectionRef} className="flex scroll-mt-28 flex-col gap-4">
          <LearnedContextInbox />
          <LearnedFactsArchive />
        </div>

        <p className="text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Rejections are data, not failures — every idea you pass on keeps being scored, and Results shows how your
          judgment is doing.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {selection.liveCount > 0 && requiresTypedLiveApproval && (
          <Card>
            <div className="flex items-start gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[color:var(--con-warn)]" />
              <p>
                Bulk approve now supports LIVE proposals with one batch typed phrase. Each selected order still goes
                through the existing per-proposal server approval path and can block independently.
              </p>
            </div>
          </Card>
        )}
        <AlertCenter
          notifications={snapshot.notifications ?? []}
          connectedAccounts={snapshot.connectedAccounts}
          symbolMetaBySymbol={snapshot.symbolMetaBySymbol}
          activeAccountId={activeAccountId}
          maxItems={8}
        />
      </div>
      <BulkLiveApproveSheet
        open={liveApproveBatch !== null}
        proposals={liveApproveBatch ?? []}
        busy={bulkBusy === "approve"}
        onClose={closeLiveApproveBatch}
        onSubmit={(typedText) => void submitLiveApproveBatch(typedText)}
      />
    </div>
  );
}

function liveApprovalText(proposal: PendingProposal): string {
  return `APPROVE LIVE ${proposal.proposal.symbol.toUpperCase()}`;
}

function bulkLiveApprovalText(live: PendingProposal[]): string {
  if (live.length === 1 && live[0]) return liveApprovalText(live[0]);
  return `APPROVE ${live.length} LIVE ${live.length === 1 ? "ORDER" : "ORDERS"}`;
}

function BulkLiveApproveSheet({
  open,
  proposals,
  busy,
  onClose,
  onSubmit
}: {
  open: boolean;
  proposals: PendingProposal[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (typedText: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const live = useMemo(() => proposals.filter(approvalIsLive), [proposals]);
  const paperCount = proposals.length - live.length;
  const expectedText = bulkLiveApprovalText(live);
  const matches = typed.trim().toUpperCase() === expectedText;
  const liveNotional = live.reduce((sum, proposal) => sum + approvalEstimatedNotional(proposal), 0);

  const close = useCallback(() => {
    setTyped("");
    onClose();
  }, [onClose]);

  const submit = () => {
    const typedText = typed.trim().toUpperCase();
    setTyped("");
    onSubmit(typedText);
  };

  return (
    <Sheet open={open} onClose={close} title="Approve live batch" tone="live">
      <div className="mb-3 rounded-control border border-[color:var(--con-live-border)] bg-[color:var(--con-surface-2)] p-3 text-[length:var(--con-fs-sm)]">
        <div className="font-bold">
          {live.length} live order{live.length === 1 ? "" : "s"} selected
        </div>
        <p className="con-num mt-1">
          Estimated live notional <strong>{fmtMoney(liveNotional)}</strong>
          {paperCount > 0 ? ` · plus ${paperCount} paper proposal${paperCount === 1 ? "" : "s"}` : ""}
        </p>
        <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-muted)]">
          The server re-checks each proposal separately at approval time. If one row blocks or expires, the other rows keep
          their own result.
        </p>
      </div>

      <div className="mb-3 max-h-48 overflow-auto rounded-control border border-[color:var(--con-line)]">
        {live.map((proposal) => (
          <div key={proposal.id} className="flex items-center justify-between gap-3 border-b border-[color:var(--con-line)] px-3 py-2 last:border-b-0">
            <div>
              <div className="font-semibold">
                {proposal.proposal.side.toUpperCase()} {proposal.proposal.symbol}
              </div>
              <div className="text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
                {proposal.accountNumber ? `account ...${proposal.accountNumber.slice(-4)}` : "active live account"}
              </div>
            </div>
            <div className="con-num shrink-0 text-[length:var(--con-fs-sm)]">{fmtMoney(approvalEstimatedNotional(proposal))}</div>
          </div>
        ))}
      </div>

      <label className="con-label" htmlFor="bulk-live-typed-confirm">
        Type exactly: <span className="con-mono text-[color:var(--con-fg)]">{expectedText}</span>
      </label>
      <TextInput
        id="bulk-live-typed-confirm"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
        onPaste={(event) => event.preventDefault()}
        placeholder={expectedText}
        className="con-mono"
      />
      <p className="mt-1 text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
        This is one batch confirmation. The app still submits every proposal through the existing approval endpoint.
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={close} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="primary" disabled={!matches || busy || live.length === 0} onClick={submit}>
          {busy ? "Approving..." : "Approve live batch"}
        </Btn>
      </div>
    </Sheet>
  );
}
