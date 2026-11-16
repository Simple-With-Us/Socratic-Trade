/**
 * ST-4620: concurrent dashboard reads share one snapshot compute.
 * Different users and accounts never share. A finished snapshot is remembered
 * for a short TTL. A thrown compute is not remembered past the in-flight window.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTesting, setPolicy } from "../src/lib/db";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import { userIdForEmail } from "../src/lib/auth/identity";

const snapshotCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock("../src/lib/dashboard", () => ({
  getDashboardSnapshot: vi.fn(async (userId: string) => {
    snapshotCalls.n += 1;
    return { userId, marker: snapshotCalls.n, partialData: false };
  })
}));

vi.mock("../src/lib/auth/auth", () => ({
  auth: async () => null
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dashboard-coalesce-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

function dashboardRequest(email?: string): Request {
  const headers = new Headers();
  if (email) headers.set(AUTHENTICATED_EMAIL_HEADER, email);
  return new Request("https://socratictrade.com/api/dashboard", { headers });
}

describe("dashboard snapshot coalesce", () => {
  beforeEach(async () => {
    snapshotCalls.n = 0;
    const { resetDashboardCoalesceForTests } = await import("../src/lib/dashboard-coalesce");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    resetDashboardCoalesceForTests();
    vi.mocked(getDashboardSnapshot).mockReset();
    vi.mocked(getDashboardSnapshot).mockImplementation(async (userId) => {
      snapshotCalls.n += 1;
      return { userId: userId ?? "local", marker: snapshotCalls.n, partialData: false } as never;
    });
  });

  it("runs one compute for concurrent callers of the same key", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    const key = dashboardCoalesceKey("user-a", "ACCT-1");
    let computes = 0;
    let release!: (value: { nav: number }) => void;
    const gate = new Promise<{ nav: number }>((resolve) => {
      release = resolve;
    });
    const compute = () => {
      computes += 1;
      return gate;
    };
    const first = coalesceDashboardSnapshot(key, compute);
    const second = coalesceDashboardSnapshot(key, compute);
    const third = coalesceDashboardSnapshot(key, compute);
    release({ nav: 10 });
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { nav: 10 },
      { nav: 10 },
      { nav: 10 }
    ]);
    expect(computes).toBe(1);
  });

  it("does not share a compute across users or accounts", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    let computes = 0;
    const compute = (label: string) => async () => {
      computes += 1;
      return { label };
    };
    const [userA, userB, otherAccount] = await Promise.all([
      coalesceDashboardSnapshot(dashboardCoalesceKey("alice", "ACCT-1"), compute("alice-1")),
      coalesceDashboardSnapshot(dashboardCoalesceKey("bob", "ACCT-1"), compute("bob-1")),
      coalesceDashboardSnapshot(dashboardCoalesceKey("alice", "ACCT-2"), compute("alice-2"))
    ]);
    expect(userA).toEqual({ label: "alice-1" });
    expect(userB).toEqual({ label: "bob-1" });
    expect(otherAccount).toEqual({ label: "alice-2" });
    expect(computes).toBe(3);
    expect(dashboardCoalesceKey("alice", null)).toBe(dashboardCoalesceKey("alice", undefined));
    expect(dashboardCoalesceKey("alice", "ACCT-1")).not.toBe(dashboardCoalesceKey("alice", ""));
  });

  it("recomputes after the TTL and serves the memo before that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T15:00:00.000Z"));
    const { coalesceDashboardSnapshot, dashboardCoalesceKey, DASHBOARD_COALESCE_TTL_MS } = await import(
      "../src/lib/dashboard-coalesce"
    );
    const key = dashboardCoalesceKey("user-a", "ACCT-1");
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return { computes };
    };
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 1 });
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 1 });
    vi.setSystemTime(new Date(Date.now() + DASHBOARD_COALESCE_TTL_MS + 1));
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 2 });
    expect(computes).toBe(2);
  });

  it("does not remember a thrown compute after the in-flight window", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    const key = dashboardCoalesceKey("user-a", "ACCT-1");
    let computes = 0;
    let rejectCompute!: (error: Error) => void;
    const failing = () => {
      computes += 1;
      return new Promise<never>((_resolve, reject) => {
        rejectCompute = reject;
      });
    };
    const first = coalesceDashboardSnapshot(key, failing);
    const second = coalesceDashboardSnapshot(key, failing);
    const error = new Error("snapshot failed");
    rejectCompute(error);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(computes).toBe(1);
    const third = await coalesceDashboardSnapshot(key, async () => {
      computes += 1;
      return { ok: true };
    });
    expect(third).toEqual({ ok: true });
    expect(computes).toBe(2);
  });

  it("does not memo the budget-timeout shell", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    const key = dashboardCoalesceKey("user-a", "ACCT-1");
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return {
        partialData: true,
        partialReason:
          "Dashboard snapshot exceeded 20000ms; serving cached or partial data so the phone stays inside its 30s limit."
      };
    };
    await coalesceDashboardSnapshot(key, compute);
    await coalesceDashboardSnapshot(key, compute);
    expect(computes).toBe(2);
  });

  it("drops a memo when the snapshot cache is invalidated", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    const { invalidateDashboardSnapshotCache } = await import("../src/lib/dashboard-snapshot-cache");
    const key = dashboardCoalesceKey("alice", "ACCT-1");
    let computes = 0;
    const compute = async () => {
      computes += 1;
      return { computes };
    };
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 1 });
    invalidateDashboardSnapshotCache("alice", "ACCT-1");
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 2 });
    expect(await coalesceDashboardSnapshot(dashboardCoalesceKey("bob", "ACCT-1"), compute)).toEqual({ computes: 3 });
    invalidateDashboardSnapshotCache("alice");
    expect(await coalesceDashboardSnapshot(key, compute)).toEqual({ computes: 4 });
    expect(await coalesceDashboardSnapshot(dashboardCoalesceKey("bob", "ACCT-1"), async () => ({ kept: true }))).toEqual({
      computes: 3
    });
  });

  it("does not join a compute that started before an invalidation", async () => {
    const { coalesceDashboardSnapshot, dashboardCoalesceKey, invalidateDashboardCoalesce } = await import(
      "../src/lib/dashboard-coalesce"
    );
    const key = dashboardCoalesceKey("alice", "ACCT-1");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slow = 0;
    const first = coalesceDashboardSnapshot(key, () => {
      slow += 1;
      return gate.then(() => ({ slow }));
    });
    invalidateDashboardCoalesce("alice", "ACCT-1");
    let fast = 0;
    const second = coalesceDashboardSnapshot(key, async () => {
      fast += 1;
      return { fast };
    });
    const raced = await Promise.race([
      second.then((value) => ({ kind: "second" as const, value })),
      new Promise<{ kind: "hung" }>((resolve) => {
        setTimeout(() => resolve({ kind: "hung" }), 50);
      })
    ]);
    expect(raced).toEqual({ kind: "second", value: { fast: 1 } });
    release();
    expect(await first).toEqual({ slow: 1 });
    expect(fast).toBe(1);
  });
});

describe("GET /api/dashboard", () => {
  beforeEach(async () => {
    snapshotCalls.n = 0;
    resetDbForTesting();
    const { resetDashboardCoalesceForTests } = await import("../src/lib/dashboard-coalesce");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    resetDashboardCoalesceForTests();
    vi.mocked(getDashboardSnapshot).mockReset();
    vi.mocked(getDashboardSnapshot).mockImplementation(async (userId) => {
      snapshotCalls.n += 1;
      return { userId: userId ?? "local", marker: snapshotCalls.n, partialData: false } as never;
    });
  });

  it("shares one snapshot computation across concurrent requests", async () => {
    const { GET, dynamic } = await import("../app/api/dashboard/route");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    let release!: () => void;
    vi.mocked(getDashboardSnapshot).mockImplementation((userId) => {
      snapshotCalls.n += 1;
      const user = userId ?? "local";
      return new Promise((resolve) => {
        release = () => resolve({ userId: user, marker: snapshotCalls.n, partialData: false } as never);
      });
    });
    const pending = Promise.all([GET(dashboardRequest()), GET(dashboardRequest()), GET(dashboardRequest())]);
    await vi.waitFor(() => expect(snapshotCalls.n).toBe(1));
    release();
    const responses = await pending;
    expect(snapshotCalls.n).toBe(1);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(dynamic).toBe("force-dynamic");
    expect(responses[0].headers.get("cache-control") ?? "").not.toMatch(/max-age=[1-9]/);
  });

  it("does not share a snapshot across users", async () => {
    const { GET } = await import("../app/api/dashboard/route");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    const releases: Array<() => void> = [];
    vi.mocked(getDashboardSnapshot).mockImplementation((userId) => {
      snapshotCalls.n += 1;
      const user = userId ?? "local";
      return new Promise((resolve) => {
        releases.push(() => resolve({ userId: user, marker: snapshotCalls.n, partialData: false } as never));
      });
    });
    const otherEmail = "dashboard-coalesce-other@example.com";
    const pending = Promise.all([
      GET(dashboardRequest()),
      GET(dashboardRequest(otherEmail))
    ]);
    await vi.waitFor(() => expect(snapshotCalls.n).toBe(2));
    for (const release of releases) release();
    const responses = await pending;
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{ userId: string }>));
    expect(bodies.map((body) => body.userId).sort()).toEqual(["local", userIdForEmail(otherEmail)].sort());
  });

  it("recomputes a route response after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T15:00:00.000Z"));
    const { GET } = await import("../app/api/dashboard/route");
    const { DASHBOARD_COALESCE_TTL_MS } = await import("../src/lib/dashboard-coalesce");
    const first = await GET(dashboardRequest());
    const second = await GET(dashboardRequest());
    expect(snapshotCalls.n).toBe(1);
    expect(await first.json()).toEqual(await second.json());
    vi.setSystemTime(new Date(Date.now() + DASHBOARD_COALESCE_TTL_MS + 1));
    await GET(dashboardRequest());
    expect(snapshotCalls.n).toBe(2);
  });

  it("computes again after a snapshot error", async () => {
    const { GET } = await import("../app/api/dashboard/route");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    vi.mocked(getDashboardSnapshot).mockRejectedValue(new Error("snapshot failed"));
    await expect(GET(dashboardRequest())).rejects.toThrow("snapshot failed");
    await expect(GET(dashboardRequest())).rejects.toThrow("snapshot failed");
    expect(vi.mocked(getDashboardSnapshot)).toHaveBeenCalledTimes(2);
  });

  it("keys the route by the selected account", async () => {
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACCT-1" }, "local");
    const { dashboardAccountCoalesceKey, dashboardCoalesceKey } = await import("../src/lib/dashboard-coalesce");
    expect(dashboardAccountCoalesceKey("local")).toBe(dashboardCoalesceKey("local", "ACCT-1"));
    setPolicy({ ...DEFAULT_POLICY, accountNumber: "ACCT-2" }, "local");
    expect(dashboardAccountCoalesceKey("local")).toBe(dashboardCoalesceKey("local", "ACCT-2"));
    expect(dashboardAccountCoalesceKey("local")).not.toBe(dashboardCoalesceKey("local", "ACCT-1"));
  });
});
