// red-veto-decision.ts — OD-9 D5c seam (ST-4684, owner-approved 2026-11-24).
// A Bear (Red Team) veto now writes a durable socratic_decisions row with status
// "rejected" so the vetoed proposal is visible on the Decisions ledger and matures
// its 1d/1w (plus 15m/1h where sampled) counterfactual outcome through the same
// skipped-candidate join every other blocked/rejected decision uses
// (outcome-engine.ts: blocked/rejected -> getSkippedCounterfactualByRunSymbol).
//
// DEDUPE contract (nothing is double-booked):
//   - the decision row id is DERIVED (runId + symbol), so a re-veto or a strategy
//     run retry (strategy-run-retry.ts) UPSERTS the same row instead of inserting
//     a second measurement of the same missed opportunity;
//   - a pre-existing row keeps its outcome, lessons and coach notes on re-record, so
//     a later re-veto cannot reset a matured counterfactual measurement;
//   - the skipped_candidate_counterfactuals row itself stays the single measurement
//     basis: the veto path already INSERT-OR-IGNOREs it (recordRejectedProposalCounterfactual),
//     and the later signal-snapshot backfill relies on that same deterministic id.
//
// Best-effort and non-fatal at the call site — the veto path must never fail a run
// because a decision row could not be written.

import { getSocraticDecisionCase, upsertSocraticDecisionCase } from "./db";
import { normalizeSymbol } from "./money";
import { buildSocraticDecisionCase } from "./socratic-runtime";
import type { PolicyDecision, SocraticDecisionCase, StrategyAuthority, TradeProposal } from "./types";

export function redVetoDecisionId(runId: string, symbol: string): string {
  return `red-veto:${runId}:${normalizeSymbol(symbol)}`;
}

export function recordRedVetoDecisionRow(input: {
  userId: string;
  connectedAccountId?: string;
  runId: string;
  /** The durable trade_proposals row id persisted for this veto (status rejected_by_red_team).  */
  proposalId: string;
  accountNumber?: string;
  authority: StrategyAuthority;
  proposal: TradeProposal;
  /** The Red reviewer's rejection rationale (without the red_team_veto prefix).  */
  reason: string;
}): string | undefined {
  const id = redVetoDecisionId(input.runId, input.proposal.symbol);
  const decision: PolicyDecision = { approved: false, reasons: [`red_team_veto: ${input.reason}`] };
  const base = buildSocraticDecisionCase({
    id,
    userId: input.userId,
    connectedAccountId: input.connectedAccountId,
    runId: input.runId,
    proposalId: input.proposalId,
    accountNumber: input.accountNumber,
    proposal: input.proposal,
    status: "rejected",
    authority: input.authority,
    decision
  });
  const now = new Date().toISOString();
  const existing = getSocraticDecisionCase(id, input.userId);
  // Re-record keeps the matured outcome/lessons/coach notes and the original createdAt;
  // proposal_id moves to the newest veto's trade_proposals row so the ledger link is current.
  const caseFile: SocraticDecisionCase = existing
    ? {
        ...existing,
        ...base,
        runId: input.runId,
        proposalId: input.proposalId,
        outcome: existing.outcome,
        lessons: existing.lessons,
        coachNotes: existing.coachNotes,
        createdAt: existing.createdAt,
        updatedAt: now
      }
    : {
        ...base,
        createdAt: now,
        updatedAt: now
      };
  upsertSocraticDecisionCase({ ...caseFile, userId: input.userId });
  return id;
}