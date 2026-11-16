/**
 * C1 — dashboard snapshot short TTL cache:
 *  - keys isolate by (userId, accountNumber) — never share across accounts/users
 *  - TTL expires entries
 *  - invalidate drops by user / exact key / all
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_SNAPSHOT_TTL_MS,
  dashboardSnapshotCacheKey,
  dashboardSnapshotCacheSizeForTests,
  getCachedDashboardSnapshot,
  getOrComputeDashboardSnapshot,
  peekDashboardSnapshot,
  invalidateDashboardSnapshotCache,
  resetDashboardSnapshotCacheForTests,
  setCachedDashboardSnapshot
} from "../src/lib/dashboard-snapshot-cache";

afterEach(() => {
  resetDashboardSnapshotCacheForTests();
  vi.useRealTimers();
});

describe("dashboardSnapshotCacheKey", () => {
  it("isolates userId and accountNumber", () => {
    const a = dashboardSnapshotCacheKey("user-a", "ACCT-1");
    const b = dashboardSnapshotCacheKey("user-a", "ACCT-2");
    const c = dashboardSnapshotCacheKey("user-b", "ACCT-1");
    const empty = dashboardSnapshotCacheKey("user-a", "");
    const nullish = dashboardSnapshotCacheKey("user-a", null);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(empty).toBe(nullish);
    expect(a).not.toBe(empty);
  });
});

describe("dashboard snapshot TTL cache", () => {
  it("returns the same value within TTL for the same key", async () => {
    const key = dashboardSnapshotCacheKey("u1", "A1");
    let computes = 0;
    const first = await getOrComputeDashboardSnapshot(key, async () => {
      computes += 1;
      return { portfolio: 1, account: "A1" };
    });
    const second = await getOrComputeDashboardSnapshot(key, async () => {
      computes += 1;
      return { portfolio: 99, account: "A1" };
    });
    expect(first).toEqual({ portfolio: 1, account: "A1" });
    expect(second).toBe(first);
    expect(computes).toBe(1);
  });

  it("does not leak values across accountNumbers for the same user", async () => {
    const k1 = dashboardSnapshotCacheKey("u1", "A1");
    const k2 = dashboardSnapshotCacheKey("u1", "A2");
    await getOrComputeDashboardSnapshot(k1, async () => ({ account: "A1", nav: 100 }));
    await getOrComputeDashboardSnapshot(k2, async () => ({ account: "A2", nav: 200 }));
    expect(getCachedDashboardSnapshot<{ account: string }>(k1)?.account).toBe("A1");
    expect(getCachedDashboardSnapshot<{ account: string }>(k2)?.account).toBe("A2");
    expect(getCachedDashboardSnapshot(k1)).not.toBe(getCachedDashboardSnapshot(k2));
  });

  it("does not leak values across userIds for the same accountNumber", async () => {
    const k1 = dashboardSnapshotCacheKey("alice", "SHARED");
    const k2 = dashboardSnapshotCacheKey("bob", "SHARED");
    await getOrComputeDashboardSnapshot(k1, async () => ({ user: "alice" }));
    await getOrComputeDashboardSnapshot(k2, async () => ({ user: "bob" }));
    expect(getCachedDashboardSnapshot<{ user: string }>(k1)?.user).toBe("alice");
    expect(getCachedDashboardSnapshot<{ user: string }>(k2)?.user).toBe("bob");
  });

  it("expires after TTL", async () => {
    vi.useFakeTimers();
    const key = dashboardSnapshotCacheKey("u1", "A1");
    setCachedDashboardSnapshot(key, { v: 1 }, DASHBOARD_SNAPSHOT_TTL_MS, Date.now());
    expect(getCachedDashboardSnapshot(key, Date.now())).toEqual({ v: 1 });
    vi.advanceTimersByTime(DASHBOARD_SNAPSHOT_TTL_MS + 1);
    expect(getCachedDashboardSnapshot(key, Date.now())).toBeUndefined();
    expect(peekDashboardSnapshot<{ v: number }>(key, Date.now())).toEqual({ value: { v: 1 }, fresh: false });
  });

  it("invalidateDashboardSnapshotCache drops only the target user or key", async () => {
    const a1 = dashboardSnapshotCacheKey("alice", "1");
    const a2 = dashboardSnapshotCacheKey("alice", "2");
    const b1 = dashboardSnapshotCacheKey("bob", "1");
    setCachedDashboardSnapshot(a1, { k: "a1" });
    setCachedDashboardSnapshot(a2, { k: "a2" });
    setCachedDashboardSnapshot(b1, { k: "b1" });
    expect(dashboardSnapshotCacheSizeForTests()).toBe(3);

    invalidateDashboardSnapshotCache("alice", "1");
    expect(getCachedDashboardSnapshot(a1)).toBeUndefined();
    expect(getCachedDashboardSnapshot(a2)).toEqual({ k: "a2" });
    expect(getCachedDashboardSnapshot(b1)).toEqual({ k: "b1" });

    invalidateDashboardSnapshotCache("alice");
    expect(getCachedDashboardSnapshot(a2)).toBeUndefined();
    expect(getCachedDashboardSnapshot(b1)).toEqual({ k: "b1" });

    invalidateDashboardSnapshotCache();
    expect(dashboardSnapshotCacheSizeForTests()).toBe(0);
  });

  it("single-flights concurrent computes for the same key", async () => {
    const key = dashboardSnapshotCacheKey("u1", "A1");
    let computes = 0;
    let resolveCompute!: (v: number) => void;
    const gate = new Promise<number>((resolve) => {
      resolveCompute = resolve;
    });
    const compute = async () => {
      computes += 1;
      return gate;
    };
    const p1 = getOrComputeDashboardSnapshot(key, compute);
    const p2 = getOrComputeDashboardSnapshot(key, compute);
    resolveCompute(42);
    await expect(Promise.all([p1, p2])).resolves.toEqual([42, 42]);
    expect(computes).toBe(1);
  });
});
