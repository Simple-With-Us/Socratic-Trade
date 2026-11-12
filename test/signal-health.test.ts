// Live signal-health monitor (r2 lesson: health). Verifies: the pure diagnostics recover a known
// IC sign/magnitude from synthetic observations (congress-score.test.ts's structure), quantile
// buckets and top-K Jaccard churn match hand-computed values, the drift detector fires on
// consecutive declines / negative slope and stays quiet otherwise, the daily lane persists
// snapshot rows only at/above the observation floor (below = NO row, never a fabricated
// diagnostic), the once-per-UTC-day marker gates re-runs, and drift alarms are edge-triggered
// (audit on raise, cleared state + audit on recovery).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSignalHealthObservations,
  computeQuantileBuckets,
  computeRankIC,
  computeTopKChurn,
  detectDrift,
  olsSlope,
  pairGrossNet,
  SIGNAL_HEALTH_MIN_OBSERVATIONS,
  type SignalHealthObservation
} from "../src/lib/signal-health";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-signal-health-${randomUUID()}.db`)}`;
});

/** Synthetic (score, return) pairs: return tracks score (positive IC) or its negation, with a
 * deterministic wiggle LARGER than the step so a few adjacent ranks invert — the IC stays
 * strongly signed without degenerating to a perfect ±1 correlation. */
function syntheticObservations(count: number, opts: { invert?: boolean; date?: string } = {}): SignalHealthObservation[] {
  return Array.from({ length: count }, (_, i) => {
    const score = 30 + i * 2;
    const wiggle = ((i % 3) - 1) * 0.6;
    const ret = i * 0.4 - (count * 0.4) / 2 + wiggle;
    return {
      date: opts.date ?? "2026-08-10",
      symbol: `SY${i}`,
      score,
      returnPct: opts.invert ? -ret : ret
    };
  });
}

