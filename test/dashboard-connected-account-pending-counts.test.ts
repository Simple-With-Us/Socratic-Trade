/**
 * per-account-visibility (lifecycle-12): Settings > Broker connections' pending-proposal chip
 * for a non-loaded account used to filter snapshot.pendingProposals, an array the server already
 * scopes to the ACTIVE account only (dashboard.ts's `listPendingProposals(accountNumber, userId)`
 * where accountNumber is the active account's number) -- so the "Other Accounts" filter could
 * never match another account's id and always read zero, even when that account genuinely has
 * proposals waiting (the scheduler runs every connected account independently of which one is
 * loaded). This proves the new snapshot.connectedAccountPendingCounts field actually counts a
 * SECOND, non-active connected account's pending proposals — with two accounts and
 * distinguishable data, asserting the right count lands under the right account id.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

// Keep the snapshot's best-effort macro / market-signal / benchmark fan-out off the network —
// mirrors dashboard-fill-batching.test.ts's scaffolding; none of it touches pending-proposal counts.
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
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "TEST-ACTIVE", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return { accountNumber: "TEST-ACTIVE", totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
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
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-pending-counts-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("getDashboardSnapshot connectedAccountPendingCounts", () => {
  it("counts a pending proposal on a NON-active connected account, not just the active one", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");

    const userId = `dash-pending-${randomUUID()}`;
    const activeAccountId = `acct-active-${userId}`;
    const otherAccountId = `acct-other-${userId}`;

    // The loaded/active account -- zero pending proposals.
    db.upsertConnectedAccount({
      id: activeAccountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "TEST-ACTIVE",
      label: "Active Account",
      isActive: true
    });
    // A second connected account, NOT loaded in this session, with real proposals waiting —
    // exactly the "live Roth IRA running independently" scenario the finding describes.
    db.upsertConnectedAccount({
      id: otherAccountId,
      userId,
      broker: "test",
      environment: "live",
      accountNumber: "TEST-OTHER",
      label: "Other Account",
      isActive: false
    });

    const seedPending = (accountNumber: string, id: string) =>
      db.insertProposal({
        userId,
        id,
        runId: `run-${randomUUID()}`,
        accountNumber,
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

    seedPending("TEST-OTHER", `p-other-${randomUUID()}`);

    const snapshot = await getDashboardSnapshot(userId);

    // The active account's OWN scoped list is genuinely empty.
    expect(snapshot.pendingProposals).toEqual([]);
    // But the per-account projection knows the other account has one waiting.
    expect(snapshot.connectedAccountPendingCounts?.[otherAccountId]).toBe(1);
    expect(snapshot.connectedAccountPendingCounts?.[activeAccountId]).toBe(0);
  });
});
