// Bridge: promote a chat-assistant ChatDraft into the EXISTING approve -> executeProposal rail.
// POST { draft, dryRun? }. With dryRun:true it returns the policy decision + estimated notional
// WITHOUT inserting; otherwise it inserts a status:'proposed' row that the human confirms via the
// unchanged POST /api/proposals/[id]/approve. The chat module gains NO execution capability here —
// the authoritative re-evaluation still happens inside executeProposal at confirm time.

import crypto from "crypto";
import { NextResponse } from "next/server";
import { resolveRequestUserId } from "@/lib/request-user";
import {
  audit,
  dailyExecutionStats,
  findProposedIdByRunId,
  getActiveConnectedAccount,
  getPolicy,
  insertProposal,
  notionalInLastMinutes
} from "@/lib/db";
import { getBrokerGateway } from "@/lib/broker";
import { dynamicIndexUniversesForPolicy } from "@/lib/index-universes";
import { allowedSymbolsForPolicy, evaluateTradeProposal } from "@/lib/policy";
import { shouldEscalateDecision } from "@/lib/strategy";
import { emitDashboardEvent } from "@/lib/events";
import { chatDraftToProposal } from "@/lib/chat/promote-draft";
import { deriveExecutionState } from "@/lib/execution-mode";
import type { ChatDraft } from "@/lib/chat/types";
import type { PolicyDecision, ReviewedOrder } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { draft?: ChatDraft; dryRun?: boolean; userId?: unknown };
  const userId = resolveRequestUserId(request, body);

  if (!body.draft || typeof body.draft !== "object") {
    return NextResponse.json({ error: "draft is required" }, { status: 400 });
  }
  const mapped = chatDraftToProposal(body.draft);
  if (!mapped.ok) return NextResponse.json({ error: mapped.error }, { status: 400 });
  const proposal = mapped.proposal;

  const policy = getPolicy(userId);
  const activeAccount = getActiveConnectedAccount(userId);
  const executionState = deriveExecutionState(policy, activeAccount);
  const executionMode = executionState.mode;
  if (!policy.accountNumber) {
    return NextResponse.json({ error: "NO_ACCOUNT", reasons: ["No account is selected."] }, { status: 400 });
  }
  if (policy.systemState === "halted") {
    return NextResponse.json({ error: "HALTED", reasons: ["System is stopped — press Start to enable orders."] }, { status: 409 });
  }
  // Never trust the LLM draft: the symbol must be in the user's allowed universe.
  if (!allowedSymbolsForPolicy(policy).includes(proposal.symbol)) {
    const hasDynamicUniverse = dynamicIndexUniversesForPolicy(policy).length > 0;
    const reason = hasDynamicUniverse
      ? `${proposal.symbol} is not in the explicit watchlist. Broad indexes are scan-ranked first; run Market Scan and use a scanned candidate, or add ${proposal.symbol} to Additional Watchlist.`
      : `${proposal.symbol} is not in the allowed universe.`;
    return NextResponse.json({ error: "SYMBOL_NOT_ALLOWED", reasons: [reason] }, { status: 400 });
  }

  const gateway = getBrokerGateway(policy, userId);
  let portfolio;
  let positions;
  try {
    [portfolio, positions] = await Promise.all([
      gateway.getPortfolio(policy.accountNumber),
      gateway.getEquityPositions(policy.accountNumber)
    ]);
  } catch {
    return NextResponse.json({ error: "ACCOUNT_FETCH_FAILED", reasons: ["Could not read the account."] }, { status: 502 });
  }

  let review: ReviewedOrder | undefined;
  try {
    review = await gateway.reviewEquityOrder({ accountNumber: policy.accountNumber, ...proposal });
  } catch {
    review = undefined; // estimatedNotional falls back to evaluateTradeProposal's own estimate
  }

  const now = new Date();
  const daily = dailyExecutionStats(policy.accountNumber, now, userId);
  const hourly = notionalInLastMinutes(policy.accountNumber, 60, now, userId);
  // NB: this is a PREVIEW evaluation (no full market scan); the authoritative gate runs again inside
  // executeProposal at approve time against fresh data.
  let decision = evaluateTradeProposal(proposal, {
    policy,
    portfolio,
    positions,
    dailyNotionalUsed: daily.notional,
    hourlyNotionalUsed: hourly.notional,
    dailyOrderCount: daily.openingOrderCount,
    estimatedNotional: review?.estimatedNotional,
    // ConnectedAccount taxationType is the SOURCE OF TRUTH for the buyer's tax regime — required
    // so the IRA-replacement wash-sale hard block (Rev. Rul. 2008-5) can never miss an IRA whose
    // capabilities are absent/"brokerage" and whose policy taxSettings lack taxationType.
    accountTaxationType: activeAccount?.taxationType,
    accountCapabilities: activeAccount?.capabilities,
    isLiveExecution: executionMode === "broker/live",
    userId,
    now
  });
  let estimatedNotional = review?.estimatedNotional;

  // Honest pricing: when the pre-trade review couldn't get a price it returns the over-cap sentinel
  // (Number.MAX_SAFE_INTEGER), which would otherwise show the user a nonsensical multi-quadrillion
  // notional and a wall of cap violations. Replace that with the real cause.
  if (estimatedNotional === Number.MAX_SAFE_INTEGER) {
    decision = {
      ...decision,
      approved: false,
      reasons: [
        `Couldn't get a current price for ${proposal.symbol} right now, so I can't size or risk-check this order. Try again in a moment, or specify a limit price.`
      ]
    };
    estimatedNotional = undefined;
  }

  // The commit-time preview runs WITHOUT a market scan, so the staleness gate (which treats a missing
  // quote/scan timestamp as stale) would fail closed on EVERY draft when maxQuoteAgeSec/
  // maxFundamentalsAgeSec are enabled. The authoritative gate re-runs at approve time against fresh
  // data, so a draft blocked ONLY by staleness is effectively stageable. Compute one effective decision
  // shared by BOTH the dry-run preview (which drives the assistant's Stage button) and the commit path,
  // so they agree — otherwise dry-run returns approved:false and the UI hides Stage even though the
  // commit path below would accept it. (Review: PR #278.)
  const blockingReasons = decision.reasons.filter((r) => !r.startsWith("staleness_gate:"));
  const stalenessOnly = !decision.approved && blockingReasons.length === 0;
  const effectiveDecision = stalenessOnly ? { ...decision, approved: true } : decision;

  // Escalation framework parity for assistant drafts: a draft refused ONLY for escalatable
  // reasons (e.g. an "ask"-mode wash-sale lock) is STAGEABLE — it becomes a pending-approval
  // card carrying the priced block reason, exactly like the run loop, instead of a 409. The
  // preview-spurious staleness failures are excluded from the determination the same way the
  // stalenessOnly carve-out excludes them (no market scan exists at preview time; the
  // authoritative gate re-runs at approve time). shouldEscalateDecision applies the authority
  // rules: ask-mode wash sales stage under BOTH authorities; time-context caps stage in
  // Decide mode only.
  const previewDecision: PolicyDecision = {
    ...decision,
    reasons: blockingReasons,
    escalations: (decision.escalations ?? []).filter((entry) => entry.kind !== "quote_staleness")
  };
  const escalatable = !effectiveDecision.approved && shouldEscalateDecision(previewDecision, policy);

  if (body.dryRun) {
    // `escalatable` is additive: consumers keying off decision.approved keep working; the
    // assistant UI uses it to offer Stage with a "needs your call" framing instead of a
    // plain block.
    return NextResponse.json({ dryRun: true, decision: effectiveDecision, estimatedNotional, proposal, escalatable });
  }

  // Commit: idempotent on the synthetic runId so one draft can't mint duplicate proposed rows. Dedupe
  // BEFORE the policy rejection below so a normal retry of an already-staged draft returns the existing
  // proposalId (200) rather than a 409 if the preview has since become blocked. (Review: PR #278.)
  const runId = `chat:${body.draft.draft_id}`;
  const existing = findProposedIdByRunId(runId, userId);
  if (existing) {
    return NextResponse.json({ proposalId: existing, deduped: true, decision: effectiveDecision, estimatedNotional, proposal }, { status: 200 });
  }

  if (!effectiveDecision.approved && !escalatable) {
    return NextResponse.json(
      { error: "POLICY_BLOCKED", reasons: blockingReasons, decision: effectiveDecision, estimatedNotional, proposal },
      { status: 409 }
    );
  }

  // Escalated staging mirrors the run loop exactly: server-minted override tokens are persisted
  // in the stored decision (never accepted from any client), and executeProposal re-runs the
  // FULL gate at confirm time — the wash-sale gate honors the stored token only while handling
  // is still ask/auto and the priced cost hasn't moved past tolerance.
  const storedDecision: PolicyDecision = escalatable
    ? {
        ...previewDecision,
        escalations: (previewDecision.escalations ?? []).map((entry) => ({ ...entry, token: crypto.randomUUID() }))
      }
    : decision;

  const proposalId = crypto.randomUUID();
  insertProposal({
    userId,
    id: proposalId,
    runId,
    accountNumber: policy.accountNumber,
    proposal,
    decision: storedDecision,
    review,
    estimatedNotional,
    status: "proposed",
    tradeThesisTag: proposal.tradeThesisTag,
    entryMarketRegime: proposal.entryMarketRegime,
    executionMode
  });
  if (escalatable) {
    audit(
      "proposal_escalated",
      {
        userId,
        proposalId,
        draftId: body.draft.draft_id,
        symbol: proposal.symbol,
        side: proposal.side,
        source: "chat",
        reasons: previewDecision.reasons,
        escalations: storedDecision.escalations,
        ...(previewDecision.washSale ? { washSale: previewDecision.washSale } : {})
      },
      userId
    );
  }
  audit("proposal_from_chat", { userId, proposalId, draftId: body.draft.draft_id, symbol: proposal.symbol, side: proposal.side, escalated: escalatable }, userId);
  emitDashboardEvent({ type: "proposal", userId, at: now.toISOString(), detail: { proposalId, status: "proposed", source: "chat" } });

  return NextResponse.json({ proposalId, decision: storedDecision, estimatedNotional, proposal, escalated: escalatable }, { status: 201 });
}