describe("signal-health pure diagnostics", () => {
  it("recovers a strongly positive rank IC (with significant t-stat) from a monotone signal", () => {
    const rank = computeRankIC(syntheticObservations(30));
    expect(rank).toBeDefined();
    expect(rank!.rankIC).toBeGreaterThan(0.9);
    expect(rank!.tStat).toBeGreaterThan(2);
    expect(rank!.nObservations).toBe(30);
    expect(rank!.nDates).toBe(1);
  });

  it("recovers the negative sign when the signal is inverted", () => {
    const rank = computeRankIC(syntheticObservations(30, { invert: true }));
    expect(rank).toBeDefined();
    expect(rank!.rankIC).toBeLessThan(-0.9);
    expect(rank!.tStat).toBeLessThan(-2);
  });

  it("is undefined below 3 observations and on zero score variance — never fabricated", () => {
    expect(computeRankIC(syntheticObservations(2))).toBeUndefined();
    const flat = syntheticObservations(10).map((obs) => ({ ...obs, score: 50 }));
    expect(computeRankIC(flat)).toBeUndefined();
  });

  it("computes hand-checkable quantile buckets (bucket 1 = lowest confidence)", () => {
    // Scores 1..10; returns: bottom half loses (-1 each except one +1), top half wins (+2 each).
    const observations: SignalHealthObservation[] = Array.from({ length: 10 }, (_, i) => ({
      date: "2026-08-10",
      symbol: `S${i}`,
      score: i + 1,
      returnPct: i < 5 ? (i === 4 ? 1 : -1) : 2
    }));
    const buckets = computeQuantileBuckets(observations, 2);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toEqual({ bucket: 1, n: 5, avgReturn: -0.6, hitRate: 0.2 });
    expect(buckets[1]).toEqual({ bucket: 2, n: 5, avgReturn: 2, hitRate: 1 });
  });

  it("computes hand-checked consecutive-day top-K Jaccard churn", () => {
    // Day1 top-2 {A,B}, day2 top-2 {B,C}, day3 top-2 {C,D}: each pair shares 1 of 3 union
    // members, Jaccard distance 2/3 -> mean churn 66.6667%.
    const obs: SignalHealthObservation[] = [
      { date: "2026-08-10", symbol: "A", score: 90, returnPct: 0 },
      { date: "2026-08-10", symbol: "B", score: 80, returnPct: 0 },
      { date: "2026-08-10", symbol: "X", score: 10, returnPct: 0 },
      { date: "2026-08-11", symbol: "B", score: 90, returnPct: 0 },
      { date: "2026-08-11", symbol: "C", score: 80, returnPct: 0 },
      { date: "2026-08-11", symbol: "X", score: 10, returnPct: 0 },
      { date: "2026-08-12", symbol: "C", score: 90, returnPct: 0 },
      { date: "2026-08-12", symbol: "D", score: 80, returnPct: 0 },
      { date: "2026-08-12", symbol: "X", score: 10, returnPct: 0 }
    ];
    expect(computeTopKChurn(obs, 2)).toBeCloseTo(66.6667, 3);
    // Identical top sets -> zero churn; a single day -> undefined (no pair to compare).
    expect(computeTopKChurn(obs.filter((o) => o.date === "2026-08-10"), 2)).toBeUndefined();
    const stable = obs.map((o) => ({ ...o, symbol: o.score >= 80 ? (o.score === 90 ? "A" : "B") : "X" }));
    expect(computeTopKChurn(stable, 2)).toBe(0);
  });

  it("debits the round-trip cost estimate from gross (backtest cost convention)", () => {
    const { grossReturnPct, netOfCostReturnPct } = pairGrossNet([
      { date: "d", symbol: "A", score: 1, returnPct: 1 },
      { date: "d", symbol: "B", score: 2, returnPct: 3 }
    ]);
    expect(grossReturnPct).toBe(2);
    expect(netOfCostReturnPct).toBe(1.8); // 20 bps = 0.2 percentage points
  });

  it("detects drift on N consecutive declining windows", () => {
    const result = detectDrift([0.5, 0.4, 0.3, 0.2]);
    expect(result.drifting).toBe(true);
    expect(result.trailingDeclines).toBe(3);
    expect(result.reasons.join(" ")).toContain("3 consecutive windows");
  });

  it("detects drift on a negative slope over enough windows even without consecutive declines", () => {
    const series = [0.5, 0.45, 0.5, 0.4, 0.42]; // last step rises; OLS slope -0.021/window
    expect(olsSlope(series)).toBeCloseTo(-0.021, 4);
    const result = detectDrift(series);
    expect(result.trailingDeclines).toBe(0);
    expect(result.drifting).toBe(true);
    expect(result.reasons.join(" ")).toContain("negative");
  });

  it("stays quiet on rising or short series", () => {
    expect(detectDrift([0.1, 0.2, 0.3, 0.4, 0.5]).drifting).toBe(false);
    expect(detectDrift([0.3, 0.2]).drifting).toBe(false);
    expect(detectDrift([]).drifting).toBe(false);
  });

  it("builds observations only from finite confidence + resolved horizon returns", () => {
    const rows = [
      {
        id: "d1",
        symbol: "aapl",
        side: "buy",
        confidenceScore: 70,
        createdAt: "2026-08-10T15:00:00.000Z",
        outcomes: [{ horizon: "1d", returnPct: 1.5, resolution: "ok" }]
      },
      {
        id: "d2",
        symbol: "MSFT",
        side: "buy",
        confidenceScore: 60,
        createdAt: "2026-08-10T15:00:00.000Z",
        outcomes: [{ horizon: "1d", resolution: "unresolvable" }]
      },
      {
        id: "d3",
        symbol: "NVDA",
        side: "sell",
        confidenceScore: 55,
        createdAt: "2026-08-10T15:00:00.000Z",
        outcomes: [{ horizon: "1w", returnPct: -2, resolution: "ok" }]
      }
    ];
    const oneDay = buildSignalHealthObservations(rows, "1d");
    expect(oneDay).toEqual([{ date: "2026-08-10", symbol: "AAPL", score: 70, returnPct: 1.5 }]);
    expect(buildSignalHealthObservations(rows, "1w")).toHaveLength(1);
  });
});

/** Seed one decision case with a confidence score and a matured 1d outcome, pinned to a date. */
async function seedDecision(input: {
  userId: string;
  symbol: string;
  confidenceScore: number;
  returnPct: number;
  createdAt: string;
}): Promise<string> {
  const { upsertSocraticDecisionCase, getDb } = await import("../src/lib/db");
  const id = upsertSocraticDecisionCase({
    userId: input.userId,
    proposalId: `p-${randomUUID()}`,
    symbol: input.symbol,
    side: "buy",
    status: "placed",
    authority: "decide",
    thesis: "Value-Quality",
    rationale: "fixture",
    action: `BUY ${input.symbol} $100`,
    confidenceScore: input.confidenceScore,
    outcome: {
      status: input.returnPct > 0 ? "won" : input.returnPct < 0 ? "lost" : "flat",
      returnPct: input.returnPct,
      outcomes: [{ horizon: "1d", returnPct: input.returnPct, resolution: "ok" }]
    }
  });
  getDb().prepare("UPDATE socratic_decisions SET created_at = ? WHERE id = ?").run(input.createdAt, id);
  return id;
}

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

