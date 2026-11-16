import type { ExecutionMode, PendingProposal } from "@/lib/types";
import { resolveApprovalExecutionMode } from "../lib/approval-honesty";

export type ApprovalSideFilter = "all" | "openings" | "exits";
export type ApprovalRealityFilter = "all" | "live" | "paper";
export type ApprovalSort = "newest" | "oldest" | "confidence" | "notional" | "drift";

export interface ApprovalTriageState {
  query: string;
  side: ApprovalSideFilter;
  reality: ApprovalRealityFilter;
  sort: ApprovalSort;
}

export interface ApprovalSummary {
  count: number;
  liveCount: number;
  exitCount: number;
  totalEstimatedNotional: number;
}

export interface BulkSelectionSummary {
  selectedCount: number;
  approveCount: number;
  safeApproveCount: number;
  liveCount: number;
  liveEstimatedNotional: number;
  rejectCount: number;
}

function createdAtMs(proposal: PendingProposal): number {
  const ms = Date.parse(proposal.createdAt);
  return Number.isFinite(ms) ? ms : 0;
}

export function approvalIsExit(proposal: PendingProposal): boolean {
  return proposal.proposal.side === "sell" || proposal.proposal.side === "cover";
}

export function approvalIsLive(proposal: PendingProposal, currentMode?: ExecutionMode): boolean {
  return resolveApprovalExecutionMode(proposal.executionMode, currentMode) === "broker/live";
}

export function approvalEstimatedNotional(proposal: PendingProposal): number {
  const value =
    proposal.estimatedNotional ??
    proposal.review?.estimatedNotional ??
    proposal.proposal.dollarAmount ??
    0;
  return Number.isFinite(value) ? value : 0;
}

function proposalSearchBlob(proposal: PendingProposal): string {
  return [
    proposal.proposal.symbol,
    proposal.proposal.tradeThesisTag,
    proposal.proposal.entryMarketRegime,
    proposal.proposal.rationale,
    proposal.proposal.redTeamVerdict?.reason,
    proposal.revalidationNote
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function compareForSort(a: PendingProposal, b: PendingProposal, sort: ApprovalSort): number {
  switch (sort) {
    case "oldest":
      return createdAtMs(a) - createdAtMs(b);
    case "confidence":
      return (b.proposal.confidenceScore ?? -1) - (a.proposal.confidenceScore ?? -1) || createdAtMs(b) - createdAtMs(a);
    case "notional":
      return approvalEstimatedNotional(b) - approvalEstimatedNotional(a) || createdAtMs(b) - createdAtMs(a);
    case "drift":
      return (Math.abs(b.performanceSinceProposalPct ?? -1) - Math.abs(a.performanceSinceProposalPct ?? -1)) || createdAtMs(b) - createdAtMs(a);
    case "newest":
    default:
      return createdAtMs(b) - createdAtMs(a);
  }
}

export function triagePendingProposals(
  proposals: PendingProposal[],
  state: ApprovalTriageState,
  currentMode?: ExecutionMode
): PendingProposal[] {
  const query = state.query.trim().toLowerCase();
  return proposals
    .filter((proposal) => {
      if (state.side === "openings" && approvalIsExit(proposal)) return false;
      if (state.side === "exits" && !approvalIsExit(proposal)) return false;
      if (state.reality === "live" && !approvalIsLive(proposal, currentMode)) return false;
      if (state.reality === "paper" && approvalIsLive(proposal, currentMode)) return false;
      if (query && !proposalSearchBlob(proposal).includes(query)) return false;
      return true;
    })
    .sort((a, b) => compareForSort(a, b, state.sort));
}

export function summarizePendingProposals(
  proposals: PendingProposal[],
  currentMode?: ExecutionMode
): ApprovalSummary {
  return proposals.reduce<ApprovalSummary>(
    (summary, proposal) => {
      summary.count += 1;
      summary.totalEstimatedNotional += approvalEstimatedNotional(proposal);
      if (approvalIsLive(proposal, currentMode)) summary.liveCount += 1;
      if (approvalIsExit(proposal)) summary.exitCount += 1;
      return summary;
    },
    { count: 0, liveCount: 0, exitCount: 0, totalEstimatedNotional: 0 }
  );
}

export function summarizeBulkSelection(
  proposals: PendingProposal[],
  selectedIds: Iterable<string>,
  currentMode?: ExecutionMode
): BulkSelectionSummary {
  const selected = new Set(selectedIds);
  let selectedCount = 0;
  let safeApproveCount = 0;
  let liveCount = 0;
  let liveEstimatedNotional = 0;
  for (const proposal of proposals) {
    if (!selected.has(proposal.id)) continue;
    selectedCount += 1;
    if (approvalIsLive(proposal, currentMode)) {
      liveCount += 1;
      liveEstimatedNotional += approvalEstimatedNotional(proposal);
      continue;
    }
    safeApproveCount += 1;
  }
  return {
    selectedCount,
    approveCount: selectedCount,
    safeApproveCount,
    liveCount,
    liveEstimatedNotional,
    rejectCount: selectedCount
  };
}
