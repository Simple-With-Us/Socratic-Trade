import { getBrokerGateway } from "./broker";
import { evaluateBrokerHeldExitAvailability, brokerHeldExitBlockReason } from "./broker-held-orders";
import { describeBrokerMinimumOrderBlock, planBrokerMinimumBump, shouldAlertBrokerMinimumOrderBlock } from "./broker-minimum-guard";
import { isRejectedOrCanceledState } from "./broker-side";
import { audit, clearStopPlans, recordStopPlan } from "./db";
import { getActiveConnectedAccount } from "./db-api-keys";
import { acquireStrategyLock, dailyExecutionStats, notionalInLastMinutes, countDayTradesInLastBusinessDays, releaseStrategyLock } from "./db-execution";
import { listPendingBrokerReconciliationFills, updateFillEvent, listFillEventsByProposalId } from "./db-fills";
import { resolveBrokerVerificationNotifications } from "./db-notifications";
import { getPolicy } from "./db-profiles";
import { getProposal, updatePendingProposalReprice, updateProposalStatus, transitionProposalIfPending, claimProposalForExecution, listStalePlacingProposals } from "./db-proposals";
import { emitDashboardEvent } from "./events";
import { deriveExecutionState, fillSourceForExecutionMode } from "./execution-mode";
import { dynamicIndexUniversesForPolicy } from "./index-universes";
import { scanMarket, mergeQuoteData } from "./market";
import { normalizeSymbol } from "./money";
import { sendNotification } from "./notifications";
import { recordFillFromProposal } from "./performance";
import { allowedSymbolsForPolicy, estimateNotional, applyOpeningOrderHeadroom, evaluateTradeProposal } from "./policy";
import { assertLivePreflight } from "./preflight-live-guard";
import { repriceStoredProtectiveExit, assessProtectiveExitRepriceDrift } from "./protective-exit-routing";
import { notifyStaleLimitOrders } from "./stale-limit-orders";
import { getUserWashSaleLockProvenance } from "./tax";
import { ExecutionMode, FillEvent, PolicyDecision, BrokerGateway, TradeProposal, ReviewedOrder, MarketScan, EquityOrder, FillSource } from "./types";
import { approvedEscalationsFromDecision, shouldEscalateDecision } from "./strategy-risk";
import {
  createExecuteProposalLockOwner,
  startStrategyLockGuard,
  StrategyLockOwnershipLostError
} from "./strategy-lock-guard";
import { assertLiveApprovalConfirmation, uniqueSymbols, currentPricesFromScan, protectiveExitQuoteFromScan, openingPolicyNotionalCap, autoRevertOnCapBreach, auditWashSaleProceed } from "./strategy";

export interface LiveApprovalConfirmation {
  proposalId?: string;
  accountNumber?: string | null;
  executionMode?: ExecutionMode | string;
  estimatedNotional?: number | null;
  typedText?: string | null;
}
export class LiveApprovalConfirmationError extends Error {
  code = "LIVE_CONFIRMATION_REQUIRED";
  reasons: string[];
  expectedText: string;

  constructor(reasons: string[], expectedText: string) {
    super(reasons.join(" "));
    this.reasons = reasons;
    this.expectedText = expectedText;
  }
}
export type PlacementReconcileOutcome =
  | { kind: "placed"; orderId: string; state: string; fill?: FillEvent; alreadyBooked: boolean }
  | { kind: "declined"; orderId: string; state: string }
  | { kind: "not_placed" }
  | { kind: "uncertain"; error: string };
