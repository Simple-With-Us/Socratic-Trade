import { audit } from "./db";
import { listConnectedAccounts } from "./db-api-keys";
import { getPolicy } from "./db-profiles";
import { getProposal, updatePendingProposalReprice } from "./db-proposals";
import { emitDashboardEvent } from "./events";
import { stampRedTeamResult } from "./finalized-sizing-review";
import { estimateNotional } from "./policy";
import { debateProposal } from "./red-team";
import { loadApprovalQuoteScan } from "./approval-quote-scan";
import { applyRedTeamHalfSize } from "./strategy-risk";
import type {
  DecisionStep,
  HumanReviewReasonCode,
  HumanReviewReasonReceipt,
  PolicyDecision,
  TradeProposal
} from "./types";

export class RetryRedTeamError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RetryRedTeamError";
    this.status = status;
  }
}

function appendRetryDecisionStep(proposal: TradeProposal, step: DecisionStep): void {
  const scorecard = proposal.scorecard ?? (proposal.scorecard = {});
  const chain = scorecard.decisionChain ?? (scorecard.decisionChain = []);
  if (chain.length === 0 && step !== "proposed") chain.push("proposed");
  if (chain[chain.length - 1] === step) return;
  chain.push(step);
}

function upsertHumanReviewReason(proposal: TradeProposal, receipt: HumanReviewReasonReceipt): void {
  const next = (proposal.humanReviewReasons ?? []).filter((reason) => reason.code !== receipt.code);
  next.push(receipt);
  proposal.humanReviewReasons = next;
}

function clearHumanReviewReason(proposal: TradeProposal, code: HumanReviewReasonCode): void {
  const next = (proposal.humanReviewReasons ?? []).filter((reason) => reason.code !== code);
  if (next.length > 0) proposal.humanReviewReasons = next;
  else delete proposal.humanReviewReasons;
}

function applyRetryVerdict(proposal: TradeProposal, result: Awaited<ReturnType<typeof debateProposal>>): number | undefined {
  stampRedTeamResult(proposal, result);
  if (result.rejected) {
    appendRetryDecisionStep(proposal, "red_team_reject");
    upsertHumanReviewReason(proposal, {
      code: "initial_red_team",
      title: "Red Team rejected this opening",
      summary: `${result.reason} Approving still places the order — your click is the override.`
    });
    return undefined;
  }
  if (!result.available) {
    upsertHumanReviewReason(proposal, {
      code: "initial_red_team",
      title: "Red Team review unavailable",
      summary: `The adversarial review could not run: ${result.reason} No model critiqued this opening, so it requires your review.`
    });
    return undefined;
  }
  if (result.verdict === "approve-at-half") {
    const haircut = applyRedTeamHalfSize(proposal);
    if (haircut.applied) {
      clearHumanReviewReason(proposal, "initial_red_team");
      proposal.rationale = `${proposal.rationale}\n\nRed Team retry — approved at half size: ${result.reason} [${haircut.note}]`;
      return estimateNotional(proposal);
    }
    upsertHumanReviewReason(proposal, {
      code: "initial_red_team",
      title: "Red Team half-size cannot be placed",
      summary: `Red approved only half size, but the broker cannot place that haircut: ${haircut.note}. The full-size order requires your decision.`
    });
    return undefined;
  }
  clearHumanReviewReason(proposal, "initial_red_team");
  return undefined;
}

/** Re-run Red Team on a still-pending opening and persist the new verdict. */
export async function retryProposalRedTeam(
  proposalId: string,
  userId: string = "local"
): Promise<{ ok: true; proposalId: string; verdict: TradeProposal["redTeamVerdict"] }> {
  const row = getProposal(proposalId, userId);
  if (!row) throw new RetryRedTeamError("Proposal not found.", 404);
  if (row.status !== "proposed") {
    throw new RetryRedTeamError(`Proposal is already ${row.status}.`, 409);
  }
  // Re-review the proposal against ITS OWN account, not whichever account the console currently has
  // selected. A pending proposal belongs to the run that produced it; reading the active account's
  // policy here meant a retry on account A's proposal was judged with account B's reviewer model,
  // caps, venue and strategy prompt whenever B happened to be selected. Proposals are keyed by
  // broker account number, so resolve that back to the connected account.
  const accounts = listConnectedAccounts(userId);
  const owning = accounts.filter((account) => account.accountNumber === row.accountNumber);
  const policy = getPolicy(userId, owning.length === 1 ? owning[0].id : undefined);
  if (accounts.length > 0 && policy.accountNumber !== row.accountNumber) {
    // The proposal's account is no longer connected (or its number is ambiguous and the selected
    // account is not one of them). Refuse rather than review it against a different account.
    throw new RetryRedTeamError(
      "This proposal belongs to an account that is no longer connected.  Reconnect that account to re-run its Red Team review.",
      409
    );
  }
  const proposal: TradeProposal = { ...row.proposal };
  if (proposal.side !== "buy" && proposal.side !== "short") {
    throw new RetryRedTeamError("Red Team only reviews risk-adding openings.", 400);
  }

  const scan = await loadApprovalQuoteScan({
    proposal,
    positions: [],
    userId,
    accountNumber: policy.accountNumber,
    connectedAccountId: policy.connectedAccountId
  });
  const quote =
    scan.quotesBySymbol[proposal.symbol] ??
    scan.topCandidates.find((candidate) => candidate.symbol === proposal.symbol);

  const estimatedNotional = estimateNotional(proposal);
  const result = await debateProposal(proposal, quote, userId, policy, {
    sizing: {
      sizeBasis:
        typeof proposal.quantity === "number" && proposal.quantity > 0 ? "quantity" : "notional",
      estimatedNotional
    }
  });
  const haircutNotional = applyRetryVerdict(proposal, result);

  const decision: PolicyDecision = {
    ...row.decision,
    ...(result.available
      ? { adversaryUnavailable: undefined, adversaryUnavailableReason: undefined }
      : { adversaryUnavailable: true, adversaryUnavailableReason: result.reason })
  };
  const persisted = updatePendingProposalReprice(
    proposalId,
    {
      proposal,
      decision,
      ...(haircutNotional != null ? { estimatedNotional: haircutNotional } : {})
    },
    userId
  );
  if (!persisted) {
    throw new RetryRedTeamError("Proposal is no longer pending.", 409);
  }

  audit(
    "red_team_retry",
    {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      available: result.available,
      verdict: result.verdict,
      failureKind: result.failureKind,
      model: result.model,
      haircutApplied: haircutNotional != null
    },
    userId,
    policy.connectedAccountId
  );
  emitDashboardEvent({ type: "proposal", userId, at: new Date().toISOString() });
  return { ok: true, proposalId, verdict: proposal.redTeamVerdict };
}