/** Seed `count` matured decisions across three days whose returns track (or invert) confidence. */
async function seedMaturedDecisions(userId: string, count: number, opts: { invert?: boolean } = {}): Promise<void> {
  // Relative to the injected NOW so the 90-day observation window never ages out of the fixtures.
  const days = [
    new Date(NOW - 4 * 86_400_000).toISOString(),
    new Date(NOW - 3 * 86_400_000).toISOString(),
    new Date(NOW - 2 * 86_400_000).toISOString()
  ];
  for (let i = 0; i < count; i++) {
    const raw = i * 0.4 - (count * 0.4) / 2 + ((i % 3) - 1) * 0.6;
    await seedDecision({
      userId,
      symbol: `SY${i}`,
      confidenceScore: 30 + i * 2,
      returnPct: opts.invert ? -raw : raw,
      createdAt: days[i % days.length]
    });
  }
}

describe("signal-health refresh lane", () => {
  it("persists a snapshot row at/above the observation floor, with honest per-horizon gaps", async () => {
    const userId = `sh-write-${randomUUID()}`;
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS + 4);
    const { runSignalHealthRefresh } = await import("../src/lib/signal-health");
    const { listSignalHealthSnapshots } = await import("../src/lib/db");

    const result = await runSignalHealthRefresh(userId, { now: NOW });
    expect(result.horizons.find((h) => h.horizon === "1d")?.written).toBe(true);
    // No 1w outcomes were seeded -> no 1w row, not a zero-filled one.
    expect(result.horizons.find((h) => h.horizon === "1w")?.written).toBe(false);
    expect(listSignalHealthSnapshots(userId, { horizon: "1w" })).toHaveLength(0);

    const [snap] = listSignalHealthSnapshots(userId, { horizon: "1d" });
    expect(snap).toBeDefined();
    expect(snap.periodEnd).toBe("2026-08-12");
    expect(snap.nObservations).toBe(SIGNAL_HEALTH_MIN_OBSERVATIONS + 4);
    expect(snap.nDates).toBe(3);
    expect(snap.rankIC).toBeGreaterThan(0.9);
    expect(snap.tStat).toBeGreaterThan(2);
    expect(snap.quantileBuckets.reduce((sum, bucket) => sum + bucket.n, 0)).toBe(SIGNAL_HEALTH_MIN_OBSERVATIONS + 4);
    expect(snap.topKChurnPct).toBeDefined();
    expect(snap.grossReturnPct - snap.netOfCostReturnPct).toBeCloseTo(0.2, 6);
    // First window: no rolling slope yet.
    expect(snap.rollingRankICSlope).toBeUndefined();
  });

  it("writes NO row below the minimum observation count", async () => {
    const userId = `sh-floor-${randomUUID()}`;
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS - 1);
    const { runSignalHealthRefresh } = await import("../src/lib/signal-health");
    const { listSignalHealthSnapshots } = await import("../src/lib/db");

    const result = await runSignalHealthRefresh(userId, { now: NOW });
    expect(result.horizons.every((h) => !h.written)).toBe(true);
    expect(listSignalHealthSnapshots(userId, { horizon: "1d" })).toHaveLength(0);
  });

  it("gates on the once-per-UTC-day marker", async () => {
    const userId = `sh-due-${randomUUID()}`;
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS + 2);
    const { runSignalHealthRefreshIfDue } = await import("../src/lib/signal-health");

    expect(await runSignalHealthRefreshIfDue(userId, NOW)).toBeDefined();
    expect(await runSignalHealthRefreshIfDue(userId, NOW + 60_000)).toBeUndefined();
    // A new UTC day is due again.
    expect(await runSignalHealthRefreshIfDue(userId, NOW + 86_400_000)).toBeDefined();
  });

  it("raises the drift alarm edge-triggered (audit + active state) and clears it on recovery", async () => {
    const userId = `sh-drift-${randomUUID()}`;
    // Inverted signal -> today's rank IC is strongly negative, below the seeded prior series.
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS + 4, { invert: true });
    const { runSignalHealthRefresh, signalHealthDriftActive } = await import("../src/lib/signal-health");
    const { upsertSignalHealthSnapshot, listAuditByKind } = await import("../src/lib/db");
    const priorBase = { userId, horizon: "1d", tStat: 3, nObservations: 30, nDates: 5, quantileBuckets: [], grossReturnPct: 1, netOfCostReturnPct: 0.8 };
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-09", rankIC: 0.8 });
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-10", rankIC: 0.7 });
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-11", rankIC: 0.6 });

    const result = await runSignalHealthRefresh(userId, { now: NOW });
    expect(result.horizons.find((h) => h.horizon === "1d")?.drifting).toBe(true);
    const alarm = signalHealthDriftActive(userId);
    expect(alarm.active).toBe(true);
    expect(alarm.horizons).toEqual(["1d"]);
    expect(alarm.detectedAt).toBeDefined();
    const raised = listAuditByKind("signal_health_drift", 10, userId);
    expect(raised.length).toBe(1);

    // Second pass while still drifting: state stays active, no duplicate raise audit.
    await runSignalHealthRefresh(userId, { now: NOW + 86_400_000 });
    expect(signalHealthDriftActive(userId).active).toBe(true);
    expect(listAuditByKind("signal_health_drift", 10, userId).length).toBe(1);

    // Recovery: replace history with a rising series and a positively-tracking signal.
    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM signal_health_snapshot WHERE user_id = ?").run(userId);
    getDb().prepare("DELETE FROM socratic_decisions WHERE user_id = ?").run(userId);
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS + 4);
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-12", rankIC: 0.5 });
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-13", rankIC: 0.6 });
    const recovery = await runSignalHealthRefresh(userId, { now: NOW + 2 * 86_400_000 });
    expect(recovery.horizons.find((h) => h.horizon === "1d")?.drifting).toBe(false);
    expect(signalHealthDriftActive(userId).active).toBe(false);
    expect(listAuditByKind("signal_health_drift_cleared", 10, userId).length).toBe(1);
  });

  it("does NOT deliver signal_health when the user has that event switched off — no force-include (owner ruling 2026-08-12)", async () => {
    const userId = `sh-toggle-off-${randomUUID()}`;
    // Inverted signal -> drift alarm fires, exactly like the raise test above (same prior-history
    // seeding — the detector needs a declining baseline to fire against).
    await seedMaturedDecisions(userId, SIGNAL_HEALTH_MIN_OBSERVATIONS + 4, { invert: true });
    const { getPolicy, setPolicy, listNotificationEvents, upsertSignalHealthSnapshot } = await import("../src/lib/db");
    const { runSignalHealthRefresh, signalHealthDriftActive } = await import("../src/lib/signal-health");
    const priorBase = { userId, horizon: "1d", tStat: 3, nObservations: 30, nDates: 5, quantileBuckets: [], grossReturnPct: 1, netOfCostReturnPct: 0.8 };
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-09", rankIC: 0.8 });
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-10", rankIC: 0.7 });
    upsertSignalHealthSnapshot({ ...priorBase, periodEnd: "2026-08-11", rankIC: 0.6 });

    const policy = getPolicy(userId);
    setPolicy(
      {
        ...policy,
        notificationSettings: {
          ...policy.notificationSettings,
          enabledEvents: policy.notificationSettings.enabledEvents.filter((type) => type !== "signal_health")
        }
      },
      userId
    );
    expect(getPolicy(userId).notificationSettings.enabledEvents).not.toContain("signal_health");

    const result = await runSignalHealthRefresh(userId, { now: NOW });
    // The alarm still fires and is still tracked internally — only DELIVERY is gated by the toggle.
    expect(result.horizons.find((h) => h.horizon === "1d")?.drifting).toBe(true);
    expect(signalHealthDriftActive(userId).active).toBe(true);

    const events = listNotificationEvents(userId, 50);
    const signalHealthEvent = events.find((event) => event.type === "signal_health");
    expect(signalHealthEvent).toBeDefined();
    expect(signalHealthEvent?.status).toBe("skipped");
    expect(signalHealthEvent?.error).toBe("Notification type is disabled.");
  });
});
