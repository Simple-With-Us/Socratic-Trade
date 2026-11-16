/**
 * Accuracy breaker (nofx-style consecutive-miss safety mode, docs/oss-lessons.md §8):
 *  - evaluateAccuracyBreaker (pure): streak trigger, hit-rate trigger, recovery, clamping.
 *  - Marker helpers: set/get/clear over the internal settings KV.
 *  - listRecentDecisiveOutcomeStatuses (db-socratic): REAL (placed/filled) decisive outcomes only,
 *    newest first — counterfactual (blocked/rejected) outcomes and non-decisive terminals excluded.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateAccuracyBreaker, type DecisiveOutcomeStatus } from "../src/lib/accuracy-breaker";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-accuracy-breaker-${randomUUID()}.db`)}`;
});

const run = (outcomes: DecisiveOutcomeStatus[], extra: Partial<Parameters<typeof evaluateAccuracyBreaker>[0]> = {}) =>
  evaluateAccuracyBreaker({ outcomes, degraded: false, ...extra });

describe("evaluateAccuracyBreaker — streak trigger", () => {
  it("fires when the newest K decisive outcomes are all losses", () => {
    const result = run(["lost", "lost", "lost", "won"], { consecutiveLosses: 3 });
    expect(result.firing).toBe(true);
    expect(result.trigger).toBe("streak");
    expect(result.consecutiveLossStreak).toBe(3);
    expect(result.reason).toContain("last 3 matured trades");
  });

  it("does not fire below the streak limit", () => {
    expect(run(["lost", "lost", "won"], { consecutiveLosses: 3 }).firing).toBe(false);
    expect(run(["lost"], { consecutiveLosses: 2 }).firing).toBe(false);
  });

  it("a flat outcome breaks the streak (not a loss, but not evidence either)", () => {
    expect(run(["lost", "lost", "flat", "lost", "lost"], { consecutiveLosses: 3 }).firing).toBe(false);
    expect(run(["lost", "lost", "flat"], { consecutiveLosses: 2 }).consecutiveLossStreak).toBe(2);
  });

  it("fires when the streak overshoots the limit", () => {
    const result = run(["lost", "lost", "lost", "lost", "lost"], { consecutiveLosses: 3 });
    expect(result.firing).toBe(true);
    expect(result.reason).toContain("last 5 matured trades");
  });

  it("is disabled when the limit is unset or <= 0", () => {
    expect(run(["lost", "lost", "lost"]).firing).toBe(false);
    expect(run(["lost", "lost", "lost"], { consecutiveLosses: 0 }).firing).toBe(false);
  });
});

describe("evaluateAccuracyBreaker — hit-rate trigger", () => {
  it("fires when the window hit rate is below the floor", () => {
    // 1 won / 5 decisive = 20% < 30% floor
    const result = run(["lost", "lost", "won", "lost", "lost"], { windowSize: 5, minHitRatePct: 30 });
    expect(result.firing).toBe(true);
    expect(result.trigger).toBe("hit-rate");
    expect(result.hitRatePct).toBeCloseTo(20);
  });

  it("does not fire at or above the floor", () => {
    expect(run(["won", "lost", "won", "lost", "flat"], { windowSize: 5, minHitRatePct: 30 }).firing).toBe(false);
  });

  it("never fires on a partial window (tiny sample protection)", () => {
    expect(run(["lost", "lost"], { windowSize: 5, minHitRatePct: 30 }).firing).toBe(false);
  });

  it("is disabled without both window and floor", () => {
    expect(run(["lost", "lost", "lost", "lost", "lost"], { windowSize: 5 }).firing).toBe(false);
    expect(run(["lost", "lost", "lost", "lost", "lost"], { minHitRatePct: 30 }).firing).toBe(false);
  });

  it("streak takes trigger precedence when both fire", () => {
    const result = run(["lost", "lost", "lost", "lost", "lost"], { consecutiveLosses: 3, windowSize: 5, minHitRatePct: 30 });
    expect(result.trigger).toBe("streak");
  });
});

describe("evaluateAccuracyBreaker — recovery", () => {
  it("recovers when the M most-recent outcomes show no loss (default M=2)", () => {
    const result = run(["won", "flat", "lost", "lost", "lost"], { consecutiveLosses: 3, degraded: true });
    expect(result.firing).toBe(false);
    expect(result.recovered).toBe(true);
  });

  it("does not recover while any of the M most-recent outcomes is a loss", () => {
    expect(run(["won", "lost", "lost", "lost"], { consecutiveLosses: 3, degraded: true }).recovered).toBe(false);
    expect(run(["lost", "lost", "lost"], { consecutiveLosses: 3, degraded: true }).recovered).toBe(false);
  });

  it("does not recover on fewer than M decisive outcomes", () => {
    expect(run(["won"], { consecutiveLosses: 3, degraded: true }).recovered).toBe(false);
  });

  it("honors an explicit recoveryClean window", () => {
    expect(run(["won", "won", "lost", "lost", "lost"], { consecutiveLosses: 3, recoveryClean: 3, degraded: true }).recovered).toBe(false);
    expect(run(["flat", "won", "won", "lost"], { consecutiveLosses: 3, recoveryClean: 3, degraded: true }).recovered).toBe(true);
  });
});

describe("evaluateAccuracyBreaker — clamping and junk input", () => {
  it("clamps absurd thresholds instead of mis-firing", () => {
    // consecutiveLosses clamps to <= 50, so a 999 limit can never fire on real data.
    expect(run(Array(10).fill("lost"), { consecutiveLosses: 999 }).firing).toBe(false);
    // floor clamps to <= 100
    const result = run(["lost", "lost", "lost"], { windowSize: 3, minHitRatePct: 250 });
    expect(result.firing).toBe(true); // 0% < 100% clamped floor
  });

  it("handles an empty tape without firing or recovering", () => {
    expect(run([], { consecutiveLosses: 3 }).firing).toBe(false);
    expect(run([], { consecutiveLosses: 3, degraded: true }).recovered).toBe(false);
  });
});

describe("accuracy degraded marker (internal settings KV)", () => {
  it("set/get/clear round-trips per user+scope", async () => {
    const { getAccuracyDegradedMarker, setAccuracyDegradedMarker, clearAccuracyDegradedMarker } = await import("../src/lib/accuracy-breaker");
    expect(getAccuracyDegradedMarker("u1", "acct-a")).toBeUndefined();
    setAccuracyDegradedMarker("u1", "acct-a", { since: "2026-07-29T00:00:00Z", reason: "test", trigger: "streak", action: "advisory" });
    expect(getAccuracyDegradedMarker("u1", "acct-a")?.trigger).toBe("streak");
    // Scoped: a different account or user does not see it.
    expect(getAccuracyDegradedMarker("u1", "acct-b")).toBeUndefined();
    expect(getAccuracyDegradedMarker("u2", "acct-a")).toBeUndefined();
    clearAccuracyDegradedMarker("u1", "acct-a");
    expect(getAccuracyDegradedMarker("u1", "acct-a")).toBeUndefined();
  });
});

describe("listRecentDecisiveOutcomeStatuses", () => {
  function insertCase(db: import("better-sqlite3").Database, row: {
    id: string; userId?: string; accountId?: string; status: string; outcome?: unknown; createdAt: string; updatedAt: string;
  }) {
    db.prepare(
      `INSERT INTO socratic_decisions (id, user_id, connected_account_id, status, authority, thesis, rationale, action, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', 't', 'r', 'buy', ?, ?, ?)`
    ).run(row.id, row.userId ?? "local", row.accountId ?? null, row.status, row.outcome === undefined ? null : JSON.stringify(row.outcome), row.createdAt, row.updatedAt);
  }

  it("returns decisive outcomes on REAL decisions, newest first by measuredAt", async () => {
    const { getDb, listRecentDecisiveOutcomeStatuses } = await import("../src/lib/db");
    const db = getDb();
    insertCase(db, { id: "a", accountId: "acct-1", status: "filled", outcome: { status: "won", measuredAt: "2026-07-27T00:00:00Z" }, createdAt: "2026-07-26T00:00:00Z", updatedAt: "2026-07-27T00:00:00Z" });
    insertCase(db, { id: "b", accountId: "acct-1", status: "placed", outcome: { status: "lost", measuredAt: "2026-07-28T00:00:00Z" }, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-28T00:00:00Z" });
    insertCase(db, { id: "c", accountId: "acct-1", status: "filled", outcome: { status: "flat", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    const rows = listRecentDecisiveOutcomeStatuses("local", "acct-1");
    expect(rows.map((r) => r.status)).toEqual(["flat", "lost", "won"]);
  });

  it("excludes counterfactual (blocked/rejected) outcomes — avoiding a bad trade is not a miss", async () => {
    const { getDb, listRecentDecisiveOutcomeStatuses } = await import("../src/lib/db");
    const db = getDb();
    insertCase(db, { id: "a", accountId: "acct-1", status: "blocked", outcome: { status: "lost", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    insertCase(db, { id: "b", accountId: "acct-1", status: "rejected", outcome: { status: "lost", measuredAt: "2026-07-28T00:00:00Z" }, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-28T00:00:00Z" });
    insertCase(db, { id: "c", accountId: "acct-1", status: "filled", outcome: { status: "won", measuredAt: "2026-07-27T00:00:00Z" }, createdAt: "2026-07-26T00:00:00Z", updatedAt: "2026-07-27T00:00:00Z" });
    expect(listRecentDecisiveOutcomeStatuses("local", "acct-1").map((r) => r.status)).toEqual(["won"]);
  });

  it("excludes non-decisive terminals (unknown/unresolvable) and still-open cases", async () => {
    const { getDb, listRecentDecisiveOutcomeStatuses } = await import("../src/lib/db");
    const db = getDb();
    insertCase(db, { id: "a", accountId: "acct-1", status: "filled", outcome: { status: "unknown", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    insertCase(db, { id: "b", accountId: "acct-1", status: "filled", outcome: { status: "unresolvable", measuredAt: "2026-07-28T00:00:00Z" }, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-28T00:00:00Z" });
    insertCase(db, { id: "c", accountId: "acct-1", status: "filled", outcome: { status: "open" }, createdAt: "2026-07-27T00:00:00Z", updatedAt: "2026-07-27T00:00:00Z" });
    insertCase(db, { id: "d", accountId: "acct-1", status: "filled", outcome: { status: "lost", measuredAt: "2026-07-26T00:00:00Z" }, createdAt: "2026-07-25T00:00:00Z", updatedAt: "2026-07-26T00:00:00Z" });
    expect(listRecentDecisiveOutcomeStatuses("local", "acct-1").map((r) => r.status)).toEqual(["lost"]);
  });

  it("scopes by user and connected account", async () => {
    const { getDb, listRecentDecisiveOutcomeStatuses } = await import("../src/lib/db");
    const db = getDb();
    insertCase(db, { id: "a", accountId: "acct-1", status: "filled", outcome: { status: "lost", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    insertCase(db, { id: "b", accountId: "acct-2", status: "filled", outcome: { status: "won", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    insertCase(db, { id: "c", userId: "other-user", accountId: "acct-1", status: "filled", outcome: { status: "won", measuredAt: "2026-07-29T00:00:00Z" }, createdAt: "2026-07-28T00:00:00Z", updatedAt: "2026-07-29T00:00:00Z" });
    expect(listRecentDecisiveOutcomeStatuses("local", "acct-1").map((r) => r.status)).toEqual(["lost"]);
    expect(listRecentDecisiveOutcomeStatuses("local", "acct-2").map((r) => r.status)).toEqual(["won"]);
  });
});
