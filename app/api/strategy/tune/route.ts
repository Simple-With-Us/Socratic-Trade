import { proposeStrategyTuning } from "@/lib/strategy-tuning";
import { validateTuningInvariants } from "@/lib/tuning-invariants";
import {
  getActiveConnectedAccount,
  getConnectedAccount,
  getLatestOpenStrategyTuningReview,
  getPolicy,
  insertStrategyTuningReview,
  setStrategyTuningReviewStatus
} from "@/lib/db";
import { ALL_LLM_REASONING_EFFORTS } from "@/lib/llm-request";
import type { LlmReasoningEffort } from "@/lib/types";
import { resolveRequestUserId } from "@/lib/request-user";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { withTuningSingleFlight } from "@/lib/tuning-singleflight";
import { rateLimitedOperationResponse } from "@/lib/operation-guard-response";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const reasoningEffort: LlmReasoningEffort | undefined =
      ALL_LLM_REASONING_EFFORTS.includes(body?.reasoningEffort) ? body.reasoningEffort : undefined;
    const userId = resolveRequestUserId(request);

    // P0 fix: pin the ACCOUNT being reviewed. Without this, proposeStrategyTuning silently fell back
    // to the global is_active connected account, which can differ from the account the user was
    // viewing — misattributing the llm_usage cost row and the whole evidence pack to the wrong
    // account. Backward compatible: omitted => current (active-account) behavior. Ownership is
    // verified the same way app/api/policy/route.ts validates targetConnectedAccountId.
    const rawTarget = body?.targetConnectedAccountId;
    if (rawTarget !== undefined && (typeof rawTarget !== "string" || rawTarget.trim().length === 0)) {
      return NextResponse.json({ error: "targetConnectedAccountId must be a non-empty string." }, { status: 400 });
    }
    const explicitTarget = typeof rawTarget === "string" ? rawTarget.trim() : undefined;
    if (explicitTarget && !getConnectedAccount(explicitTarget, userId)) {
      return NextResponse.json({ error: "The target connected account was not found." }, { status: 404 });
    }

    // Claim before quota debit: overlapping clicks return 409 without exhausting the accepted
    // review's allowance; the claim and rate decision both complete before the paid LLM call.
    return withTuningSingleFlight(userId, "strategy-tune", async () => {
      const admission = rateLimit(`${userId}:strategy/tune`, RATE_LIMITS.strategyTuning);
      if (!admission.allowed) {
        return rateLimitedOperationResponse("strategy-tune", admission.retryAfterSeconds);
      }
      // Resolve the ACTUAL account this proposal is generated for up front (explicit target, or the
      // active connected account proposeStrategyTuning would otherwise fall back to internally) so
      // the persisted review is attributed to the same account regardless of which path was taken.
      const resolvedAccountId = explicitTarget ?? getPolicy(userId, explicitTarget).connectedAccountId;
      const proposal = await proposeStrategyTuning(userId, model, reasoningEffort, explicitTarget);
      // P0-3: in the MANUAL path, tuning-config invariant violations are surfaced as WARNINGS (never blocks) —
      // the human reviews them alongside the proposal. (The AUTONOMOUS path fails closed on the same set.)
      // The dashboard renders `proposal.cautions`, so APPEND the warnings there (with a clear prefix) so manual
      // users actually SEE them; also keep the structured `tuningConfigWarnings` field for programmatic callers.
      const invariants = validateTuningInvariants(getPolicy(userId, resolvedAccountId).tuning);
      const responseBody = invariants.ok
        ? proposal
        : {
            ...proposal,
            cautions: [...(proposal.cautions ?? []), ...invariants.violations.map((v) => `Tuning-config warning: ${v.message}`)],
            tuningConfigWarnings: invariants.violations
          };
      // Persist the review server-side (survives a disconnect before Apply) — store the FULL
      // response JSON, including any appended tuning-invariant warnings. A newer review for the
      // same (user, account) auto-dismisses any still-open prior one.
      const reviewId = insertStrategyTuningReview({
        userId,
        connectedAccountId: resolvedAccountId,
        model,
        reasoningEffort,
        generatedBy: proposal.generatedBy,
        result: responseBody
      });
      return NextResponse.json({ ...responseBody, reviewId });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Strategy tuning failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const userId = resolveRequestUserId(request);
  const url = new URL(request.url);
  const rawAccountId = url.searchParams.get("connectedAccountId")?.trim();
  const explicitAccountId = rawAccountId ? rawAccountId : undefined;
  if (explicitAccountId && !getConnectedAccount(explicitAccountId, userId)) {
    return NextResponse.json({ error: "The target connected account was not found." }, { status: 404 });
  }
  // Same default as POST: omitted => the user's active connected account (not literally "no
  // account"), so a client that doesn't pass connectedAccountId still gets the review it just
  // created for its active account.
  const resolvedAccountId = explicitAccountId ?? getActiveConnectedAccount(userId)?.id;
  const row = getLatestOpenStrategyTuningReview(userId, resolvedAccountId);
  if (!row) return NextResponse.json({ review: null });
  return NextResponse.json({
    review: {
      id: row.id,
      createdAt: row.createdAt,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      generatedBy: row.generatedBy,
      status: row.status,
      result: row.result
    }
  });
}

export async function PATCH(request: Request) {
  const userId = resolveRequestUserId(request);
  const body = await request.json().catch(() => ({}));
  const reviewId = typeof body?.reviewId === "string" ? body.reviewId.trim() : "";
  const status = body?.status;
  if (!reviewId || (status !== "applied" && status !== "dismissed")) {
    return NextResponse.json({ error: "reviewId and status ('applied' or 'dismissed') are required." }, { status: 400 });
  }
  const changed = setStrategyTuningReviewStatus(reviewId, userId, status);
  if (!changed) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
