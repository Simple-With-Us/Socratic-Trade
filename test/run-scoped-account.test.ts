// Run-scoped account resolution (cluster `run-scoped-account`, finding llm-agent-architecture:llm-02).
//
// The bug these pin: code running INSIDE a strategy run re-resolved "the account" by asking which
// account is currently ACTIVE in the console, instead of using the account the run is actually
// trading (`policy.connectedAccountId`). With two accounts connected, the adversarial review of an
// opening for account B was computed against account A's venue capabilities, execution mode and
// custom strategy prompt — and switching the active account mid-run silently moved the answer.
//
// Every case here connects TWO accounts and makes the NON-ACTIVE one the account under review, so a
// resolution that reaches for "active" lands on the wrong account and the assertion fails.

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-run-scoped-account-${randomUUID()}.db`)}`;
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const shortProposal = (): any => ({
  symbol: "AAPL",
  side: "short",
  type: "market",
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "extended into resistance",
  confidenceScore: 80,
  tradeThesisTag: "mean-reversion",
  entryMarketRegime: "risk-off"
});

const buyProposal = (): any => ({ ...shortProposal(), side: "buy", rationale: "momentum" });

/**
 * Two connected accounts for one user.
 *   A — ACTIVE, eToro, LIVE. eToro's venue profile hard-forbids shorting, so a review that resolves
 *       A refuses a short outright, and its execution mode is "broker/live".
 *   B — NOT active, Alpaca, PAPER, short-capable. This is the account the run is trading.
 * Each carries its own strategy prompt. A's prompt is written LAST so the user-level fallback also
 * holds A's text — a read that misses the account scope entirely still lands on A, not B.
 */
async function connectTwoAccounts(slug: string) {
  const db = await import("../src/lib/db");
  const { emptyCapabilities } = await import("../src/lib/venue-contract");
  const { userIdForEmail } = await import("../src/lib/auth/identity");
  const userId = userIdForEmail(`${slug}-${randomUUID()}@example.com`);
  const accountA = `active-a-${randomUUID()}`;
  const accountB = `run-b-${randomUUID()}`;

  db.upsertConnectedAccount({
    id: accountA,
    userId,
    broker: "etoro",
    environment: "live",
    accountNumber: "ACTIVE-A",
    label: "Account A",
    isActive: true
  });
  db.upsertConnectedAccount({
    id: accountB,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: "RUN-B",
    label: "Account B",
    isActive: false,
    capabilities: emptyCapabilities({ shortSelling: true })
  });

  db.setStrategyPrompt("PROMPT FOR ACCOUNT B", userId, accountB);
  db.setStrategyPrompt("PROMPT FOR ACCOUNT A", userId, accountA);

  return { db, userId, accountA, accountB };
}

