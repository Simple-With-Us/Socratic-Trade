import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";

// Hoisted, overridable spy on retrieveLearnedContextDetailed (the "lessons" evidence-pack section).
// Defaults to the REAL implementation so every test except the dedicated resilience test below is
// unaffected; that test overrides it once with `mockImplementationOnce` to prove a single failing
// store never breaks the whole review.
const mockRetrieveLearnedContextDetailed = vi.fn();
vi.mock("../src/lib/learned-context/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/learned-context/store")>();
  mockRetrieveLearnedContextDetailed.mockImplementation(
    (...args: Parameters<typeof actual.retrieveLearnedContextDetailed>) => actual.retrieveLearnedContextDetailed(...args)
  );
  return { ...actual, retrieveLearnedContextDetailed: mockRetrieveLearnedContextDetailed };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tuning-reviews-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_URL;
});

function tuneRequest(email: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/strategy/tune", {
    method: "POST",
    headers: { "content-type": "application/json", "x-authenticated-user-email": email },
    body: JSON.stringify(body)
  });
}

function tuneGetRequest(email: string, connectedAccountId?: string): Request {
  const url = connectedAccountId
    ? `http://localhost/api/strategy/tune?connectedAccountId=${encodeURIComponent(connectedAccountId)}`
    : "http://localhost/api/strategy/tune";
  return new Request(url, { method: "GET", headers: { "x-authenticated-user-email": email } });
}

function tunePatchRequest(email: string, body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/strategy/tune", {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-authenticated-user-email": email },
    body: JSON.stringify(body)
  });
}

