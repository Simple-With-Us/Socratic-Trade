/**
 * Performance-refactor guardrails for getDashboardSnapshot (audit Chat E, items 1 & 2):
 *  - Item 1: live + paper fills are fetched EXACTLY ONCE per request and threaded into every
 *    consumer, instead of the old 9+ redundant listFillEvents replays.
 *  - Item 2: proposal point-queries are BATCHED — the audit/unified-feed builders resolve every
 *    referenced proposalId through a single getProposalsByIds(...) call, not one getProposal per row.
 *
 * These assert call counts via spies; the surrounding snapshot output is covered by the existing
 * dashboard/performance/tax suites (which still pass unchanged).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";

// Keep the snapshot's best-effort macro / market-signal / benchmark fan-out off the network so the
// test is fast and deterministic; none of it touches the fill/proposal batching under test.
vi.mock("../src/lib/macro", () => ({
  fetchMacroData: vi.fn(async () => ({})),
  determineMarketRegime: vi.fn(() => "Unknown")
}));
vi.mock("../src/lib/macro-metrics", () => ({ deriveMacroMetrics: vi.fn(() => ({})) }));
vi.mock("../src/lib/macro-history", () => ({ fetchMacroHistory: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals", () => ({ getMarketSignals: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals/massive", () => ({ fetchMassiveNews: vi.fn(async () => []) }));
vi.mock("../src/lib/market-internals", () => ({ computeMarketInternals: vi.fn(() => ({ medianEarnYld: undefined })) }));
vi.mock("../src/lib/benchmark", () => ({
  computeSpyBenchmark: vi.fn(async () => null),
  computeSpyBenchmarkDetailed: vi.fn(async () => ({ comparison: null }))
}));
vi.mock("../src/lib/web-sources", () => ({
  getCongressDataset: vi.fn(() => undefined),
  getInsiderDataset: vi.fn(() => undefined),
  getWebSourcesStatus: vi.fn(() => ({}))
}));

// Stub the broker gateway so its OWN portfolio math (the Test gateway replays fills internally via
// getPerformanceSummary/getOpenLots — a separate consumer in robinhood.ts, not one of the dashboard
// consumers item 1 collapses) doesn't add fill fetches. This isolates the dashboard body's direct
// fill usage, which is exactly what item 1 refactored to a single live + single paper fetch.
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "TEST", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return { accountNumber: "TEST", totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
    },
    async getEquityPositions() {
      return [];
    },
    async getEquityOrders() {
      return [];
    },
    async getEquityQuotes() {
      return {};
    }
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-batch-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // C1 snapshot TTL would otherwise collapse a second getDashboardSnapshot into a cache hit
  // and under-count fill/proposal calls in call-count assertions.
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("getDashboardSnapshot fill/proposal batching", () => {
  it("fetches live + paper fills exactly once each, and batches proposal lookups", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-batch-${randomUUID()}`;

    // An account is an account: getDashboardSnapshot only fetches fills/portfolio for an account it
    // can resolve, and only calls getBrokerGateway when a real connected account is active — so this
    // test needs one (test infrastructure: broker "test", environment "paper") wired up, matching the
    // accountNumber "TEST" the proposal/fill rows below are seeded under.
    db.upsertConnectedAccount({
      id: `acct-${userId}`,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Batching Test Account",
      isActive: true
    });

    // Seed a proposal + a fill referencing it so both the batched proposal lookup and the fill
    // replay have real rows to walk (and so the audit/unified feed builders exercise getProposalById).
    const proposalId = `prop-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    db.insertProposal({
      userId,
      id: proposalId,
      runId,
      accountNumber: "TEST",
      proposal: {
        symbol: "AAPL",
        side: "buy",
        type: "market",
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "seed",
        tradeThesisTag: "seed",
        entryMarketRegime: "seed",
        referencePrice: 100
      },
      decision: { approved: true, reasons: [] },
      status: "proposed"
    });
    db.insertFillEvent({
      id: `fill-${randomUUID()}`,
      userId,
      proposalId,
      runId,
      accountNumber: "TEST",
      source: "paper",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 100,
      notional: 100,
      status: "filled",
      filledAt: new Date().toISOString()
    });
    // An audit row that references the proposal, so buildAuditFeed / buildUnifiedFeed both need to
    // resolve it — exercising the batched getProposalById closure.
    db.audit("proposal_approved", { proposalId, result: "paper" }, userId);

    const listFillEventsSpy = vi.spyOn(db, "listFillEvents");
    const getProposalsByIdsSpy = vi.spyOn(db, "getProposalsByIds");

    await getDashboardSnapshot(userId);

    const liveCalls = listFillEventsSpy.mock.calls.filter((args) => args[1] === "live");
    const paperCalls = listFillEventsSpy.mock.calls.filter((args) => args[1] === "paper");

    // Item 1: exactly one live + one paper fetch for the common (accountNumber set) case.
    expect(liveCalls.length).toBe(1);
    expect(paperCalls.length).toBe(1);
    // And no unfiltered (both-source) fetch remains — the feed reuses the pre-fetched arrays.
    const unfilteredCalls = listFillEventsSpy.mock.calls.filter((args) => args[1] === undefined);
    expect(unfilteredCalls.length).toBe(0);

    // Item 2: the referenced proposalId is resolved via the batched query, which includes it.
    expect(getProposalsByIdsSpy).toHaveBeenCalled();
    const batchedIds = getProposalsByIdsSpy.mock.calls.flatMap((args) => args[0] as string[]);
    expect(batchedIds).toContain(proposalId);
  });

  it("includes red-team efficacy plus the override split in the snapshot", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-red-team-${randomUUID()}`;
    const connectedAccountId = `acct-${userId}`;

    db.upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST",
      label: "Red Team Snapshot Account",
      isActive: true
    });

    db.audit(
      "proposal_rejected_by_red_team",
      { runId: "run-rt-1", symbol: "AAPL", side: "buy", thesisTag: "Momentum", reason: "Overbought.", model: "openai/gpt-4.1-mini" },
      userId,
      connectedAccountId
    );
    db.insertSkippedCounterfactualCandidate({
      userId,
      connectedAccountId,
      runId: "run-rt-1",
      symbol: "AAPL",
      snapshotAt: "2026-06-01T00:00:00.000Z",
      refPrice: 100,
      horizonDays: 5,
      targetDate: "2026-06-06"
    });
    db.markSkippedCounterfactualMatured({
      id: `${userId}:run-rt-1:AAPL:5`,
      userId,
      exitDate: "2026-06-06",
      exitPrice: 90,
      returnPct: -10
    });

    db.audit(
      "red_team_veto_override_requested",
      { runId: "run-rt-2", symbol: "MSFT", side: "buy", thesisTag: "Momentum", reason: "Too early.", model: "claude-opus", mode: "execute" },
      userId,
      connectedAccountId
    );
    db.audit(
      "socratic_override_applied",
      { runId: "run-rt-2", symbol: "MSFT", side: "buy", conflicts: ["red_team_veto: Too early."], thesis: "Override with logged evidence.", mode: "execute" },
      userId,
      connectedAccountId
    );
    db.audit(
      // Historical rows used this name before request and applied states were separated.
      "red_team_veto_overridden",
      { runId: "run-rt-3", symbol: "TSLA", side: "buy", thesisTag: "Momentum", reason: "Crowded.", model: "claude-opus", mode: "execute" },
      userId,
      connectedAccountId
    );
    db.audit(
      "socratic_override_refused",
      { runId: "run-rt-3", symbol: "TSLA", side: "buy", conflicts: ["red_team_veto: Crowded."], hardReasons: [], thesis: "Override was refused." },
      userId,
      connectedAccountId
    );

    const snapshot = await getDashboardSnapshot(userId);

    expect(snapshot.redTeamEfficacy).toBeDefined();
    expect(snapshot.redTeamEfficacy).toMatchObject({
      totalVetoes: 1,
      maturedVetoes: 1,
      overrideVetoes: 2,
      appliedOverrideVetoes: 1,
      vetoDecisions: 3,
      overrideSharePct: 33.3,
      vetoValueAddRate: 100
    });
    expect(snapshot.redTeamEfficacy?.records[0]?.symbol).toBe("AAPL");
  });
});

describe("getProposalsByIds", () => {
  it("resolves many ids in one query and omits unknown/foreign-user ids", async () => {
    const db = await import("../src/lib/db");
    const userId = `pbi-${randomUUID()}`;
    const otherUserId = `pbi-other-${randomUUID()}`;

    const idA = `A-${randomUUID()}`;
    const idB = `B-${randomUUID()}`;
    const idOther = `O-${randomUUID()}`;
    const seed = (id: string, uid: string) =>
      db.insertProposal({
        userId: uid,
        id,
        runId: `run-${randomUUID()}`,
        accountNumber: "TEST",
        proposal: {
          symbol: "MSFT",
          side: "buy",
          type: "market",
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: "seed",
          tradeThesisTag: "seed",
          entryMarketRegime: "seed",
          referencePrice: 100
        },
        decision: { approved: true, reasons: [] },
        status: "proposed"
      });
    seed(idA, userId);
    seed(idB, userId);
    seed(idOther, otherUserId);

    const map = db.getProposalsByIds([idA, idB, idOther, "does-not-exist"], userId);

    expect(map.get(idA)?.proposal.symbol).toBe("MSFT");
    expect(map.get(idB)?.proposal.symbol).toBe("MSFT");
    // Another user's proposal and a nonexistent id are absent — identical to getProposal returning undefined.
    expect(map.has(idOther)).toBe(false);
    expect(map.has("does-not-exist")).toBe(false);
    expect(map.size).toBe(2);
  });
});
