/**
 * Mobile snapshot must return inside the iOS 30s client timeout.  Broker reads on this
 * path are capped near 12s, and the whole compute stops waiting at 20s.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const hang = () => new Promise(() => {});
const budgetTest = vi.hoisted(() => ({ hangCompute: false }));

vi.mock("../src/lib/dashboard-snapshot-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dashboard-snapshot-cache")>();
  return {
    ...actual,
    getOrComputeDashboardSnapshot: <T>(key: string, compute: () => Promise<T>, ttlMs?: number) => {
      if (budgetTest.hangCompute) return new Promise<T>(() => {});
      return actual.getOrComputeDashboardSnapshot(key, compute, ttlMs);
    }
  };
});

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
  getWebSourcesStatus: vi.fn(() => ({ congress: { enabled: false }, insider: { enabled: false } }))
}));
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    getAccounts: hang,
    getPortfolio: hang,
    getEquityPositions: hang,
    getEquityOrders: hang,
    getOptionPositions: hang,
    getEquityQuotes: hang
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-snapshot-budget-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  budgetTest.hangCompute = false;
  vi.useRealTimers();
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("getDashboardSnapshot budget", () => {
  it("returns partial data when broker reads hang, inside the 20s overall budget", async () => {
    vi.useFakeTimers();
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-budget-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "BUDGET",
      label: "Budget",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), additionalSymbols: ["AAPL"] }, userId, accountId);

    const started = Date.now();
    const pending = getDashboardSnapshot(userId, "budget@example.com");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(Date.now() - started).toBeLessThanOrEqual(SNAPSHOT_OVERALL_BUDGET_MS);
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.partialReason).toMatch(/timed out|budget/i);
    expect(snapshot.policy.accountNumber).toBe("BUDGET");
    expect(Array.isArray(snapshot.orders)).toBe(true);
  });

  it("serves the last cached snapshot when a later compute is still running at 20s", async () => {
    const db = await import("../src/lib/db");
    const cache = await import("../src/lib/dashboard-snapshot-cache");
    const { getDashboardSnapshot, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-cache-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "CACHED",
      label: "Cached",
      isActive: true
    });
    const policy = db.getPolicy(userId, accountId);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T15:00:00.000Z"));
    const key = cache.dashboardSnapshotCacheKey(userId, policy.accountNumber ?? "CACHED");
    cache.setCachedDashboardSnapshot(key, {
      partialData: false,
      policy,
      orders: [{ id: "kept" }],
      positions: [],
      marker: "last-good"
    }, 1, Date.now() - 5_000);

    budgetTest.hangCompute = true;
    const pending = getDashboardSnapshot(userId);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.partialReason).toMatch(/cached or partial/);
    expect((snapshot as { marker?: string }).marker).toBe("last-good");
  });
});