/** Captures the single outbound LLM request body so the review's inputs can be inspected. */
function captureRedTeamRequest(verdict = { verdict: "approve", reason: "fine" }) {
  const calls: any[] = [];
  vi.stubGlobal("fetch", async (_url: any, init: any) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  return calls;
}

/** The reviewer's user payload is the JSON `content` of the last (non-system) message. */
function reviewPayload(body: any): any {
  const messages: any[] = body.messages ?? [];
  const user = [...messages].reverse().find((m) => m.role === "user");
  return JSON.parse(String(user?.content ?? "{}"));
}

describe("Red Team review is scoped to the run's account, not the console-active account", () => {
  it("reviews a short for the non-active, short-capable account instead of refusing on the active account's venue", async () => {
    const { db, userId, accountB } = await connectTwoAccounts("redteam-venue");
    db.upsertUserApiKey(userId, "openrouter", "test-openrouter-key");
    const { debateProposal } = await import("../src/lib/red-team");

    // Exactly what the strategy loop hands the reviewer: the run-scoped policy for account B.
    const runPolicy = {
      ...db.getPolicy(userId, accountB),
      shortSellingEnabled: true,
      redTeamLlmModel: "openai/gpt-4.1-mini"
    };
    expect(runPolicy.connectedAccountId).toBe(accountB);

    const calls = captureRedTeamRequest();
    const result = await debateProposal(shortProposal(), undefined, userId, runPolicy);

    // Account B can short. The active account (eToro) cannot — resolving it refuses the opening
    // outright, without ever calling the reviewer.
    expect(result.reason).not.toMatch(/cannot short/i);
    expect(calls.length).toBe(1);
    expect(result.available).toBe(true);
    expect(result.verdict).toBe("approve");
  });

  it("builds the review from the run account's execution mode and strategy prompt", async () => {
    const { db, userId, accountA, accountB } = await connectTwoAccounts("redteam-inputs");
    db.upsertUserApiKey(userId, "openrouter", "test-openrouter-key");
    const { debateProposal } = await import("../src/lib/red-team");

    const runPolicy = { ...db.getPolicy(userId, accountB), redTeamLlmModel: "openai/gpt-4.1-mini" };
    const calls = captureRedTeamRequest();
    await debateProposal(buyProposal(), undefined, userId, runPolicy);

    expect(calls.length).toBe(1);
    const payload = reviewPayload(calls[0]);
    // Account B is the paper account; account A (active) is live.
    expect(payload.policy.executionMode).toBe("broker/paper");
    expect(payload.strategyPrompt).toContain("PROMPT FOR ACCOUNT B");
    expect(payload.strategyPrompt).not.toContain("PROMPT FOR ACCOUNT A");
    // The active pointer is untouched — the run simply never consulted it.
    expect(db.getActiveConnectedAccount(userId)?.id).toBe(accountA);
  });

  it("keeps a review pinned to its account when the active account is switched mid-run", async () => {
    const { db, userId, accountA, accountB } = await connectTwoAccounts("redteam-switch");
    db.upsertUserApiKey(userId, "openrouter", "test-openrouter-key");
    const { debateProposal } = await import("../src/lib/red-team");

    // The run resolved its policy for account B. A is the console-active account.
    const runPolicy = { ...db.getPolicy(userId, accountB), redTeamLlmModel: "openai/gpt-4.1-mini" };
    // The owner moves the console pointer around mid-run, between openings, and leaves it on A.
    // The review below belongs to B and must not notice any of this.
    db.setActiveConnectedAccount(accountB, userId);
    db.setActiveConnectedAccount(accountA, userId);

    const calls = captureRedTeamRequest();
    await debateProposal(buyProposal(), undefined, userId, runPolicy);

    const payload = reviewPayload(calls[0]);
    expect(payload.policy.executionMode).toBe("broker/paper");
    expect(payload.strategyPrompt).toContain("PROMPT FOR ACCOUNT B");
  });
});

describe("resolveRunAccountScope", () => {
  it("resolves the policy's account and that same account's prompt", async () => {
    const { userId, accountB } = await connectTwoAccounts("scope-run");
    const { resolveRunAccountScope } = await import("../src/lib/run-account-scope");

    const scope = resolveRunAccountScope(userId, { connectedAccountId: accountB });
    expect(scope.source).toBe("run");
    expect(scope.account?.id).toBe(accountB);
    expect(scope.strategyPrompt).toContain("PROMPT FOR ACCOUNT B");
  });

  it("falls back to the active account ONLY when the policy carries no run scope", async () => {
    const { userId, accountA } = await connectTwoAccounts("scope-console");
    const { resolveRunAccountScope } = await import("../src/lib/run-account-scope");

    const scope = resolveRunAccountScope(userId, { connectedAccountId: undefined });
    expect(scope.source).toBe("active");
    expect(scope.account?.id).toBe(accountA);
    expect(scope.strategyPrompt).toContain("PROMPT FOR ACCOUNT A");
  });

  it("resolves to no account — never a substitute — when the run's account is gone", async () => {
    const { db, userId, accountB } = await connectTwoAccounts("scope-deleted");
    const { resolveRunAccountScope } = await import("../src/lib/run-account-scope");

    db.purgeConnectedAccount(accountB, userId);
    const scope = resolveRunAccountScope(userId, { connectedAccountId: accountB });
    expect(scope.source).toBe("none");
    expect(scope.account).toBeUndefined();
    expect(scope.connectedAccountId).toBeUndefined();
  });
});

describe("Retrying Red Team re-reviews the proposal's own account", () => {
  it("uses the proposal's account policy even when a different account is selected", async () => {
    const { db, userId, accountA, accountB } = await connectTwoAccounts("retry");
    db.upsertUserApiKey(userId, "openrouter", "test-openrouter-key");
    const { retryProposalRedTeam } = await import("../src/lib/retry-red-team");

    // Account B's own reviewer model — the tell that the retry read B's policy, not A's.
    db.setPolicy({ ...db.getPolicy(userId, accountB), redTeamLlmModel: "openai/gpt-b-reviewer" }, userId, accountB);
    db.setPolicy({ ...db.getPolicy(userId, accountA), redTeamLlmModel: "openai/gpt-a-reviewer" }, userId, accountA);
    expect(db.getActiveConnectedAccount(userId)?.id).toBe(accountA);

    const proposalId = `p-${randomUUID()}`;
    db.insertProposal({
      id: proposalId,
      runId: `r-${randomUUID()}`,
      accountNumber: "RUN-B",
      userId,
      status: "proposed",
      estimatedNotional: 25,
      proposal: {
        symbol: "T",
        side: "buy",
        type: "market",
        quantity: 1,
        timeInForce: "day",
        rationale: "retry me",
        tradeThesisTag: "Sector-Relative-Strength",
        entryMarketRegime: "Neutral"
      },
      decision: { approved: true, reasons: [] }
    });

    const calls = captureRedTeamRequest();
    await retryProposalRedTeam(proposalId, userId);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].model).toBe("openai/gpt-b-reviewer");
    const payload = reviewPayload(calls[0]);
    expect(payload.policy.executionMode).toBe("broker/paper");
    expect(payload.strategyPrompt).toContain("PROMPT FOR ACCOUNT B");
  });
});

