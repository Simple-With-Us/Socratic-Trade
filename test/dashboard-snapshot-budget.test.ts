/**
 * Mobile snapshot must return inside the iOS 30s client timeout.  Broker reads on this
 * path are capped near 12s, and the whole compute stops waiting at 20s.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const hang = () => new Promise(() => {});
const budgetTest = vi.hoisted(() => ({
  hangCompute: false,
  brokerMode: "hang" as "hang" | "ready",
  hangMacro: false
}));

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
  fetchMacroData: vi.fn(async () => {
    if (budgetTest.hangMacro) return new Promise(() => {});
    return {};
  }),
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
  getBrokerGateway: vi.fn(() => {
    if (budgetTest.brokerMode === "ready") {
      return {
        getAccounts: async () => [{ accountNumber: "BUDGET", label: "Budget", agenticAllowed: true }],
        getPortfolio: async () => undefined,
        getEquityPositions: async () => [],
        getEquityOrders: async () => [],
        getOptionPositions: async () => [],
        getEquityQuotes: async () => ({})
      };
    }
    return {
      getAccounts: hang,
      getPortfolio: hang,
      getEquityPositions: hang,
      getEquityOrders: hang,
      getOptionPositions: hang,
      getEquityQuotes: hang
    };
  })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-snapshot-budget-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  budgetTest.hangCompute = false;
  budgetTest.brokerMode = "hang";
  budgetTest.hangMacro = false;
  vi.useRealTimers();
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  const { setDegradedSnapshotReadsForTests } = await import("../src/lib/dashboard");
  resetDashboardSnapshotCacheForTests();
  setDegradedSnapshotReadsForTests(null);
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

  it("keeps a cached section reason when the overall budget also times out", async () => {
    const db = await import("../src/lib/db");
    const cache = await import("../src/lib/dashboard-snapshot-cache");
    const { getDashboardSnapshot, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-reason-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "REASON",
      label: "Reason",
      isActive: true
    });
    const policy = db.getPolicy(userId, accountId);
    const specific = "Snapshot section timed out (gateway.getAccounts).  Partial data is shown so the request stays inside the phone's 30s limit.";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T15:00:00.000Z"));
    const key = cache.dashboardSnapshotCacheKey(userId, policy.accountNumber ?? "REASON");
    cache.setCachedDashboardSnapshot(key, {
      partialData: true,
      partialReason: specific,
      policy,
      orders: [],
      marker: "specific"
    }, 1, Date.now() - 5_000);

    budgetTest.hangCompute = true;
    const pending = getDashboardSnapshot(userId);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.partialReason).toBe(specific);
    expect((snapshot as { marker?: string }).marker).toBe("specific");
  });

  it("does not pause Owner Approve when only a non-broker section times out", async () => {
    vi.useFakeTimers();
    budgetTest.brokerMode = "ready";
    budgetTest.hangMacro = true;
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    const userId = `dash-macro-${randomUUID()}`;
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

    const pending = getDashboardSnapshot(userId, "macro@example.com");
    await vi.advanceTimersByTimeAsync(6_000);
    const snapshot = await pending;
    expect(snapshot.partialData).toBe(false);
    expect(snapshot.partialReason).toBeUndefined();
    expect(snapshot.accounts.some((account) => account.accountNumber === "BUDGET")).toBe(true);
    expect(snapshot.policy.additionalSymbols).toEqual(["AAPL"]);
  });

  it("reports a timeout instead of a missing account on the cold shell", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-cold-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "COLD",
      label: "Cold",
      isActive: true
    });
    vi.useFakeTimers();
    budgetTest.hangCompute = true;
    const pending = getDashboardSnapshot(userId, "cold@example.com");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.accountReadiness.ok).toBe(false);
    expect(snapshot.accountReadiness.detail).toMatch(/exceeded/);
    expect(snapshot.accountReadiness.detail).not.toMatch(/not found/i);
    expect(snapshot.accountReadiness.connectedAccountId).toBe(accountId);
    expect(snapshot.accounts).toEqual([]);
  });

  it("does not call a connected account missing when the active-account read throws", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot, setDegradedSnapshotReadsForTests, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-active-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "ACTIVE",
      label: "Active",
      isActive: true
    });
    setDegradedSnapshotReadsForTests({
      getActiveConnectedAccount: () => {
        throw new Error("active down");
      }
    });
    vi.useFakeTimers();
    budgetTest.hangCompute = true;
    const pending = getDashboardSnapshot(userId, "active@example.com");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.accountReadiness.ok).toBe(false);
    expect(snapshot.accountReadiness.detail).toMatch(/exceeded/);
    expect(snapshot.accountReadiness.detail).not.toMatch(/not found/i);
    expect(snapshot.accountReadiness.connectedAccountId).toBe(accountId);
    expect(snapshot.policy.connectedAccountId).toBe(accountId);
  });

  it("still returns the cold shell when policy, accounts, readiness, and the digest throw", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot, setDegradedSnapshotReadsForTests, SNAPSHOT_OVERALL_BUDGET_MS } = await import("../src/lib/dashboard");
    const userId = `dash-guard-${randomUUID()}`;
    const accountId = `acct-${userId}`;
    db.upsertConnectedAccount({
      id: accountId,
      userId,
      broker: "test",
      environment: "paper",
      accountNumber: "GUARD",
      label: "Guard",
      isActive: true
    });
    db.setPolicy({ ...db.getPolicy(userId, accountId), additionalSymbols: ["AAPL"] }, userId, accountId);
    setDegradedSnapshotReadsForTests({
      getPolicy: () => {
        throw new Error("policy down");
      },
      listConnectedAccounts: () => {
        throw new Error("accounts down");
      },
      getActiveConnectedAccount: () => {
        throw new Error("active down");
      },
      isAdminEmail: () => {
        throw new Error("admin down");
      },
      accountReadinessForSnapshot: () => {
        throw new Error("readiness down");
      },
      weeklyMarketDigestForScan: () => {
        throw new Error("digest down");
      }
    });
    vi.useFakeTimers();
    budgetTest.hangCompute = true;
    const pending = getDashboardSnapshot(userId, "guard@example.com");
    await vi.advanceTimersByTimeAsync(SNAPSHOT_OVERALL_BUDGET_MS);
    const snapshot = await pending;
    expect(snapshot.partialData).toBe(true);
    expect(snapshot.policy.additionalSymbols).toEqual([]);
    expect(snapshot.policy.systemState).toBe("halted");
    expect(snapshot.connectedAccounts).toEqual([]);
    expect(snapshot.currentUser.isAdmin).toBe(false);
    expect(snapshot.accountReadiness.detail).toMatch(/exceeded/);
    expect(snapshot.accountReadiness.detail).not.toMatch(/not found/i);
    expect(snapshot.weeklyMarketDigest.warnings.some((warning) => /exceeded/.test(warning))).toBe(true);
  });
});

describe("snapshotSectionWaitMs", () => {
  it("keeps a post-processing reserve so a section wait cannot consume the outer budget", async () => {
    const {
      snapshotSectionWaitMs,
      SNAPSHOT_OVERALL_BUDGET_MS,
      SNAPSHOT_BROKER_TIMEOUT_MS,
      SNAPSHOT_POST_PROCESS_RESERVE_MS
    } = await import("../src/lib/dashboard");
    const started = 1_000_000;
    expect(snapshotSectionWaitMs(started, SNAPSHOT_BROKER_TIMEOUT_MS, started)).toBe(SNAPSHOT_BROKER_TIMEOUT_MS);
    expect(SNAPSHOT_BROKER_TIMEOUT_MS).toBeLessThan(SNAPSHOT_OVERALL_BUDGET_MS - SNAPSHOT_POST_PROCESS_RESERVE_MS);
    const sectionDeadline = started + (SNAPSHOT_OVERALL_BUDGET_MS - SNAPSHOT_POST_PROCESS_RESERVE_MS);
    expect(snapshotSectionWaitMs(started, SNAPSHOT_BROKER_TIMEOUT_MS, sectionDeadline)).toBe(0);
    expect(snapshotSectionWaitMs(started, SNAPSHOT_BROKER_TIMEOUT_MS, started + 15_000)).toBe(
      SNAPSHOT_OVERALL_BUDGET_MS - SNAPSHOT_POST_PROCESS_RESERVE_MS - 15_000
    );
  });
});