describe("db-tuning-reviews CRUD", () => {
  it("round-trips a review, auto-dismisses a prior open review on a new insert, and supports status transitions", async () => {
    const {
      insertStrategyTuningReview,
      getLatestOpenStrategyTuningReview,
      listStrategyTuningReviews,
      setStrategyTuningReviewStatus
    } = await import("../src/lib/db");

    const userId = `tune-review-crud-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;

    const firstId = insertStrategyTuningReview({
      userId,
      connectedAccountId: accountId,
      model: "openai/gpt-4.1-mini",
      reasoningEffort: "low",
      generatedBy: "local_rules",
      result: { summary: "First review", cautions: [] }
    });

    const latestAfterFirst = getLatestOpenStrategyTuningReview(userId, accountId);
    expect(latestAfterFirst?.id).toBe(firstId);
    expect(latestAfterFirst?.status).toBe("open");
    expect(latestAfterFirst?.result).toEqual({ summary: "First review", cautions: [] });

    // A second review for the SAME (user, account) supersedes the first: the first is auto-dismissed.
    const secondId = insertStrategyTuningReview({
      userId,
      connectedAccountId: accountId,
      model: "openai/gpt-4.1-mini",
      reasoningEffort: "low",
      generatedBy: "llm",
      result: { summary: "Second review", cautions: [] }
    });
    expect(secondId).not.toBe(firstId);

    const latestAfterSecond = getLatestOpenStrategyTuningReview(userId, accountId);
    expect(latestAfterSecond?.id).toBe(secondId);

    const all = listStrategyTuningReviews(userId, { connectedAccountId: accountId });
    expect(all).toHaveLength(2);
    const firstRow = all.find((r) => r.id === firstId);
    expect(firstRow?.status).toBe("dismissed");
    expect(firstRow?.resolvedAt).toBeTruthy();
    const secondRow = all.find((r) => r.id === secondId);
    expect(secondRow?.status).toBe("open");
    expect(secondRow?.resolvedAt).toBeUndefined();

    // Status transitions: applying the second review stamps resolved_at and flips status.
    const changed = setStrategyTuningReviewStatus(secondId, userId, "applied");
    expect(changed).toBe(true);
    const afterApply = listStrategyTuningReviews(userId, { connectedAccountId: accountId }).find((r) => r.id === secondId);
    expect(afterApply?.status).toBe("applied");
    expect(afterApply?.resolvedAt).toBeTruthy();
    // No review is 'open' anymore for this account.
    expect(getLatestOpenStrategyTuningReview(userId, accountId)).toBeUndefined();

    // A no-account (user-wide) slot is independent of an account-scoped slot: inserting one does
    // not disturb the account-scoped rows above, and `IS` matching means the two never collide.
    const noAccountId = insertStrategyTuningReview({
      userId,
      generatedBy: "local_rules",
      result: { summary: "No-account review", cautions: [] }
    });
    expect(getLatestOpenStrategyTuningReview(userId, undefined)?.id).toBe(noAccountId);
    expect(getLatestOpenStrategyTuningReview(userId, accountId)).toBeUndefined();
  });

  it("returns false from setStrategyTuningReviewStatus for an unknown id", async () => {
    const { setStrategyTuningReviewStatus } = await import("../src/lib/db");
    expect(setStrategyTuningReviewStatus(randomUUID(), `tune-review-unknown-${randomUUID()}`, "dismissed")).toBe(false);
  });

  it("isolates reviews across users: user B cannot read or patch user A's review", async () => {
    const { insertStrategyTuningReview, getLatestOpenStrategyTuningReview, listStrategyTuningReviews, setStrategyTuningReviewStatus } =
      await import("../src/lib/db");

    const userA = `tune-review-owner-${randomUUID()}`;
    const userB = `tune-review-other-${randomUUID()}`;
    const accountId = `acct-${randomUUID()}`;

    const reviewId = insertStrategyTuningReview({
      userId: userA,
      connectedAccountId: accountId,
      generatedBy: "local_rules",
      result: { summary: "Owner's review", cautions: [] }
    });

    // Cross-user reads never see the other user's review, even with the identical account id.
    expect(getLatestOpenStrategyTuningReview(userB, accountId)).toBeUndefined();
    expect(listStrategyTuningReviews(userB, { connectedAccountId: accountId })).toHaveLength(0);

    // Cross-user PATCH (status change) fails — ownership is enforced in the WHERE clause.
    const changed = setStrategyTuningReviewStatus(reviewId, userB, "dismissed");
    expect(changed).toBe(false);
    // The row is untouched: userA can still see it 'open'.
    expect(getLatestOpenStrategyTuningReview(userA, accountId)?.id).toBe(reviewId);
    expect(getLatestOpenStrategyTuningReview(userA, accountId)?.status).toBe("open");
  });
});

describe("/api/strategy/tune route: persistence, targeting, and lifecycle", () => {
  it("persists a review on POST (local-rules fallback, no OpenAI key) and returns a reviewId", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt, upsertConnectedAccount, setActiveConnectedAccount, getLatestOpenStrategyTuningReview } =
      await import("../src/lib/db");
    const { POST } = await import("../app/api/strategy/tune/route");

    delete process.env.OPENROUTER_API_KEY;
    const email = `tune-route-post-${randomUUID()}@example.com`;
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountId = `acct-${randomUUID()}`;

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-ROUTE-POST",
      label: "Route Post Account",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("ROUTE POST STRATEGY", userId, accountId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-ROUTE-POST", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } }, userId, accountId);
    insertFillEvent({
      userId,
      accountNumber: "TUNE-ROUTE-POST",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });

    const response = await POST(tuneRequest(email, {}));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.generatedBy).toBe("local_rules");
    expect(typeof payload.reviewId).toBe("string");

    const stored = getLatestOpenStrategyTuningReview(userId, accountId);
    expect(stored?.id).toBe(payload.reviewId);
    expect(stored?.status).toBe("open");
    expect((stored?.result as { summary?: string })?.summary).toBe(payload.summary);
  });

  it("rejects a targetConnectedAccountId not owned by the request user, without creating a review", async () => {
    const { upsertConnectedAccount, listStrategyTuningReviews } = await import("../src/lib/db");
    const { POST } = await import("../app/api/strategy/tune/route");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");

    const ownerEmail = `tune-target-owner-${randomUUID()}@example.com`;
    const attackerEmail = `tune-target-attacker-${randomUUID()}@example.com`;
    const ownerId = resolveRequestUserFromEmail(ownerEmail).userId;
    const attackerId = resolveRequestUserFromEmail(attackerEmail).userId;
    const ownerAccount = `owned-${randomUUID()}`;

    upsertConnectedAccount({
      id: ownerAccount,
      userId: ownerId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-TARGET-OWNED",
      label: "Owned",
      isActive: true
    });

    const response = await POST(tuneRequest(attackerEmail, { targetConnectedAccountId: ownerAccount }));
    expect(response.status).toBe(404);
    expect(listStrategyTuningReviews(attackerId)).toHaveLength(0);
    expect(listStrategyTuningReviews(ownerId, { connectedAccountId: ownerAccount })).toHaveLength(0);
  });

  it("pins the review to an explicit targetConnectedAccountId distinct from the active account", async () => {
    const { insertFillEvent, setPolicy, setStrategyPrompt, upsertConnectedAccount, getLatestOpenStrategyTuningReview } =
      await import("../src/lib/db");
    const { POST } = await import("../app/api/strategy/tune/route");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");

    const email = `tune-target-pin-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const activeAccount = `active-${randomUUID()}`;
    const targetAccount = `target-${randomUUID()}`;

    upsertConnectedAccount({
      id: activeAccount,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-PIN-ACTIVE",
      label: "Active (should NOT be reviewed)",
      isActive: true
    });
    upsertConnectedAccount({
      id: targetAccount,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-PIN-TARGET",
      label: "Target (should be reviewed)",
      isActive: false
    });
    setStrategyPrompt("TARGET STRATEGY", userId, targetAccount);
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "TUNE-PIN-TARGET", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } }, userId, targetAccount);
    insertFillEvent({
      userId,
      accountNumber: "TUNE-PIN-TARGET",
      source: "paper",
      symbol: "MSFT",
      side: "buy",
      quantity: 1,
      price: 200,
      notional: 200,
      status: "filled"
    });

    const response = await POST(tuneRequest(email, { targetConnectedAccountId: targetAccount }));
    expect(response.status).toBe(200);
    const payload = await response.json();

    // The persisted review is attributed to the TARGET account, not the (still) active one.
    const storedForTarget = getLatestOpenStrategyTuningReview(userId, targetAccount);
    expect(storedForTarget?.id).toBe(payload.reviewId);
    expect(getLatestOpenStrategyTuningReview(userId, activeAccount)).toBeUndefined();
  });

  it("GET returns the latest open review for the active account and null when there is none", async () => {
    const { upsertConnectedAccount, setActiveConnectedAccount, insertStrategyTuningReview } = await import("../src/lib/db");
    const { GET } = await import("../app/api/strategy/tune/route");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");

    const email = `tune-route-get-${randomUUID()}@example.com`;
    const userId = resolveRequestUserFromEmail(email).userId;
    const accountId = `acct-${randomUUID()}`;

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TUNE-ROUTE-GET",
      label: "Route Get Account",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);

    const emptyResponse = await GET(tuneGetRequest(email));
    expect((await emptyResponse.json()).review).toBeNull();

    const reviewId = insertStrategyTuningReview({
      userId,
      connectedAccountId: accountId,
      model: "openai/gpt-4.1-mini",
      reasoningEffort: "low",
      generatedBy: "llm",
      result: { summary: "GET me", cautions: [], generatedBy: "llm" }
    });

    const filledResponse = await GET(tuneGetRequest(email));
    const filledPayload = await filledResponse.json();
    expect(filledPayload.review.id).toBe(reviewId);
    expect(filledPayload.review.status).toBe("open");
    expect(filledPayload.review.generatedBy).toBe("llm");
    expect(filledPayload.review.result.summary).toBe("GET me");

    // Explicit connectedAccountId not owned by this user -> 404.
    const notOwned = await GET(tuneGetRequest(email, `not-owned-${randomUUID()}`));
    expect(notOwned.status).toBe(404);
  });

  it("PATCH marks a review applied/dismissed and 404s for an unknown or unowned review", async () => {
    const { insertStrategyTuningReview, getLatestOpenStrategyTuningReview } = await import("../src/lib/db");
    const { PATCH } = await import("../app/api/strategy/tune/route");
    const { resolveRequestUserFromEmail } = await import("../src/lib/request-user");

    const ownerEmail = `tune-patch-owner-${randomUUID()}@example.com`;
    const attackerEmail = `tune-patch-attacker-${randomUUID()}@example.com`;
    const ownerId = resolveRequestUserFromEmail(ownerEmail).userId;
    const accountId = `acct-${randomUUID()}`;

    const reviewId = insertStrategyTuningReview({
      userId: ownerId,
      connectedAccountId: accountId,
      generatedBy: "local_rules",
      result: { summary: "Patch me", cautions: [] }
    });

    // A different user cannot resolve the owner's review.
    const attackerAttempt = await PATCH(tunePatchRequest(attackerEmail, { reviewId, status: "dismissed" }));
    expect(attackerAttempt.status).toBe(404);
    expect(getLatestOpenStrategyTuningReview(ownerId, accountId)?.status).toBe("open");

    // The owner can apply it.
    const ownerAttempt = await PATCH(tunePatchRequest(ownerEmail, { reviewId, status: "applied" }));
    expect(ownerAttempt.status).toBe(200);
    expect((await ownerAttempt.json()).ok).toBe(true);
    expect(getLatestOpenStrategyTuningReview(ownerId, accountId)).toBeUndefined();

    // An unknown reviewId 404s.
    const unknown = await PATCH(tunePatchRequest(ownerEmail, { reviewId: randomUUID(), status: "dismissed" }));
    expect(unknown.status).toBe(404);

    // A malformed status is rejected with 400.
    const badStatus = await PATCH(tunePatchRequest(ownerEmail, { reviewId, status: "bogus" }));
    expect(badStatus.status).toBe(400);
  });
});

