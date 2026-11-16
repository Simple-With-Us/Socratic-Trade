import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getThesisScorecard, getThesisRegimeScorecard } from "../src/lib/performance";
import type { FillEvent, OrderSide } from "../src/lib/types";

// Payoff-split fields (avgWinPct/avgLossPct/downsideDeviationPct/winCount/lossCount) added to
// aggregateClosedLots for the Fractional-Kelly sizing advisory (docs/reviews/2026-07-04-composite-
// expert-review.md:449). These are additive to ThesisStat/ThesisRegimeStat — existing consumers
// (winRate, avgReturnPct, shrunkWinRate, shrunkAvgReturnPct) are unaffected; verified untouched here too.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-payoff-stats-${randomUUID()}.db`)}`;
});

function fill(input: Partial<FillEvent> & { id: string; side: OrderSide; quantity: number; price: number; notional: number }): FillEvent {
  return {
    proposalId: "p1",
    runId: "r1",
    accountNumber: "A1",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    brokerOrderId: undefined,
    raw: undefined,
    filledAt: "2026-06-15T00:00:01.000Z",
    ...input
  };
}

/** Seed `count` closed round-trips for a thesis/regime; first `wins` are winners (+winPct%), rest losers (-lossPct%). */
async function seedClosedLots(opts: {
  account: string;
  thesisTag: string;
  regime: string;
  count: number;
  wins: number;
  winPct: number;
  lossPct: number;
}) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, thesisTag, regime, count, wins, winPct, lossPct } = opts;
  let t = 0;
  for (let i = 0; i < count; i++) {
    const sym = `SYM${thesisTag}${i}`;
    const entry = 100;
    const exit = i < wins ? entry * (1 + winPct / 100) : entry * (1 - lossPct / 100);
    insertFillEvent(
      fill({
        id: `pf-b-${thesisTag}-${i}`,
        side: "buy",
        quantity: 1,
        price: entry,
        notional: entry,
        accountNumber: account,
        symbol: sym,
        filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`,
        raw: { proposal: { tradeThesisTag: thesisTag, entryMarketRegime: regime } }
      })
    );
    insertFillEvent(
      fill({
        id: `pf-s-${thesisTag}-${i}`,
        side: "sell",
        quantity: 1,
        price: exit,
        notional: exit,
        accountNumber: account,
        symbol: sym,
        filledAt: `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`
      })
    );
  }
}

describe("payoff-split stats on getThesisScorecard", () => {
  it("computes avgWinPct/avgLossPct/downsideDeviationPct/winCount/lossCount for a mixed bucket", async () => {
    const account = "PAYOFF-1";
    // 3 winners at +20%, 2 losers at -10%.
    await seedClosedLots({ account, thesisTag: "Mixed", regime: "Tech-Bull", count: 5, wins: 3, winPct: 20, lossPct: 10 });

    const scorecard = getThesisScorecard(account, "paper");
    const stat = scorecard.find((s) => s.thesisTag === "Mixed")!;
    expect(stat).toBeDefined();

    // Existing fields unaffected.
    expect(stat.trades).toBe(5);
    expect(stat.winRate).toBe(60);

    // avgWinPct: mean of [20,20,20] = 20.
    expect(stat.avgWinPct).toBeCloseTo(20, 5);
    // avgLossPct: mean of |[-10,-10]| = 10 (positive number).
    expect(stat.avgLossPct).toBeCloseTo(10, 5);
    expect(stat.winCount).toBe(3);
    expect(stat.lossCount).toBe(2);
    // downsideDeviationPct: sqrt(mean(min(r,0)^2)) over ALL 5 lots:
    // winners contribute 0, losers contribute (-10)^2=100 each -> mean = (0+0+0+100+100)/5 = 40 -> sqrt(40)=6.3246
    expect(stat.downsideDeviationPct).toBeCloseTo(Math.sqrt(40), 2);
  });

  it("no losers in the bucket -> avgLossPct undefined (never fabricated)", async () => {
    const account = "PAYOFF-2";
    await seedClosedLots({ account, thesisTag: "AllWinners", regime: "Tech-Bull", count: 4, wins: 4, winPct: 15, lossPct: 5 });

    const scorecard = getThesisScorecard(account, "paper");
    const stat = scorecard.find((s) => s.thesisTag === "AllWinners")!;
    expect(stat.winCount).toBe(4);
    expect(stat.lossCount).toBe(0);
    expect(stat.avgWinPct).toBeCloseTo(15, 5);
    expect(stat.avgLossPct).toBeUndefined();
    // No losers -> downside-clamped sum is all zeros -> downsideDeviationPct is 0 (defined, not undefined:
    // "no losers" is itself a well-defined zero-downside answer, unlike the payoff RATIO which needs both sides).
    expect(stat.downsideDeviationPct).toBe(0);
  });

  it("no winners in the bucket -> avgWinPct undefined (never fabricated)", async () => {
    const account = "PAYOFF-3";
    await seedClosedLots({ account, thesisTag: "AllLosers", regime: "High-Vol", count: 3, wins: 0, winPct: 15, lossPct: 8 });

    const scorecard = getThesisScorecard(account, "paper");
    const stat = scorecard.find((s) => s.thesisTag === "AllLosers")!;
    expect(stat.winCount).toBe(0);
    expect(stat.lossCount).toBe(3);
    expect(stat.avgWinPct).toBeUndefined();
    expect(stat.avgLossPct).toBeCloseTo(8, 5);
    expect(stat.downsideDeviationPct).toBeCloseTo(8, 5); // all lots are -8% -> sqrt(mean(64)) = 8
  });

  it("propagates the same payoff-split fields onto getThesisRegimeScorecard", async () => {
    const account = "PAYOFF-4";
    await seedClosedLots({ account, thesisTag: "ComboThesis", regime: "Choppy", count: 4, wins: 2, winPct: 10, lossPct: 5 });

    const combo = getThesisRegimeScorecard(account, "paper");
    const stat = combo.find((s) => s.thesisTag === "ComboThesis" && s.regime === "Choppy")!;
    expect(stat).toBeDefined();
    expect(stat.winCount).toBe(2);
    expect(stat.lossCount).toBe(2);
    expect(stat.avgWinPct).toBeCloseTo(10, 5);
    expect(stat.avgLossPct).toBeCloseTo(5, 5);
  });
});
