import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { materializeSkippedCandidateCounterfactuals, type CounterfactualOHLCFetcher } from "../src/lib/counterfactual-learning";
import {
  audit,
  insertSkippedCounterfactualCandidate,
  listMaturedSkippedCounterfactuals,
  listSkippedCounterfactualsByStatus,
  markSkippedCounterfactualMatured,
  markSkippedCounterfactualUnresolvable,
  skippedCounterfactualId,
  updateSkippedCounterfactualOutcomes
} from "../src/lib/db";
import { getSkippedCandidateReturns } from "../src/lib/performance";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-counterfactual-${randomUUID()}.db`)}`;
});

const momentumBreakdown = {
  liquidity: 20,
  momentum: 95,
  value: 30,
  quality: 25,
  volatility: 15,
  sentiment: 40,
  positioning: 35,
  diversification: 10,
  weightedTotal: 76
};

describe("counterfactual skipped-candidate learning", () => {
  it("materializes mature skipped returns idempotently from signal_snapshot evidence", async () => {
    const userId = `cf-idem-${randomUUID()}`;
    // 2026-06-10 is a Wednesday; 5 TRADING days later (Thu/Fri/Mon/Tue/Wed, no holidays in
    // between) lands on 2026-06-17 — NOT the calendar-day "2026-06-15" this fixture used
    // before the trading-day-horizon fix (see docs/rollouts/2026-07-04-w1-learning-loops.md).
    const fetchOHLC: CounterfactualOHLCFetcher = async () => [
      { time: "2026-06-10", close: 100 },
      { time: "2026-06-17", close: 115 }
    ];

    audit("signal_snapshot", {
      runId: "run-cf-idem",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [
        {
          symbol: "AAPL",
          chosen: false,
          refPrice: 100,
          score: 88,
          sector: "Technology",
          regime: "Risk-On",
          factorBreakdown: momentumBreakdown,
          bulletins: ["AAPL had a bullish technical setup."]
        },
        { symbol: "MSFT", chosen: true, refPrice: 50, score: 90 }
      ]
    }, userId);

    const first = await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });
    const second = await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    expect(first).toMatchObject({ auditRowsScanned: 1, candidatesInserted: 1, pendingChecked: 1, materialized: 1 });
    expect(second).toMatchObject({ auditRowsScanned: 0, candidatesInserted: 0, pendingChecked: 0, materialized: 0 });

    const rows = listMaturedSkippedCounterfactuals(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: "run-cf-idem",
      symbol: "AAPL",
      refPrice: 100,
      exitDate: "2026-06-17",
      exitPrice: 115,
      returnPct: 15,
      dominantFactor: "momentum"
    });

    const promptRows = getSkippedCandidateReturns({}, userId, { maxAgeDays: 10_000 });
    expect(promptRows).toHaveLength(1);
    expect(promptRows[0]).toMatchObject({ symbol: "AAPL", returnPct: 15, currentPrice: 115 });
  });

  it("ST-4589 B12: an after-hours ET snapshot anchors its daily horizons on the ET market day, not the UTC date", async () => {
    const userId = `cf-etday-${randomUUID()}`;
    // Wed 2026-06-10 11:30 PM ET == Thu 2026-06-11 03:30 UTC.
    const fetchOHLC: CounterfactualOHLCFetcher = async () => [
      { time: "2026-06-10", close: 100 },
      { time: "2026-06-11", close: 110 },
      { time: "2026-06-12", close: 120 },
      { time: "2026-06-17", close: 125 },
      { time: "2026-06-18", close: 130 }
    ];
    audit("signal_snapshot", {
      runId: "run-cf-etday",
      asOf: "2026-06-11T03:30:00.000Z",
      signals: [{ symbol: "NVDA", chosen: false, refPrice: 100, score: 80 }]
    }, userId);

    await materializeSkippedCandidateCounterfactuals(userId, {
      now: Date.parse("2026-06-25T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    const row = listMaturedSkippedCounterfactuals(userId)[0];
    const oneDay = row?.outcomes?.find((r) => r.horizon === "1d");
    // ET basis Wed 06-10 -> 1d target Thu 06-11 (close 110 = +10%). The UTC basis (Thu 06-11)
    // would have read Fri 06-12 (+20%).
    expect(oneDay?.priceBasis).toContain("daily_close(2026-06-11)");
    expect(oneDay?.returnPct).toBeCloseTo(10, 2);
  });

  it("keeps materialization scoped by user even for the same run and symbol", async () => {
    const userA = `cf-user-a-${randomUUID()}`;
    const userB = `cf-user-b-${randomUUID()}`;
    const calls: string[] = [];
    // 5 TRADING days after Wed 2026-06-10 lands on 2026-06-17 (see the fixture above).
    const fetchOHLC: CounterfactualOHLCFetcher = async (symbol, _now, userId) => {
      calls.push(`${userId}:${symbol}`);
      return [
        { time: "2026-06-10", close: 70 },
        { time: "2026-06-17", close: 80 }
      ];
    };

    audit("signal_snapshot", {
      runId: "run-cf-users",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [{ symbol: "NVDA", chosen: false, refPrice: 100, score: 80, regime: "Risk-On" }]
    }, userA);
    audit("signal_snapshot", {
      runId: "run-cf-users",
      asOf: "2026-06-10T14:30:00.000Z",
      signals: [{ symbol: "NVDA", chosen: false, refPrice: 50, score: 80, regime: "Risk-On" }]
    }, userB);

    await materializeSkippedCandidateCounterfactuals(userA, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    expect(listMaturedSkippedCounterfactuals(userA)).toHaveLength(1);
    expect(listMaturedSkippedCounterfactuals(userB)).toHaveLength(0);

    await materializeSkippedCandidateCounterfactuals(userB, {
      now: Date.parse("2026-06-20T00:00:00.000Z"),
      horizonDays: 5,
      fetchOHLC
    });

    const rowA = listMaturedSkippedCounterfactuals(userA)[0];
    const rowB = listMaturedSkippedCounterfactuals(userB)[0];
    expect(rowA.returnPct).toBe(-20);
    expect(rowB.returnPct).toBe(60);
    // The materializer now also fetches one SPY series per run (for the multi-horizon rows'
    // SPY-relative excess) before the per-candidate fetches.
    expect(calls).toEqual([`${userA}:SPY`, `${userA}:NVDA`, `${userB}:SPY`, `${userB}:NVDA`]);
  });

  it("markSkippedCounterfactualMatured re-merges at write time so a concurrently-written worker row survives a stale caller (Finding 1 regression)", async () => {
    const userId = `cf-lost-update-matured-${randomUUID()}`;
    const runId = "run-lu-matured";
    const symbol = "AAPL";
    const horizonDays = 5;
    const id = skippedCounterfactualId(userId, runId, symbol, horizonDays);

    insertSkippedCounterfactualCandidate({
      userId,
      runId,
      symbol,
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 100,
      horizonDays,
      targetDate: "2026-06-17",
      now: "2026-06-10T14:30:00.000Z"
    });

    // Simulate the durable due-jobs WORKER resolving the 15m horizon mid-pass, persisted through
    // the same low-level updater the worker path uses (writeIntradaySampleRow ->
    // updateSkippedCounterfactualOutcomes).
    updateSkippedCounterfactualOutcomes(id, userId, [
      { horizon: "15m", returnPct: 2.5, maturedAt: "2026-06-10T14:45:00.000Z", priceBasis: "ref_price->live_quote(+15m)", resolution: "ok" }
    ]);

    // Now the counterfactual materializer's own maturation write fires with a STALE `outcomes` array
    // built before the worker's write above (no 15m row at all — only the 1d/1w rows it just
    // computed from daily bars).
    const staleOutcomes = [
      { horizon: "1d" as const, returnPct: 4, maturedAt: "2026-06-17T00:00:00.000Z", priceBasis: "ref_price->daily_close(2026-06-11)", resolution: "ok" as const }
    ];
    const wrote = markSkippedCounterfactualMatured({
      id,
      userId,
      exitDate: "2026-06-17",
      exitPrice: 115,
      returnPct: 15,
      outcomes: staleOutcomes,
      checkedAt: "2026-06-17T00:00:00.000Z"
    });
    expect(wrote).toBe(true);

    // The worker-written 15m row must SURVIVE the stale terminal write, and the caller's own new 1d
    // row must also be present — a real merge, not a partial overwrite.
    const [row] = listMaturedSkippedCounterfactuals(userId);
    const row15m = row?.outcomes?.find((r) => r.horizon === "15m");
    const row1d = row?.outcomes?.find((r) => r.horizon === "1d");
    expect(row15m?.resolution).toBe("ok");
    expect(row15m?.returnPct).toBe(2.5);
    expect(row1d?.resolution).toBe("ok");
    expect(row1d?.returnPct).toBe(4);
  });

  it("markSkippedCounterfactualUnresolvable re-merges at write time so a concurrently-written worker row survives a stale caller (Finding 1 regression)", async () => {
    const userId = `cf-lost-update-unresolvable-${randomUUID()}`;
    const runId = "run-lu-unresolvable";
    const symbol = "ZZZZ";
    const horizonDays = 5;
    const id = skippedCounterfactualId(userId, runId, symbol, horizonDays);

    insertSkippedCounterfactualCandidate({
      userId,
      runId,
      symbol,
      snapshotAt: "2026-06-10T14:30:00.000Z",
      refPrice: 40,
      horizonDays,
      targetDate: "2026-06-17",
      now: "2026-06-10T14:30:00.000Z"
    });

    // Worker writes the 15m row first.
    updateSkippedCounterfactualOutcomes(id, userId, [
      { horizon: "15m", returnPct: -1.2, maturedAt: "2026-06-10T14:45:00.000Z", priceBasis: "ref_price->live_quote(+15m)", resolution: "ok" }
    ]);

    // Terminal 'unresolvable' write (delisted symbol, no price series) fires with a stale outcomes
    // snapshot that has no 15m row.
    const wrote = markSkippedCounterfactualUnresolvable({
      id,
      userId,
      reason: "no_price_series",
      outcomes: [{ horizon: "1d", maturedAt: "2026-06-17T00:00:00.000Z", priceBasis: "ref_price->daily_close", resolution: "unresolvable", reason: "no_price_series" }],
      checkedAt: "2026-06-17T00:00:00.000Z"
    });
    expect(wrote).toBe(true);

    const [row] = listSkippedCounterfactualsByStatus(userId, "unresolvable");
    const row15m = row?.outcomes?.find((r) => r.horizon === "15m");
    expect(row15m?.resolution).toBe("ok");
    expect(row15m?.returnPct).toBe(-1.2);
  });
});