export async function executeProposal(
  proposalId: string,
  userId: string = "local",
  options: { liveConfirmation?: LiveApprovalConfirmation } = {}
): Promise<{
  status: string;
  orderId?: string;
  brokerState?: string;
  fillStatus?: string;
  reasons?: string[];
}> {
  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  if (!policy.accountNumber) throw new Error("No account selected.");
  // An account is an account: with none connected there is no broker to trade through, and there is
  // no local-simulation fallback. Refuse to run rather than synthesize a fake fill.
  if (!executionState.mode) throw new Error("No connected account. Connect a broker account before approving trades.");
  const executionMode: ExecutionMode = executionState.mode;
  const executionSource = fillSourceForExecutionMode(executionMode);
  if (policy.systemState === "halted") throw new Error("System is halted.");

  const row = getProposal(proposalId, userId);
  if (!row) throw new Error("Proposal not found.");
  if (row.status !== "proposed") throw new Error(`Proposal is already ${row.status}.`);
  if (row.accountNumber !== policy.accountNumber) {
    throw new Error("Proposal account no longer matches the selected account. Re-run the strategy before approving.");
  }
  if (row.executionMode && row.executionMode !== executionMode) {
    throw new Error("Proposal execution mode no longer matches the selected mode. Re-run the strategy before approving.");
  }

  // `let`: an approval-held protective exit is repriced against the fresh approval-time quote below.
  let proposal = row.proposal;
  assertLiveApprovalConfirmation({
    executionMode,
    confirmation: options.liveConfirmation,
    proposalId,
    accountNumber: row.accountNumber,
    proposal,
    estimatedNotional: row.estimatedNotional ?? row.review?.estimatedNotional,
    requireTypedConfirmation: policy.requireTypedConfirmation !== false
  });

  // TOCTOU guard on notional/order caps: the daily/hourly cap check reads the
  // trade_proposals table BEFORE inserting the new row. Without this lock, a
  // concurrent autonomous run (which holds acquireStrategyLock) and a manual
  // Approve can each read the same pre-cap totals and both place — jointly
  // exceeding maxDailyNotional / maxHourlyNotional / maxDailyOrders. Acquiring
  // the same lock here serialises approval execution against the strategy loop.
  // Every invocation gets its own owner token. Two same-proposal approvals must contend like any
  // other callers; a loser can never share or release the winner's lease.
  const lockOwner = createExecuteProposalLockOwner(proposalId);
  if (!acquireStrategyLock(lockOwner, userId, policy.connectedAccountId)) {
    return { status: "busy", reasons: ["A strategy run is in progress; try again in a moment."] };
  }
  const lockGuard = startStrategyLockGuard({ owner: lockOwner, userId, connectedAccountId: policy.connectedAccountId });

  try {
    const gateway = getBrokerGateway(policy, userId);

    const [portfolio, positions, orders] = await Promise.all([
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber),
      gateway.getEquityOrders(policy.accountNumber)
    ]);
    const allowedSymbols = allowedSymbolsForPolicy(policy);
    const approvalScanBase = await scanMarket(allowedSymbols, positions, policy.scoringWeights, userId, dynamicIndexUniversesForPolicy(policy), {
      candidateLimit: policy.marketScanCandidateLimit,
      outlierReserve: policy.marketScanOutlierReserve,
      universeFloor: policy.universeFloor
    });
    const approvalQuoteSymbols = uniqueSymbols([...approvalScanBase.topCandidates.map((quote) => quote.symbol), proposal.symbol]);
    const approvalScan = mergeQuoteData(
      approvalScanBase,
      await gateway.getEquityQuotes(policy.accountNumber, approvalQuoteSymbols)
    );

    // An account is an account: the approval is always evaluated against the real broker-reported
    // portfolio and positions for the active account — there is no local-simulation alternative.
    const currentPrices = currentPricesFromScan(approvalScan);
    const account = { portfolio, positions };
    lockGuard.assertOwned();
    await notifyStaleLimitOrders({ userId, policy, orders });
    lockGuard.assertOwned();

    // Approval-held protective exits: an extended-hours marketable-limit stored on the card was
    // priced off the generation-time quote and goes stale while it waits for a human — a quote that
    // moved through the stored limit would leave the once-marketable order resting unfilled where
    // the queue-to-open market exit still gets out. Re-resolve the routing off the fresh quote and
    // wall clock (degrading to market/regular_hours when the extended session no longer applies) and
    // review/evaluate/place the repriced order. Everything else passes through untouched.
    const storedProposal = proposal;
    const approvalExitQuote = protectiveExitQuoteFromScan(
      approvalScan.quotesBySymbol[proposal.symbol] ?? approvalScan.quotesBySymbol[normalizeSymbol(proposal.symbol)]
    );
    proposal = repriceStoredProtectiveExit(proposal, policy, approvalExitQuote);
    if (proposal !== storedProposal) {
      const confirmedNotional = row.estimatedNotional ?? row.review?.estimatedNotional;
      const drift = assessProtectiveExitRepriceDrift(storedProposal, proposal, policy, approvalExitQuote, confirmedNotional);
      // Fresh estimate for the persisted card; a degrade to market has no limit price to estimate
      // from (estimateNotional returns 0), so keep the stored estimate rather than write a zero.
      const repricedEstimate = estimateNotional(proposal);
      const repricedNotional = Number.isFinite(repricedEstimate) && repricedEstimate > 0 ? repricedEstimate : undefined;
      const repriceChange = {
        proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        from: { type: storedProposal.type, limitPrice: storedProposal.limitPrice, marketHours: storedProposal.marketHours },
        to: { type: proposal.type, limitPrice: proposal.limitPrice, marketHours: proposal.marketHours },
        drift
      };
      // LIVE typed-confirmation invariant (repo precedent: autoRemediateStaleExitOrders defers
      // live+typed-confirm remediation to the human rather than silently substituting): the phrase
      // the user typed confirmed the STORED order, so a MATERIAL reprice — price or notional beyond
      // the marketable-limit buffer tolerance — must go back to approval, not to the broker. The
      // card stays pending with the repriced order persisted so the next Approve confirms the
      // numbers that will actually be placed. Immaterial drift places normally below (also audited,
      // via the drift payload on protective_exit_repriced).
      const typedConfirmGatesLive = executionMode === "broker/live" && policy.requireTypedConfirmation !== false;
      if (typedConfirmGatesLive && drift.material) {
        const reason = `Protective exit repriced materially while awaiting approval (price drift ${
          drift.priceDriftBps !== undefined ? Math.round(drift.priceDriftBps) : "unverifiable"
        } bps vs ${drift.toleranceBps} bps tolerance) — a live typed confirmation covered the prior order, so approve the repriced order again.`;
        const persisted = updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional }, userId);
        audit("protective_exit_reprice_reapproval", { ...repriceChange, reason, persisted }, userId, policy.connectedAccountId);
        if (!persisted) {
          const current = getProposal(proposalId, userId)?.status ?? "removed";
          return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
        }
        await sendNotification(
          {
            type: "pending_approval",
            title: `${proposal.symbol} protective exit repriced — approval needed again`,
            payload: { proposalId, proposal, previous: storedProposal, drift, reason }
          },
          { policy, userId }
        );
        return { status: "proposed", reasons: [reason] };
      }
      // Persist the repriced order BEFORE claiming/placing so trade_proposals.proposal (Recent,
      // Activity, getProposal) shows the order the broker actually received, never the stale
      // generation-time price. CAS on status='proposed': if the card expired or was rejected while
      // this approval was in flight, stop here like the other pending guards.
      if (!updatePendingProposalReprice(proposalId, { proposal, estimatedNotional: repricedNotional }, userId)) {
        const current = getProposal(proposalId, userId)?.status ?? "removed";
        return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
      }
      audit("protective_exit_repriced", repriceChange, userId, policy.connectedAccountId);
    }

    const tradability = await gateway.getEquityTradability(policy.accountNumber, [proposal.symbol]);
    lockGuard.assertOwned();
    if (!tradability[proposal.symbol]?.tradable) {
      const reason = tradability[proposal.symbol]?.reason ?? "Symbol is not tradable.";
      const tradabilityDecision: PolicyDecision = { approved: false, reasons: [reason] };
      updateProposalStatus(proposalId, "blocked", undefined, undefined, undefined, userId, undefined, undefined, tradabilityDecision);
      audit("proposal_approved", { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reason }, userId, policy.connectedAccountId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, reason, proposal }
        },
        { policy, userId }
      );
      return { status: "blocked", reasons: [reason] };
    }

    let review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
    lockGuard.assertOwned();

    // Same broker-minimum pre-flight guard as the autonomous run loop: NAV/sizing can drift between
    // proposal creation and a human clicking Approve, so re-check here too rather than let a
    // known-doomed order reach the broker from this path. Same bump-first handling (owner ruling:
    // bump, not skip) and whole-position dust-exit exemption as the autonomous loop (see the guard);
    // the bumped order is re-reviewed and still goes through evaluateTradeProposal below.
    const heldForMinimumGuard = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    let brokerMinimumBlockReason = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...proposal, positionQuantity: heldForMinimumGuard?.quantity });
    // Hoisted above the guard: the bump planner bounds opening bumps by the remaining
    // daily/hourly budget (values unchanged for the post-guard consumers — the skip path
    // returns without placing anything).
    const daily = dailyExecutionStats(policy.accountNumber, new Date(), userId);
    const hourly = notionalInLastMinutes(policy.accountNumber, 60, new Date(), userId);
    let attemptedBumpToNotional: number | undefined;
    // Typed live confirmations and bumps: the owner's confirmation (validated earlier in this
    // function) was minted against the STORED pre-bump notional. A bump can raise the placed
    // notional to the broker floor (+0.5% cushion, so ≤ ~$1.01 on Robinhood) — a bounded,
    // owner-ruled default (brokerMinimumHandling "bump", 2026-07-09), so we deliberately do NOT
    // force a re-confirmation ceremony for that sub-dollar delta; the order_bumped_broker_minimum
    // audit records both sizes and the rationale annotates the up-sizing.
    if (brokerMinimumBlockReason && (policy.brokerMinimumHandling ?? "bump") === "bump") {
      // Same composed cap as the run loop: policy's headroomed per-order cap ∧ remaining
      // daily/hourly budget ∧ available buying power — a bump past any of these would be
      // policy-rejected (and a cap breach can demote authority via autoRevertOnCapBreach).
      const effectiveMaxDailyNotional = Math.min(
        policy.maxDailyNotional ?? Infinity,
        policy.maxDailyPctOfNav ? (policy.maxDailyPctOfNav / 100) * account.portfolio.totalMarketValue : Infinity
      );
      const openingCapNotional = Math.min(
        applyOpeningOrderHeadroom(openingPolicyNotionalCap(proposal, policy, account.portfolio)),
        effectiveMaxDailyNotional - daily.notional,
        (policy.maxHourlyNotional ?? Infinity) - hourly.notional,
        // Mirror policy.ts's buying-power gate (binds when finite && > 0).
        Number.isFinite(account.portfolio.buyingPower) && account.portfolio.buyingPower > 0 ? account.portfolio.buyingPower : Infinity
      );
      // Daily ORDER-COUNT budget (not just notional) — see the run-loop site.
      const openingCountSpent =
        (proposal.side === "buy" || proposal.side === "short") &&
        policy.maxDailyOrders != null &&
        daily.openingOrderCount >= policy.maxDailyOrders;
      const bumpPlan = openingCountSpent ? undefined : planBrokerMinimumBump(
        review,
        policy.activeBroker,
        { ...proposal, positionQuantity: heldForMinimumGuard?.quantity, positionMarketValue: heldForMinimumGuard?.marketValue },
        { openingCapNotional: Number.isFinite(openingCapNotional) ? openingCapNotional : undefined }
      );
      if (bumpPlan) {
        const originalSizing = { quantity: proposal.quantity, dollarAmount: proposal.dollarAmount };
        const originalReview = review;
        Object.assign(proposal, bumpPlan.patch);
        review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
        lockGuard.assertOwned();
        const stillBlocked = describeBrokerMinimumOrderBlock(review, policy.activeBroker, { ...proposal, positionQuantity: heldForMinimumGuard?.quantity });
        if (!stillBlocked) {
          proposal.rationale = `${proposal.rationale} [Sized up from $${bumpPlan.fromNotional.toFixed(2)} to meet the broker's minimum order size (brokerMinimumHandling: bump).]`;
          audit(
            "order_bumped_broker_minimum",
            { proposalId, symbol: proposal.symbol, side: proposal.side, fromNotional: bumpPlan.fromNotional, toNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, action: "approval" },
            userId,
            policy.connectedAccountId
          );
        } else {
          Object.assign(proposal, originalSizing);
          review = originalReview;
          attemptedBumpToNotional = bumpPlan.toNotional;
        }
        brokerMinimumBlockReason = stillBlocked ? brokerMinimumBlockReason : undefined;
      }
    }
    if (brokerMinimumBlockReason) {
      const blockedDecision: PolicyDecision = { approved: false, reasons: [brokerMinimumBlockReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, blockedDecision);
      audit(
        "order_skipped_broker_minimum",
        { proposalId, symbol: proposal.symbol, side: proposal.side, estimatedNotional: review.estimatedNotional, reason: brokerMinimumBlockReason, action: "approval", ...(attemptedBumpToNotional !== undefined ? { attemptedBumpToNotional } : {}) },
        userId,
        policy.connectedAccountId
      );
      if (shouldAlertBrokerMinimumOrderBlock(policy.accountNumber, proposal.symbol)) {
        await sendNotification(
          {
            type: "block",
            title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} skipped (below broker minimum)`,
            payload: { proposalId, decision: blockedDecision, review, proposal }
          },
          { policy, userId }
        );
      }
      return { status: "blocked", reasons: [brokerMinimumBlockReason] };
    }

    const isLiveExecution = executionState.environment === "live";
    const decision = evaluateTradeProposal(proposal, {
      policy,
      portfolio: account.portfolio,
      positions: account.positions,
      dailyNotionalUsed: daily.notional,
      hourlyNotionalUsed: hourly.notional,
      dailyOrderCount: daily.openingOrderCount,
      estimatedNotional: review.estimatedNotional,
      marketScan: approvalScan,
      washSaleLocks: getUserWashSaleLockProvenance(userId, new Date()),
      // Escalated-card override handles from the STORED row (server-minted at escalation time).
      // Empty for ordinary proposals. Only the wash-sale gate consults these, and only while
      // taxSettings.washSaleHandling is ask/auto; every other gate re-runs at full strength.
      approvedEscalations: approvedEscalationsFromDecision(row.decision),
      // ConnectedAccount taxationType is the SOURCE OF TRUTH for the buyer's tax regime (wins
      // over policy taxSettings; capabilities can be absent/"brokerage" on legacy IRA rows) —
      // required so the IRA-replacement hard block (Rev. Rul. 2008-5) can never miss an IRA.
      accountTaxationType: activeAccount?.taxationType,
      accountCapabilities: activeAccount?.capabilities,
      isLiveExecution,
      // PDT gate (FINRA Rule 4210): only meaningful for LIVE execution — skip the count entirely otherwise.
      priorDayTradeCount: isLiveExecution
        ? countDayTradesInLastBusinessDays(policy.accountNumber, 5, new Date(), userId)
        : 0
    });

    // Auditable wash-sale trail on the approval path — never silent. For honored overrides the
    // token ties this execution back to the exact escalated card the owner approved; for IRA
    // disregards the record carries the verbatim note + priced provenance.
    //
    // Gated on decision.approved: a re-evaluation at approval time can return approved:false while
    // still carrying an ira_disregarded / auto_proceeded / approved_via_override outcome (the
    // wash-sale gate itself didn't block, but a later gate — daily cap, buying power, staleness —
    // did). Logging the proceed-trail then would tell Activity the wash sale was disregarded and the
    // deduction forfeited even though the order is blocked below and no purchase happens. When
    // approved, this function proceeds to place/fill the order, so the trail is accurate.
    if (
      decision.approved &&
      decision.washSale &&
      (decision.washSale.outcome === "approved_via_override" ||
        decision.washSale.outcome === "auto_proceeded" ||
        decision.washSale.outcome === "ira_disregarded")
    ) {
      audit(
        decision.washSale.outcome === "ira_disregarded" ? "wash_sale_ira_disregarded" : "wash_sale_override_applied",
        {
          proposalId,
          symbol: proposal.symbol,
          side: proposal.side,
          estimatedNotional: review.estimatedNotional,
          washSale: decision.washSale
        },
        userId,
        policy.connectedAccountId
      );
    }

    if (!decision.approved) {
      // Wash-sale re-escalation instead of death: when the ONLY thing standing between this
      // approval and execution is an ask-mode wash-sale failure (fresh lock discovered at
      // approval time, or a stale override refused because the priced cost moved past
      // washSaleOverrideCostTolerance — outcome "reescalated_cost_changed"), keep the card
      // PENDING with the freshly priced reason and newly minted server-side tokens so the owner
      // can approve again at the current cost. Every other refusal (still-binding caps, IRA
      // hard block, universe, ...) retires the card as blocked exactly as before.
      const washReescalation =
        (decision.escalations ?? []).some((entry) => entry.kind === "wash_sale_ask") &&
        shouldEscalateDecision(decision, policy);
      if (washReescalation) {
        const reescalated: PolicyDecision = {
          ...decision,
          escalations: (decision.escalations ?? []).map((entry) => ({ ...entry, token: crypto.randomUUID() }))
        };
        // Guarded re-queue: only while the row is STILL pending. The scan/review above is async,
        // so the scheduler can expire this proposal — or another tab can reject it — while this
        // approval was in flight; an unconditional 'proposed' write here would resurrect that
        // withdrawn card with fresh override tokens. If the row left the pending state, honor
        // that outcome instead of re-queuing.
        if (!transitionProposalIfPending(proposalId, "proposed", userId, { review, estimatedNotional: review.estimatedNotional, decision: reescalated })) {
          const current = getProposal(proposalId, userId);
          audit(
            "proposal_reescalation_skipped",
            {
              proposalId,
              symbol: proposal.symbol,
              side: proposal.side,
              reasons: decision.reasons,
              currentStatus: current?.status ?? "missing"
            },
            userId,
            policy.connectedAccountId
          );
          return {
            status: current?.status ?? "unknown",
            reasons: [
              `Proposal is no longer pending (now ${current?.status ?? "missing"}); the wash-sale re-escalation was not re-queued.`,
              ...decision.reasons
            ]
          };
        }
        audit(
          "proposal_reescalated",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            action: "approval",
            result: "reescalated",
            reasons: decision.reasons,
            escalations: reescalated.escalations,
            ...(decision.washSale ? { washSale: decision.washSale } : {})
          },
          userId,
          policy.connectedAccountId
        );
        await sendNotification(
          {
            type: "pending_approval",
            title:
              decision.washSale?.outcome === "reescalated_cost_changed"
                ? `${proposal.symbol} rebuy needs a fresh call (wash-sale cost changed)`
                : `${proposal.symbol} rebuy needs your call (wash sale)`,
            payload: { proposalId, proposal, review, decision: reescalated, escalated: true }
          },
          { policy, userId }
        );
        return { status: "proposed", reasons: decision.reasons };
      }

      // Same in-flight window as the re-escalation above: retire the card as blocked only if it
      // is still pending — never overwrite a rejection/expiry that landed during the async review.
      if (!transitionProposalIfPending(proposalId, "blocked", userId, { review, estimatedNotional: review.estimatedNotional, decision })) {
        const current = getProposal(proposalId, userId);
        audit(
          "proposal_block_skipped",
          {
            proposalId,
            symbol: proposal.symbol,
            side: proposal.side,
            reasons: decision.reasons,
            currentStatus: current?.status ?? "missing"
          },
          userId,
          policy.connectedAccountId
        );
        return {
          status: current?.status ?? "unknown",
          reasons: [
            `Proposal is no longer pending (now ${current?.status ?? "missing"}); the policy block was not applied.`,
            ...decision.reasons
          ]
        };
      }
      audit("proposal_approved", {
        proposalId,
        symbol: proposal.symbol,
        side: proposal.side,
        action: "approval",
        result: "blocked",
        reasons: decision.reasons
      }, userId, policy.connectedAccountId);
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision, review, proposal }
        },
        { policy, userId }
      );
      const blockedResult = { status: "blocked", reasons: decision.reasons };
      try {
        lockGuard.assertOwned();
      } catch (error) {
        // The row is already terminally blocked. Losing the lease while its ancillary notification
        // was in flight must not misreport that durable outcome as "busy"/still pending; simply skip
        // the unrelated authority-demotion write that would require current ownership.
        if (error instanceof StrategyLockOwnershipLostError) return blockedResult;
        throw error;
      }
      autoRevertOnCapBreach(decision.reasons, policy, userId, policy.connectedAccountId);
      return blockedResult;
    }

    // Re-assert the proposal is still pending immediately before we act on it. The awaits above
    // (scan, broker review) take time, during which deterministic expiry (scheduler tick) or a
    // concurrent run's LLM re-validation could have retired this proposal to expired/withdrawn —
    // we must not place an order for an idea the system already pulled from the queue.
    const stillPending = getProposal(proposalId, userId);
    if (!stillPending || stillPending.status !== "proposed") {
      const current = stillPending?.status ?? "removed";
      return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
    }

    const heldExit = evaluateBrokerHeldExitAvailability(proposal, account.positions, orders);
    if (heldExit) {
      const heldReason = brokerHeldExitBlockReason(heldExit);
      const heldDecision: PolicyDecision = { approved: false, reasons: [heldReason] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, undefined, heldDecision);
      audit(
        "proposal_approved",
        { proposalId, symbol: proposal.symbol, side: proposal.side, action: "approval", result: "blocked", reasons: heldDecision.reasons, heldExit },
        userId,
        policy.connectedAccountId
      );
      await sendNotification(
        {
          type: "block",
          title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} blocked`,
          payload: { proposalId, decision: heldDecision, review, proposal }
        },
        { policy, userId }
      );
      return { status: "blocked", reasons: heldDecision.reasons };
    }

    // Pre-flight live-order guard on the human-approval path too (parity with the autonomous run
    // loop). No-op on broker/paper; on broker/live it ALLOWS by default and refuses ONLY when live
    // trading has been explicitly disabled via the ALLOW_LIVE_TRADING=false escape hatch. It NEVER
    // places or enables a trade — a human-approved pending proposal clears the same live invariant.
    try {
      assertLivePreflight({
        mode: executionMode,
        symbol: proposal.symbol,
        side: proposal.side
      });
    } catch (guardError) {
      const message = guardError instanceof Error ? guardError.message : String(guardError);
      // Persist a REJECTED decision (not the earlier approved one) so the ledger reflects the block.
      const blockedDecision: PolicyDecision = { ...decision, approved: false, reasons: [...decision.reasons, message] };
      updateProposalStatus(proposalId, "blocked", undefined, review, review.estimatedNotional, userId, undefined, message, blockedDecision);
      audit("order_blocked_live_preflight", { proposalId, symbol: proposal.symbol, side: proposal.side, reason: message, path: "approval" }, userId, policy.connectedAccountId);
      await sendNotification(
        { type: "block", title: `${proposal.symbol} live order blocked (pre-flight)`, payload: { proposalId, proposal, review, reason: message, decision: blockedDecision } },
        { policy, userId }
      );
      return { status: "blocked", reasons: [message] };
    }

    // Re-prove ownership at the final safe boundary. A lost/failed lease leaves the proposal
    // pending instead of writing an intent or calling the broker.
    lockGuard.assertOwned();

    // Atomic, crash-recoverable placement (mirrors the autonomous path): persist the
    // idempotency-keyed intent (status "placing" + refId) BEFORE the broker call so a crash or
    // lost broker response can't leave an untracked real order.
    const refId = crypto.randomUUID();
    // Atomic compare-and-swap BEFORE the broker call: only the caller that flips this proposal
    // proposed -> placing proceeds to placeEquityOrder, so concurrent approvals (double-click, two
    // tabs, from-draft) can't both place a real order (defense in depth with the run-lock above).
    // `proposal` persists execution-time sizing (broker-minimum bump / approval-time reprice) into
    // the row before placement, so crash-recovery books any fill at the size actually sent and
    // Recent/Activity show the executed order rather than the stale original ask.
    if (!claimProposalForExecution(proposalId, "placing", userId, { review, estimatedNotional: review.estimatedNotional, refId, executionMode, proposal })) {
      const current = getProposal(proposalId, userId)?.status ?? "removed";
      return { status: current, reasons: [`Proposal was ${current} before it could be executed.`] };
    }
    let execution: Awaited<ReturnType<typeof gateway.placeEquityOrder>>;
    try {
      execution = await gateway.placeEquityOrder({ accountNumber: policy.accountNumber, ...proposal, refId });
    } catch (placeError) {
      const message = placeError instanceof Error ? placeError.message : String(placeError);
      const sym = proposal.symbol;
      // Ask the broker what actually happened (via the refId idempotency key) rather than firing a
      // perpetual "verify with broker" alert. Mirrors the autonomous run-loop catch above.
      const outcome = await reconcilePlacementError({
        gateway,
        accountNumber: row.accountNumber,
        userId,
        proposalId,
        refId,
        proposal,
        review,
        marketScan: approvalScan,
        executionMode,
        placeErrorMessage: message,
        runId: row.runId
      });
      if (outcome.kind === "placed") {
        updateProposalStatus(proposalId, "placed", outcome.orderId, review, review.estimatedNotional, userId);
        auditWashSaleProceed(decision, { proposalId, symbol: sym, side: proposal.side, estimatedNotional: review.estimatedNotional, userId, connectedAccountId: policy.connectedAccountId });
        audit("order_placement_recovered_inline", { proposalId, refId, orderId: outcome.orderId, state: outcome.state, alreadyBooked: outcome.alreadyBooked, symbol: sym, side: proposal.side, path: "approval" }, userId, policy.connectedAccountId);
        resolveBrokerVerificationNotifications(userId, { proposalId, refId, resolution: "recovered" });
        const fillStatus = outcome.state === "filled" ? "filled" : "pending_reconciliation";
        await sendNotification(
          { type: "fill", title: `${sym} order ${outcome.state} (recovered after placement error)`, payload: { proposalId, refId, fill: outcome.fill, reconcile: "recovered" } },
          { policy, userId }
        );
        emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: outcome.orderId, symbol: sym } });
        return { status: "placed", orderId: outcome.orderId, brokerState: outcome.state, fillStatus };
      }
      if (outcome.kind === "declined") {
        const declinedMsg = `Broker declined the order (state: ${outcome.state}).`;
        updateProposalStatus(proposalId, "rejected_by_broker", outcome.orderId, review, review.estimatedNotional, userId, undefined, declinedMsg);
        audit("order_rejected_by_broker", { proposalId, refId, symbol: sym, side: proposal.side, orderId: outcome.orderId, brokerState: outcome.state, via: "inline_reconcile" }, userId, policy.connectedAccountId);
        await sendNotification(
          { type: "run_failed", title: `${sym} order declined by broker (${outcome.state})`, payload: { proposalId, refId, orderId: outcome.orderId, state: outcome.state, reconcile: "declined" } },
          { policy, userId }
        );
        return { status: "error", reasons: [declinedMsg], orderId: outcome.orderId, brokerState: outcome.state };
      }
      if (outcome.kind === "not_placed") {
        const note = "Broker reachable; no order carries our idempotency key — the order never reached the broker. Safe to retry.";
        updateProposalStatus(proposalId, "not_placed", undefined, review, review.estimatedNotional, userId, undefined, note);
        audit("order_confirmed_not_placed", { proposalId, refId, symbol: sym, side: proposal.side, error: message, path: "approval" }, userId, policy.connectedAccountId);
        await sendNotification(
          { type: "run_failed", title: `${sym} order was NOT placed — safe to retry`, payload: { proposalId, refId, error: message, reconcile: "not_placed" } },
          { policy, userId }
        );
        return { status: "not_placed", reasons: [`Order not placed (safe to retry): ${message}`] };
      }
      // uncertain: broker unreachable — KEEP status 'placing' so flagStalePlacingIntents retries.
      updateProposalStatus(proposalId, "placing", undefined, review, review.estimatedNotional, userId, undefined, outcome.error);
      audit("order_placement_uncertain", { proposalId, refId, symbol: sym, side: proposal.side, estimatedNotional: review.estimatedNotional, error: outcome.error, brokerUnreachable: true }, userId, policy.connectedAccountId);
      await sendNotification(
        { type: "run_failed", title: `${sym} order placement uncertain — verify with broker`, payload: { proposalId, refId, error: outcome.error, reconcile: "uncertain" } },
        { policy, userId }
      );
      return { status: "error", reasons: [`Order placement failed/uncertain: ${outcome.error}`] };
    }

    // See the matching comment in the autonomous run-loop placement path above: a non-throwing
    // broker response can still be a synchronous rejection/cancellation, and that must not be
    // recorded as "placed".
    if (isRejectedOrCanceledState(execution.state)) {
      const message = `Broker declined the order (state: ${execution.state}).`;
      updateProposalStatus(proposalId, "rejected_by_broker", execution.orderId, review, review.estimatedNotional, userId, undefined, message);
      audit("order_rejected_by_broker", { proposalId, refId, symbol: proposal.symbol, side: proposal.side, orderId: execution.orderId, brokerState: execution.state }, userId, policy.connectedAccountId);
      await sendNotification(
        { type: "run_failed", title: `${proposal.symbol} order declined by broker (${execution.state})`, payload: { proposalId, refId, orderId: execution.orderId, state: execution.state } },
        { policy, userId }
      );
      return { status: "error", reasons: [message], orderId: execution.orderId, brokerState: execution.state };
    }

    updateProposalStatus(proposalId, "placed", execution.orderId, review, review.estimatedNotional, userId);
    const fillStatus = execution.state === "filled" ? "filled" : "pending_reconciliation";
    const preFillPosition = positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    const fill = recordFillFromProposal({
      userId,
      accountNumber: row.accountNumber,
      proposalId,
      runId: row.runId,
      source: executionSource,
      executionMode,
      proposal,
      review,
      execution,
      marketScan: approvalScan,
      status: fillStatus,
      existingPosition: preFillPosition ? { averageCost: preFillPosition.averageCost, quantity: preFillPosition.quantity } : undefined
    });
    audit("proposal_approved", {
      proposalId,
      symbol: proposal.symbol,
      side: proposal.side,
      action: "approval",
      result: "placed",
      orderId: execution.orderId,
      brokerState: execution.state,
      fillStatus
    }, userId, policy.connectedAccountId);
    await sendNotification(
      {
        type: "fill",
        title: `${proposal.side.charAt(0).toUpperCase() + proposal.side.slice(1)} ${proposal.symbol} ${execution.state}`,
        payload: { proposalId, fill }
      },
      { policy, userId }
    );
    // Push so other open dashboards refresh immediately (the approving client refreshes via its
    // own response).
    emitDashboardEvent({ type: "order", userId, at: new Date().toISOString(), detail: { proposalId, orderId: execution.orderId, symbol: proposal.symbol } });
    return { status: "placed", orderId: execution.orderId, brokerState: execution.state, fillStatus };
  } catch (error) {
    if (error instanceof StrategyLockOwnershipLostError) {
      return { status: "busy", reasons: [error.message] };
    }
    throw error;
  } finally {
    lockGuard.stop();
    releaseStrategyLock(lockOwner, userId, policy.connectedAccountId);
  }
}
export async function reconcilePendingFills(gateway: BrokerGateway, accountNumber: string, userId: string = "local", connectedAccountId?: string): Promise<void> {
  const pending = listPendingBrokerReconciliationFills(accountNumber, userId);
  if (pending.length === 0) return;

  try {
    const brokerOrders = await gateway.getEquityOrders(accountNumber);
    // Lazily fetched (only if a pending fill actually carries an opening stopPlan) and cached across
    // the loop — these orders already EXECUTED at the broker, so the live position's averageCost is
    // the real POST-fill blended basis (no manual weighting needed, unlike the placement-time callers
    // in performance.ts that only have the PRE-fill snapshot). Recording the raw single-fill `price`
    // instead would make `filterStopPlansByLiveBasis` discard a scale-in's plan as stale on the very
    // next run (Codex review, PR #1371).
    let liveBasisBySymbol: Map<string, number> | null = null;
    const liveBasisFor = async (symbol: string): Promise<number | undefined> => {
      if (!liveBasisBySymbol) {
        try {
          const livePositions = await gateway.getEquityPositions(accountNumber);
          liveBasisBySymbol = new Map(livePositions.map((p) => [normalizeSymbol(p.symbol), p.averageCost]));
        } catch {
          liveBasisBySymbol = new Map();
        }
      }
      return liveBasisBySymbol.get(normalizeSymbol(symbol));
    };
    for (const fill of pending) {
      const matched = brokerOrders.find((bo) => bo.id === fill.brokerOrderId);
      if (!matched) continue;

      const execQty = matched.filledQuantity ?? 0;
      const execPrice = matched.averagePrice ?? fill.price;
      // The stop plan couldn't be committed at placement time — this order was still
      // pending_reconciliation then, and a canceled/expired-with-nothing-executed order must never
      // leave a plan row governing a lot that never opened (Codex review, PR #1371). Any executed
      // quantity (full or partial fill) DID open the lot, so commit the plan now from the original
      // proposal stamped into this fill's own raw payload.
      const commitStopPlanIfOpening = async (price: number) => {
        const openingProposal = (fill.raw as { proposal?: TradeProposal } | undefined)?.proposal;
        if (
          openingProposal?.stopPlan &&
          (openingProposal.side === "buy" || openingProposal.side === "short")
        ) {
          try {
            // An explicit "default" CLEARS any existing override (the only way a scale-in can ever
            // reset a position back to the account's own precedence) — mirrors
            // recordFillFromProposal's same-named gate in performance.ts (Codex review, PR #1371).
            if (openingProposal.stopPlan.style === "default") {
              clearStopPlans(accountNumber, [fill.symbol], userId);
            } else {
              const basis = (await liveBasisFor(fill.symbol)) ?? price;
              recordStopPlan(
                accountNumber,
                fill.symbol,
                openingProposal.stopPlan.style,
                openingProposal.stopPlan.rationale,
                basis,
                userId,
                undefined,
                openingProposal.side === "short" ? "short" : "long"
              );
            }
          } catch {
            // plan bookkeeping must never break fill reconciliation
          }
        }
      };
      // Book the executed portion of an order. Idempotent: reconcile UPDATES the
      // existing fill record (by fill.id), so a later poll overwriting with a larger
      // executed quantity never double counts; the realtime trade_updates stream funnels
      // into the same record too.
      const bookExecuted = async (auditStatus: string) => {
        updateFillEvent(fill.id, {
          status: "filled",
          price: execPrice,
          quantity: execQty,
          notional: execPrice * execQty,
          filledAt: matched.updatedAt ?? new Date().toISOString(),
          raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
        }, userId);
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: auditStatus, price: execPrice, quantity: execQty }, userId, connectedAccountId);
        await commitStopPlanIfOpening(execPrice);
      };

      if (matched.state === "filled") {
        const price = matched.averagePrice ?? fill.price;
        const qty = matched.filledQuantity ?? fill.quantity;
        updateFillEvent(fill.id, {
          status: "filled",
          price,
          quantity: qty,
          notional: price * qty,
          filledAt: matched.updatedAt ?? new Date().toISOString(),
          raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
        }, userId);
        audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: "filled", price, quantity: qty }, userId, connectedAccountId);
        await commitStopPlanIfOpening(price);
        // An order reaching "filled" PROVES it was placed, so clear any lingering "verify with
        // broker" uncertain alert for that proposal (only on a full fill — not while still working).
        if (fill.proposalId) resolveBrokerVerificationNotifications(userId, { proposalId: fill.proposalId, resolution: "placed" });
      } else if (matched.state === "partially_filled") {
        // A live order that has executed some-but-not-all shares: book the executed
        // portion now so it enters P&L/exposure instead of being silently dropped.
        if (execQty > 0) await bookExecuted("partially_filled");
      } else if (isRejectedOrCanceledState(matched.state)) {
        if (execQty > 0) {
          // Order terminated AFTER a partial execution — book the executed shares
          // rather than marking the whole fill cancelled and losing them.
          await bookExecuted(`${matched.state}_partial`);
        } else {
          updateFillEvent(fill.id, {
            status: matched.state,
            raw: { ...((fill.raw as Record<string, unknown>) ?? {}), reconciliation: matched }
          }, userId);
          audit("fill_reconciled", { fillId: fill.id, symbol: fill.symbol, status: matched.state }, userId, connectedAccountId);
        }
      }
    }
  } catch (error) {
    console.error("[reconciliation] failed to reconcile pending fills:", error);
  }
}
export async function reconcilePlacementError(p: {
  gateway: BrokerGateway;
  accountNumber: string;
  userId: string;
  proposalId: string;
  refId: string;
  proposal: TradeProposal;
  review?: ReviewedOrder;
  marketScan?: MarketScan;
  executionMode: ExecutionMode;
  placeErrorMessage: string;
  runId?: string;
}): Promise<PlacementReconcileOutcome> {
  // Wait a brief period to allow the broker's order list to index the new order
  // and prevent sub-millisecond races (where an accepted order isn't visible yet).
  await new Promise((resolve) => setTimeout(resolve, 1000));

  let brokerOrders: EquityOrder[];
  try {
    brokerOrders = await p.gateway.getEquityOrders(p.accountNumber);
  } catch {
    // getEquityOrders throwing is the ONLY genuinely-unknown case.
    return { kind: "uncertain", error: p.placeErrorMessage };
  }
  // Truthiness guard identical to the sweep's (:5249) so undefined === undefined can never false-match.
  const matched = p.refId ? brokerOrders.find((o) => o.clientOrderId && o.clientOrderId === p.refId) : undefined;
  if (!matched) {
    // Absent-from-list is only a SAFE not_placed conclusion when the broker's order list is
    // authoritative for recently-terminal orders (Alpaca pages status:"all"). If the adapter can't
    // guarantee the list includes filled/canceled orders for the lookback window (Robinhood —
    // unverified; ordersListIncludesTerminal unset), absence can't distinguish "never placed" from
    // "placed, filled, and already aged out", so prefer uncertain (keep 'placing' + protected alert)
    // over dropping a possibly-real order that the next run would then duplicate (MP-3).
    if (p.gateway.ordersListIncludesTerminal === true) return { kind: "not_placed" };
    return {
      kind: "uncertain",
      error: `${p.placeErrorMessage} (broker reachable but its order list may omit recently-terminal orders — cannot confirm the order was never placed)`
    };
  }
  if (isRejectedOrCanceledState(matched.state)) return { kind: "declined", orderId: matched.id, state: matched.state };
  // Live / filled / any non-terminal state: the order reached the broker. Book it (deduped).
  try {
    const existing = listFillEventsByProposalId(p.proposalId, p.userId);
    const dup = existing.find((f) => f.brokerOrderId === matched.id);
    if (dup) return { kind: "placed", orderId: matched.id, state: matched.state, fill: dup, alreadyBooked: true };
    const source: FillSource = p.executionMode === "broker/live" ? "live" : "paper";
    const fill = recordFillFromProposal({
      userId: p.userId,
      accountNumber: p.accountNumber,
      proposalId: p.proposalId,
      runId: p.runId,
      source,
      executionMode: p.executionMode,
      proposal: p.proposal,
      review: p.review,
      marketScan: p.marketScan,
      execution: { orderId: matched.id, refId: p.refId, state: matched.state, filledQuantity: matched.filledQuantity, averagePrice: matched.averagePrice, raw: matched },
      status: matched.state === "filled" ? "filled" : "pending_reconciliation"
    });
    return { kind: "placed", orderId: matched.id, state: matched.state, fill, alreadyBooked: false };
  } catch (bookError) {
    // We KNOW the order exists but booking failed — degrade to uncertain so the 'placing' intent +
    // alert survive for the sweep to retry, rather than dropping a real order on the floor (MP-8).
    const detail = bookError instanceof Error ? bookError.message : String(bookError);
    return { kind: "uncertain", error: `${p.placeErrorMessage} (order confirmed at broker but booking failed: ${detail})` };
  }
}
export async function flagStalePlacingIntents(gateway: BrokerGateway, accountNumber: string, userId: string, connectedAccountId?: string): Promise<void> {
  const STALE_PLACING_MS = 2 * 60_000;
  const cutoff = new Date(Date.now() - STALE_PLACING_MS).toISOString();
  let stale: ReturnType<typeof listStalePlacingProposals>;
  try {
    stale = listStalePlacingProposals(accountNumber, cutoff, userId);
  } catch (e) {
    console.error("[placing-sweep] failed to list stale placing intents:", e);
    return;
  }
  if (stale.length === 0) return;

  // Broker-truth-first reconcile: a stale "placing" intent means a prior run died between the
  // broker call and the post-write. Ask the broker for the order carrying our idempotency key
  // (refId → clientOrderId). If it exists, the order DID reach the broker — recover it into P&L/
  // accounting at the broker's real fill price. If no order carries our key, it never executed and
  // is safe to abandon. If the broker is unreachable, leave the row 'placing' for a later retry.
  let brokerOrders: EquityOrder[];
  try {
    brokerOrders = await gateway.getEquityOrders(accountNumber);
  } catch (e) {
    console.error("[placing-sweep] broker unreachable for recovery; will retry next run:", e);
    for (const row of stale) {
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, note: "Stale placing intent; broker unreachable for recovery — will retry." }, userId, connectedAccountId);
    }
    return;
  }

  // Lazily fetched (only if a recovered fill actually carries an opening stopPlan) — these orders
  // already EXECUTED at the broker, so the live position's averageCost is the real POST-fill blended
  // basis, same reasoning as reconcilePendingFills' liveBasisFor (Codex review, PR #1371).
  let liveBasisBySymbol: Map<string, number> | null = null;
  const liveBasisFor = async (symbol: string): Promise<number | undefined> => {
    if (!liveBasisBySymbol) {
      try {
        const livePositions = await gateway.getEquityPositions(accountNumber);
        liveBasisBySymbol = new Map(livePositions.map((pos) => [normalizeSymbol(pos.symbol), pos.averageCost]));
      } catch {
        liveBasisBySymbol = new Map();
      }
    }
    return liveBasisBySymbol.get(normalizeSymbol(symbol));
  };

  for (const row of stale) {
    const p = row.proposal as TradeProposal | undefined;
    const matched = row.refId ? brokerOrders.find((o) => o.clientOrderId && o.clientOrderId === row.refId) : undefined;
    if (matched && isRejectedOrCanceledState(matched.state)) {
      // The order reached the broker but was REJECTED/CANCELED — a terminal decline, NOT a placed
      // order. Mirror reconcilePlacementError (:declined) and reconcilePendingFills (:isRejectedOr…):
      // mark the proposal rejected_by_broker and DO NOT book a fill or clear the uncertain alert as
      // "placed" (booking a phantom fill / silently claiming placement is the money-path hazard the
      // matched branch below must never do for a declined order).
      const declinedMsg = `Broker declined the order (state: ${matched.state}).`;
      updateProposalStatus(row.id, "rejected_by_broker", matched.id, undefined, undefined, userId, undefined, declinedMsg);
      audit("order_rejected_by_broker", { proposalId: row.id, refId: row.refId, orderId: matched.id, brokerState: matched.state, symbol: p?.symbol, side: p?.side, via: "sweep" }, userId, connectedAccountId);
    } else if (matched) {
      updateProposalStatus(row.id, "placed", matched.id, undefined, undefined, userId);
      if (p) {
        // Layer-B dedupe (crash window): if a prior inline reconcile / sweep already booked this
        // order (same brokerOrderId) but the status flip didn't persist, don't book a second fill.
        // Dedupe key = (proposalId, brokerOrderId); the same physical order always yields the same
        // brokerOrderId (we place with client_order_id = refId), so re-entry matches and no-ops.
        const existing = listFillEventsByProposalId(row.id, userId);
        const alreadyBooked = existing.some((f) => f.brokerOrderId === matched.id);
        if (!alreadyBooked) {
          const recoveredExecutionMode = row.executionMode ?? "broker/live";
          const recoveredSource: FillSource = recoveredExecutionMode === "broker/live" ? "live" : "paper";
          const existingAvgCost = p.stopPlan ? await liveBasisFor(p.symbol) : undefined;
          recordFillFromProposal({
            userId,
            accountNumber,
            proposalId: row.id,
            source: recoveredSource,
            executionMode: recoveredExecutionMode,
            proposal: p,
            execution: { orderId: matched.id, refId: row.refId ?? "", state: matched.state, filledQuantity: matched.filledQuantity, averagePrice: matched.averagePrice, raw: matched },
            status: matched.state === "filled" ? "filled" : "pending_reconciliation",
            // The order already executed at the broker, so the live position's averageCost IS the
            // correct post-fill blended basis already — bypass the pre-fill blend math entirely rather
            // than re-deriving it from the single recovered fill price.
            stopPlanBasisOverride: existingAvgCost
          });
        }
      }
      audit("order_placement_recovered", { proposalId: row.id, refId: row.refId, orderId: matched.id, state: matched.state, symbol: p?.symbol, side: p?.side }, userId, connectedAccountId);
      // A recovered order is a CONFIRMED placement — clear any perpetual "verify with broker" alert
      // this proposal left behind (the primary fix for "even reconciled orders stay uncertain").
      resolveBrokerVerificationNotifications(userId, { proposalId: row.id, refId: row.refId ?? undefined, resolution: "recovered" });
    } else if (gateway.ordersListIncludesTerminal === true) {
      // Absent from an AUTHORITATIVE order list (includes recently-terminal orders, e.g. Alpaca
      // status:"all") ⇒ the order truly never reached the matching engine. Abandon it.
      updateProposalStatus(row.id, "placing_failed", undefined, undefined, undefined, userId, undefined, "Order never confirmed — broker record not found during reconciliation.");
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, symbol: p?.symbol, side: p?.side, createdAt: row.createdAt, note: "Stale 'placing' intent had no matching broker order — never executed; abandoned." }, userId, connectedAccountId);
    } else {
      // Absent from a NON-authoritative list (terminal-inclusion unverified, e.g. Robinhood): absence
      // can't prove "never placed" vs "placed, filled, and aged out". Abandoning would risk dropping a
      // real fill that the next run then duplicates, so KEEP the row 'placing' + its protected
      // uncertain alert (a human must verify). Matches reconcilePlacementError's conservative branch —
      // without this the sweep would silently undo that inline conservatism.
      audit("order_placement_uncertain", { proposalId: row.id, refId: row.refId, symbol: p?.symbol, side: p?.side, createdAt: row.createdAt, note: "Stale 'placing' intent absent from a non-authoritative broker order list — cannot confirm it was never placed; kept 'placing' for verification rather than abandoned." }, userId, connectedAccountId);
    }
  }
}
export function coerceProtectiveExitToMarket(proposal: TradeProposal): TradeProposal {
  const isProtectiveExit = (proposal.side === "sell" || proposal.side === "cover") && proposal.tradeThesisTag === "Risk-Exit";
  if (!isProtectiveExit) return proposal;
  if (proposal.type !== "limit" && proposal.type !== "stop_limit") return proposal;
  return {
    ...proposal,
    type: "market",
    limitPrice: undefined,
    stopPrice: undefined,
    rationale: (proposal.rationale ?? "") + "\n\n[Risk] Protective Risk-Exit routed as a MARKET order so it actually fills — a resting limit can miss the exit in a fast/falling tape, and a stale unfilled exit then blocks every retry."
  };
}