describe("proposeStrategyTuning evidence-pack widening", () => {
  it("includes account-scoped lessons, reflection, decision memory, scorecards, learning mutations, and regime context", async () => {
    const {
      insertFillEvent,
      insertLearnedContext,
      insertLearningMutation,
      setActiveConnectedAccount,
      setPolicy,
      setStrategyPrompt,
      setUserSetting,
      upsertConnectedAccount,
      upsertSocraticDecisionCase,
      audit
    } = await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    const userId = `tune-evidence-${randomUUID()}`;
    const accountId = randomUUID();
    const otherAccountId = randomUUID();
    const accountNumber = "TUNE-EVIDENCE";
    const otherAccountNumber = "TUNE-EVIDENCE-OTHER";

    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.OPENROUTER_API_URL = "https://openrouter.ai/v1/responses";

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber,
      label: "Evidence Account",
      isActive: true
    });
    upsertConnectedAccount({
      id: otherAccountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: otherAccountNumber,
      label: "Other Account",
      isActive: false
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("EVIDENCE STRATEGY", userId, accountId);
    setPolicy(
      { ...DEFAULT_POLICY, accountNumber, llmModel: "openai/gpt-4.1-mini", scoringWeights: { ...DEFAULT_POLICY.scoringWeights } },
      userId,
      accountId
    );

    // Reviewed account: one closed lot tagged with thesis/sector/regime metadata so
    // thesisScorecard/sectorScorecard/reflection.thesisOutcomes/regimeOutcomes and the current
    // regime label all have real data to surface.
    const raw = { sector: "Technology", proposal: { tradeThesisTag: "MeanReversion", entryMarketRegime: "Calm" } };
    insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 100,
      notional: 1000,
      status: "filled",
      raw,
      filledAt: "2026-06-01T00:00:00.000Z"
    });
    insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 110,
      notional: 1100,
      status: "filled",
      raw,
      filledAt: "2026-06-02T00:00:00.000Z"
    });

    // Other connected account: distinct realized performance so crossAccountPerformance has a row.
    insertFillEvent({
      userId,
      accountNumber: otherAccountNumber,
      source: "paper",
      symbol: "MSFT",
      side: "buy",
      quantity: 5,
      price: 50,
      notional: 250,
      status: "filled",
      filledAt: "2026-06-01T00:00:00.000Z"
    });
    insertFillEvent({
      userId,
      accountNumber: otherAccountNumber,
      source: "paper",
      symbol: "MSFT",
      side: "sell",
      quantity: 5,
      price: 40,
      notional: 200,
      status: "filled",
      filledAt: "2026-06-02T00:00:00.000Z"
    });

    // Post-mortem reflection summary (account-scoped user_settings key).
    setUserSetting(userId, `reflection_summary:${accountNumber}`, "Cut winners too early on mean-reversion setups.", {
      auditPolicyChange: false
    });

    // A global (symbol-less) learned-context fact.
    insertLearnedContext({
      id: randomUUID(),
      userId,
      scope: "private",
      kind: "pattern",
      subject: "sizing discipline",
      symbol: null,
      value: "Reduce size after three consecutive losses.",
      source: "inferred",
      origin: "autonomous",
      riskTier: "fact",
      confidence: 0.72,
      contributorUserId: userId,
      connectedAccountId: accountId,
      accountEnvironment: "paper",
      learningScope: "account",
      transferState: "candidate",
      assertedAt: new Date().toISOString(),
      supersededBy: null,
      expiresAt: null
    });

    // Exact-account Socratic decision memory; sibling-account outcomes must not enter this review.
    upsertSocraticDecisionCase({
      userId,
      connectedAccountId: accountId,
      symbol: "NVDA",
      status: "placed",
      authority: "propose",
      thesis: "A".repeat(250),
      rationale: "Momentum plus strong guidance.",
      action: "BUY NVDA $500",
      outcome: { status: "won", returnPct: 8.4, outcomes: [] },
      lessons: ["Scale in over two days next time."]
    });

    // A recent learning-ledger mutation (last 30 days).
    insertLearningMutation({
      userId,
      connectedAccountId: accountId,
      subsystem: "scoring_weights",
      trigger: "auto_weight_apply",
      beforeState: { scoringWeights: { momentum: 1 } },
      afterState: { scoringWeights: { momentum: 1.05 } },
      evidence: { note: "test seed" }
    });

    // A regime-flip audit event.
    audit("regime_flip", { from: "Calm", to: "Risk-Off", vix: 32, escalation: true }, userId);

    let capturedContext: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      capturedContext = JSON.parse(body.input.find((item: { role?: string }) => item.role === "user")?.content ?? "{}");
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "Evidence-informed tuning",
            rationale: "Grounded in cross-account and global-learning evidence.",
            marketContext: "Macro is stable.",
            performanceReadout: "Reviewed account is modestly profitable.",
            proposedPrompt: "EVIDENCE STRATEGY",
            scoringWeights: {
              liquidity: null,
              momentum: null,
              value: null,
              quality: null,
              volatility: null,
              sentiment: null,
              positioning: null,
              diversification: null
            },
            policy: {
              maxOrderNotional: null,
              maxDailyNotional: null,
              maxSymbolExposurePct: null,
              maxDailyOrders: null,
              maxProposalsPerRun: null,
              runCadenceMinutes: null,
              strategyAuthority: null,
              runDuringExtendedHours: null
            },
            riskRules: { stopLossPct: null, takeProfitPct: null, trailingStopPct: null },
            cautions: [],
            confidenceScore: 60
          })
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const proposal = await proposeStrategyTuning(userId, undefined, undefined, accountId);
    expect(proposal.generatedBy).toBe("llm");
    expect(capturedContext).toBeDefined();

    // lessons
    expect(Array.isArray(capturedContext?.lessons)).toBe(true);
    const lessons = capturedContext?.lessons as Array<{ subject: string; text: string; confidence?: number }>;
    expect(lessons.some((l) => l.text.includes("Reduce size after three consecutive losses"))).toBe(true);

    // reflection (summary + thesis/regime outcome rows)
    const reflection = capturedContext?.reflection as { summary?: string; thesisOutcomes?: unknown[]; regimeOutcomes?: unknown[] };
    expect(reflection?.summary).toBe("Cut winners too early on mean-reversion setups.");
    // Thesis rows are deliberately NOT duplicated into the reflection section — they ship once,
    // in the thesisScorecard section asserted below (review dedupe fix).
    expect((reflection as Record<string, unknown> | undefined)?.thesisOutcomes).toBeUndefined();
    expect(reflection?.regimeOutcomes?.length).toBeGreaterThan(0);

    // decisionMemory (exact account, thesis truncated, outcome/lessons compact)
    const decisionMemory = capturedContext?.decisionMemory as Array<{ symbol?: string; outcome?: string; lessons?: string[] }>;
    expect(decisionMemory.some((d) => d.symbol === "NVDA")).toBe(true);
    const nvda = decisionMemory.find((d) => d.symbol === "NVDA");
    expect(nvda?.outcome).toContain("won");
    expect(nvda?.lessons?.[0]).toBe("Scale in over two days next time.");

    // thesisScorecard / sectorScorecard for the REVIEWED account
    const thesisScorecard = capturedContext?.thesisScorecard as Array<{ thesisTag: string }>;
    expect(thesisScorecard.some((t) => t.thesisTag === "MeanReversion")).toBe(true);
    const sectorScorecard = capturedContext?.sectorScorecard as Array<{ sector: string }>;
    expect(sectorScorecard.some((s) => s.sector === "Technology")).toBe(true);

    // Sibling-account performance is intentionally excluded unless separately transfer-validated.
    expect(capturedContext?.crossAccountPerformance).toBeUndefined();

    // learningMutations
    const learningMutations = capturedContext?.learningMutations as Array<{ subsystem: string }>;
    expect(learningMutations.some((m) => m.subsystem === "scoring_weights")).toBe(true);

    // regime: current label derived from the closed lot's stamped regime, plus the recent flip
    const regime = capturedContext?.regime as { current?: string; recentFlips?: Array<{ from?: string; to?: string }> };
    expect(regime?.current).toBe("Calm");
    expect(regime?.recentFlips?.some((f) => f.from === "Calm" && f.to === "Risk-Off")).toBe(true);
  });

  it("omits a section whose backing store throws, without failing the whole review", async () => {
    const { insertFillEvent, setActiveConnectedAccount, setPolicy, setStrategyPrompt, upsertConnectedAccount, upsertSocraticDecisionCase } =
      await import("../src/lib/db");
    const { proposeStrategyTuning } = await import("../src/lib/strategy-tuning");

    const userId = `tune-evidence-resilience-${randomUUID()}`;
    const accountId = randomUUID();
    const accountNumber = "TUNE-RESILIENCE";

    delete process.env.OPENROUTER_API_KEY;

    upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber,
      label: "Resilience Account",
      isActive: true
    });
    setActiveConnectedAccount(accountId, userId);
    setStrategyPrompt("RESILIENCE STRATEGY", userId, accountId);
    setPolicy({ ...DEFAULT_POLICY, accountNumber, scoringWeights: { ...DEFAULT_POLICY.scoringWeights } }, userId, accountId);
    insertFillEvent({
      userId,
      accountNumber,
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled"
    });
    upsertSocraticDecisionCase({
      userId,
      connectedAccountId: accountId,
      symbol: "NVDA",
      status: "placed",
      authority: "propose",
      thesis: "Should still show up even when lessons blows up.",
      rationale: "Momentum.",
      action: "BUY NVDA $100"
    });

    // Force the "lessons" store to throw for this one call.
    mockRetrieveLearnedContextDetailed.mockImplementationOnce(() => {
      throw new Error("learned-context store unavailable (simulated)");
    });

    // No OpenAI key configured -> local-rules path; the widened context is still built (and would be
    // sent verbatim if an LLM call were made), so this exercises the same try/catch-guarded code.
    const proposal = await proposeStrategyTuning(userId, undefined, undefined, accountId);
    expect(proposal.generatedBy).toBe("local_rules");
    expect(proposal.summary).toBeTruthy();
    expect(mockRetrieveLearnedContextDetailed).toHaveBeenCalled();
  });
});
