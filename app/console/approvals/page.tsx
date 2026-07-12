"use client";

import { useMemo, useState } from "react";
import { ListFilter, ShieldAlert } from "lucide-react";
import { deriveStateInfo, activeConnectedAccount } from "../lib/derive";
import { useConsoleData } from "../lib/useConsoleData";
import { approveProposal, rejectProposal, type ApproveResult } from "../lib/api";
import { fmtMoney } from "../lib/format";
import { ApprovalCard } from "../components/approval-card";
import { AlertCenter } from "../components/alert-center";
import { Card, Chip, Btn, Select, TextInput } from "../ui/primitives";
import { LearnedContextInbox } from "./learned-context";
import {
  approvalIsLive,
  summarizeBulkSelection,
  summarizePendingProposals,
  triagePendingProposals,
  type ApprovalRealityFilter,
  type ApprovalSideFilter,
  type ApprovalSort
} from "./triage";
import { useToast } from "../ui/toast";

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

export default function ApprovalsPage() {
  const { snapshot, refresh } = useConsoleData();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<ApprovalSideFilter>("all");
  const [reality, setReality] = useState<ApprovalRealityFilter>("all");
  const [sort, setSort] = useState<ApprovalSort>("newest");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<"approve" | "reject" | null>(null);
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
  const state = snapshot ? deriveStateInfo(snapshot.policy) : null;
  const stopped = snapshot?.policy.systemState === "halted";
  const activeAccountId = snapshot ? activeConnectedAccount(snapshot)?.id : undefined;
  const allVisibleSelected = filtered.length > 0 && filtered.every((proposal) => effectiveSelectedIds.has(proposal.id));

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
    if (result.status === "placed") return "placed";
    if (result.status === "blocked") return "blocked";
    return "other";
  };

  const runBulkApprove = async () => {
    const selected = filtered.filter((proposal) => effectiveSelectedIds.has(proposal.id) && !approvalIsLive(proposal));
    if (selected.length === 0) return;
    setBulkBusy("approve");
    let placed = 0;
    let blocked = 0;
    let failed = 0;
    try {
      for (const proposal of selected) {
        try {
          const result = await approveProposal(proposal.id);
          const status = finishApproval(result);
          if (status === "placed") placed += 1;
          else if (status === "blocked") blocked += 1;
        } catch {
          failed += 1;
        }
      }
      await refresh();
      resetSelection();
      toast.push(
        failed > 0 ? "warn" : "pos",
        `Approved ${placed} safe proposal${placed === 1 ? "" : "s"}`,
        [`${blocked} blocked on re-check`, failed > 0 ? `${failed} failed` : undefined].filter(Boolean).join(" · ") || undefined
      );
    } finally {
      setBulkBusy(null);
    }
  };

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

  if (!snapshot || !state) return null;

  return (
    <div className="mx-auto grid max-w-6xl gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-[length:var(--con-fs-lg)] font-bold">
            Approvals{" "}
            <span className="con-num text-[color:var(--con-accent)]">
              ({filtered.length}/{pending.length})
            </span>
          </h1>
          <Chip tone={state.tone === "pos" ? "pos" : state.tone === "neg" ? "neg" : "warn"}>{state.label}</Chip>
        </div>

        <Card
          title={
            <span className="flex items-center gap-1.5">
              <ListFilter size={13} /> Triage
            </span>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="grid gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Visible</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.count}</div>
              </div>
              <div className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Live</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.liveCount}</div>
              </div>
              <div className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
                <div className="con-card-title">Risk-reducing exits</div>
                <div className="con-num mt-1 text-[length:var(--con-fs-lg)] font-semibold">{summary.exitCount}</div>
              </div>
              <div className="rounded-lg border border-[color:var(--con-line)] bg-[color:var(--con-surface-2)] px-3 py-2">
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
              {selection.liveCount > 0 && <Chip tone="warn">{selection.liveCount} live need typed confirm</Chip>}
              <div className="ml-auto flex flex-wrap gap-2">
                <Btn
                  variant="pos"
                  size="sm"
                  disabled={stopped || bulkBusy !== null || selection.safeApproveCount === 0}
                  onClick={runBulkApprove}
                  title={stopped ? "The system is stopped, so approval actions are refused." : "Approves the selected paper-safe ideas one by one through the existing server path."}
                >
                  {bulkBusy === "approve" ? "Approving..." : `Approve safe (${selection.safeApproveCount})`}
                </Btn>
                <Btn
                  variant="dangerOutline"
                  size="sm"
                  disabled={stopped || bulkBusy !== null || selection.rejectCount === 0}
                  onClick={runBulkReject}
                  title={stopped ? "The system is stopped, so rejection actions are refused." : "Rejects each selected proposal through the existing server path."}
                >
                  {bulkBusy === "reject" ? "Rejecting..." : `Reject selected (${selection.rejectCount})`}
                </Btn>
              </div>
            </div>
          </div>
        </Card>

        {stopped && (
          <Card>
            <p className="text-[length:var(--con-fs-sm)] text-[color:var(--con-warn)]">
              <strong>The system is stopped.</strong> The server refuses approving or rejecting proposals while stopped —
              start it (or switch to Close-only) from the run-state chip first. Run once can still create proposals.
            </p>
          </Card>
        )}

        {filtered.length === 0 ? (
          <Card>
            <div className="py-8 text-center">
              <p className="font-semibold">No trade proposals match this triage view.</p>
              <p className="mt-1 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
                Adjust the filters above or wait for the next run to stage new ideas.
              </p>
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

        <LearnedContextInbox />

        <p className="text-center text-[length:var(--con-fs-xs)] text-[color:var(--con-faint)]">
          Rejections are data, not failures — every idea you pass on keeps being scored, and Results shows how your
          judgment is doing.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {selection.liveCount > 0 && (
          <Card>
            <div className="flex items-start gap-2 text-[length:var(--con-fs-sm)] text-[color:var(--con-muted)]">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[color:var(--con-warn)]" />
              <p>
                Bulk approve deliberately skips LIVE proposals. Those still use the server-authoritative typed phrase on the
                individual receipt so the broker path stays unchanged.
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
    </div>
  );
}