describe("An approved strategy directive lands on the account it was queued for", () => {
  it("appends the AI-LEARNED block to the pending row's account, not the active one", async () => {
    const db = await import("../src/lib/db");
    const { applyApprovedPending } = await import("../src/lib/learned-context/store");
    const { userId, accountA, accountB } = await connectTwoAccounts("directive");

    const directive = "Prefer momentum names in risk-on regimes and trim into euphoria.";
    const pendingId = randomUUID();
    db.insertPendingLearnedContext({
      id: pendingId,
      userId,
      scope: "private",
      kind: "decision",
      subject: "strategy directive",
      symbol: null,
      value: directive,
      source: "inferred",
      origin: "autonomous",
      riskTier: "strategy-directive",
      // Queued by a run trading account B, while the console still points at account A.
      connectedAccountId: accountB,
      accountEnvironment: "paper",
      learningScope: "portfolio",
      transferState: "not_applicable",
      classifierReason: "producer-tagged strategy-directive; queued for human confirmation",
      createdAt: new Date().toISOString(),
      status: "pending",
      resolvedAt: null
    });

    const pending = db.getPendingLearnedContext(pendingId, userId);
    expect(pending?.connectedAccountId).toBe(accountB);
    applyApprovedPending(pending!);

    const promptB = db.getStrategyPrompt(userId, accountB);
    const promptA = db.getStrategyPrompt(userId, accountA);
    expect(promptB).toContain(`<!-- AI-LEARNED ${pendingId}`);
    expect(promptB).toContain(directive);
    expect(promptB).toContain("PROMPT FOR ACCOUNT B");
    expect(promptA).not.toContain(`<!-- AI-LEARNED ${pendingId}`);
    expect(promptA).not.toContain(directive);
  });
});
