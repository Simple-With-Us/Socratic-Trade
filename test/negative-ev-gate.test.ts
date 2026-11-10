import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { ThesisStat, ThesisRegimeStat } from "../src/lib/performance";
import type { TradeProposal, TradingPolicy } from "../src/lib/types";
import { selectThesisStat, shouldSkipNegativeExpectancy } from "../src/lib/strategy-risk";

// OPTIONAL negative-expectancy skip gate (policy.tuning.skipNegativeExpectancy, default OFF): skip an
// opening proposal whose PROVEN thesis (>= minClosedLotsForWeightShift closed lots) has a shrunk
// realized avg edge (already net of the paper cost model) <= skipNegativeExpectancyEdgePct. Unproven
// theses and exits are never skipped (the sizer's exploratory floor on unproven theses is intentional).

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-negev-${randomUUID()}.db`)}`;
});

const THESIS = "Momentum-Breakout";
const REGIME = "Tech-Bull";

function proposal(side: TradeProposal["side"] = "buy"): TradeProposal {
  return {
    symbol: "NVDA",
    side,
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: THESIS,
    entryMarketRegime: REGIME,
    confidenceScore: 90
  };
}

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return { ...DEFAULT_POLICY, accountNumber: account, maxOrderNotional: 10_000, tuning };
}

/** Seed `count` closed THESIS@REGIME round-trips; first `wins` are winners (+winPct%), rest losers (-lossPct%). */
async function seedClosedLots(opts: { account: string; count: number; wins: number; winPct: number; lossPct: number }) {
  const { insertFillEvent } = await import("../src/lib/db");
  const { account, count, wins, winPct, lossPct } = opts;
  let t = 0;
  const stamp = () => `2026-06-15T00:${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t++ % 60).padStart(2, "0")}.000Z`;
  for (let i = 0; i < count; i++) {
    const sym = `SYM${i}`;
    const exit = i < wins ? 100 * (1 + winPct / 100) : 100 * (1 - lossPct / 100);
    insertFillEvent({ accountNumber: account, source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: stamp(), raw: { proposal: { tradeThesisTag: THESIS, entryMarketRegime: REGIME } } });
    insertFillEvent({ accountNumber: account, source: "paper", symbol: sym, side: "sell", quantity: 1, price: exit, notional: exit, status: "filled", filledAt: stamp() });
  }
}

describe("selectThesisStat (shared sizer/gate bucket selection)", () => {
  const combo = (trades: number): ThesisRegimeStat => ({ thesisTag: THESIS, regime: REGIME, trades, winRate: 60, avgReturnPct: 1, totalPnl: 0, shrunkWinRate: 60, shrunkAvgReturnPct: 1 });
  const thesis = (avg: number): ThesisStat => ({ thesisTag: THESIS, trades: 30, winRate: 50, avgReturnPct: avg, totalPnl: 0, shrunkWinRate: 50, shrunkAvgReturnPct: avg });

  it("prefers the thesis×regime bucket once it has >= 5 trades", () => {
    const stat = selectThesisStat([combo(5)], [thesis(-1)], proposal());
    expect(stat).toMatchObject({ regime: REGIME, trades: 5 });
  });
  it("falls back to the thesis bucket when the regime bucket is too thin (< 5)", () => {
    const stat = selectThesisStat([combo(4)], [thesis(-2)], proposal());
    expect(stat).toMatchObject({ thesisTag: THESIS, trades: 30 });
    expect((stat as ThesisRegimeStat).regime).toBeUndefined();
  });
  it("returns undefined when no bucket matches the thesis", () => {
    expect(selectThesisStat([], [], proposal())).toBeUndefined();
  });
});

describe("shouldSkipNegativeExpectancy", () => {
  it("default OFF: never skips, even a proven money-loser", async () => {
    const account = "NEGEV-OFF";
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 2, lossPct: 3 }); // shrunk avg ≈ -0.4%
    expect(shouldSkipNegativeExpectancy(proposal(), policyFor(account), "paper", "local").skip).toBe(false);
  });

  it("ON + PROVEN negative edge → skips", async () => {
    const account = "NEGEV-PROVEN-NEG";
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 2, lossPct: 3 }); // shrunk avg ≈ -0.4% over 20 lots
    const r = shouldSkipNegativeExpectancy(proposal(), policyFor(account, { skipNegativeExpectancy: true }), "paper", "local");
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/proven negative post-cost edge/);
  });

  it("ON + PROVEN positive edge → does NOT skip", async () => {
    const account = "NEGEV-PROVEN-POS";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 }); // shrunk avg ≈ +3.5%
    expect(shouldSkipNegativeExpectancy(proposal(), policyFor(account, { skipNegativeExpectancy: true }), "paper", "local").skip).toBe(false);
  });

  it("ON + UNPROVEN negative (< minLots) → does NOT skip (exploration preserved)", async () => {
    const account = "NEGEV-UNPROVEN";
    await seedClosedLots({ account, count: 3, wins: 0, winPct: 2, lossPct: 3 }); // 3 lots, all losers, but UNPROVEN
    expect(shouldSkipNegativeExpectancy(proposal(), policyFor(account, { skipNegativeExpectancy: true }), "paper", "local").skip).toBe(false);
  });

  it("ON + exit (sell/cover) → never skipped", async () => {
    const account = "NEGEV-EXIT";
    await seedClosedLots({ account, count: 20, wins: 10, winPct: 2, lossPct: 3 });
    const pol = policyFor(account, { skipNegativeExpectancy: true });
    expect(shouldSkipNegativeExpectancy(proposal("sell"), pol, "paper", "local").skip).toBe(false);
    expect(shouldSkipNegativeExpectancy(proposal("cover"), pol, "paper", "local").skip).toBe(false);
  });

  it("respects a configurable edge threshold (skip when shrunk avg <= threshold)", async () => {
    const account = "NEGEV-THRESH";
    await seedClosedLots({ account, count: 20, wins: 18, winPct: 5, lossPct: 1 }); // shrunk avg ≈ +3.5%
    // threshold 4% → +3.5% <= 4% → skip; threshold 0% (default) → +3.5% > 0 → no skip.
    expect(shouldSkipNegativeExpectancy(proposal(), policyFor(account, { skipNegativeExpectancy: true, skipNegativeExpectancyEdgePct: 4 }), "paper", "local").skip).toBe(true);
    expect(shouldSkipNegativeExpectancy(proposal(), policyFor(account, { skipNegativeExpectancy: true, skipNegativeExpectancyEdgePct: 0 }), "paper", "local").skip).toBe(false);
  });
});
