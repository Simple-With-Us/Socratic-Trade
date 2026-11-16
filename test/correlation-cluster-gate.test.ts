import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { alignedReturns, avgReturnCorrelation, closesByDate, pearson } from "../src/lib/correlation";
import type { OHLCBar } from "../src/lib/indicators";
import type { EquityPosition, TradeProposal } from "../src/lib/types";

// Mock only fetchDailyOHLC (keep toBusinessDay real) so the gate's end-to-end drop/keep is testable.
vi.mock("../src/lib/history", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/history")>();
  return { ...actual, fetchDailyOHLC: vi.fn() };
});

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-corr-${randomUUID()}.db`)}`;
});

/** Build a daily OHLC series (ascending "YYYY-MM-DD" dates) from a returns array. */
function barsFromReturns(returns: number[], start = 100): OHLCBar[] {
  const bars: OHLCBar[] = [];
  let price = start;
  let day = Date.UTC(2026, 0, 1);
  bars.push({ time: new Date(day).toISOString().slice(0, 10), close: price });
  for (const r of returns) {
    price *= 1 + r;
    day += 24 * 3600 * 1000;
    bars.push({ time: new Date(day).toISOString().slice(0, 10), close: price });
  }
  return bars;
}

const R = Array.from({ length: 30 }, (_, i) => Math.sin(i * 0.7) / 50); // 30 varied daily returns

describe("correlation math", () => {
  it("pearson: +1 for identical, -1 for negated series", () => {
    const a = R.slice();
    const b = R.slice();
    const negB = R.map((x) => -x);
    expect(pearson(a, b)).toBeCloseTo(1, 6);
    expect(pearson(a, negB)).toBeCloseTo(-1, 6);
  });
  it("pearson: undefined on too-few samples or zero variance", () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeUndefined(); // < 20 samples
    expect(pearson(Array(25).fill(0.01), Array(25).fill(0.02))).toBeUndefined(); // zero variance
  });
  it("closesByDate + alignedReturns align on common business days only", () => {
    const a = barsFromReturns(R);
    const b = barsFromReturns(R.map((x) => x * 0.5)).slice(2); // drop first 2 days → fewer common dates
    expect(closesByDate(a).size).toBe(R.length + 1);
    const { ra, rb } = alignedReturns(a, b);
    expect(ra.length).toBe(rb.length);
    expect(ra.length).toBeGreaterThan(0);
  });
});

describe("avgReturnCorrelation (injected fetcher)", () => {
  const cand = barsFromReturns(R);
  const fetchBars = (map: Record<string, OHLCBar[] | null>) => async (s: string) => map[s] ?? null;

  it("averages pairwise correlations to holdings; excludes the candidate itself", async () => {
    const identical = barsFromReturns(R); // corr +1
    const negated = barsFromReturns(R.map((x) => -x)); // corr -1
    const corr = await avgReturnCorrelation("AAA", ["IDENT", "NEG", "AAA"], "local", Date.now(), {
      fetchBars: fetchBars({ AAA: cand, IDENT: identical, NEG: negated })
    });
    expect(corr).toBeCloseTo(0, 5); // (+1 + -1)/2 = 0; "AAA" holding ignored (== candidate)
  });

  it("returns undefined when there are no other holdings", async () => {
    expect(await avgReturnCorrelation("AAA", ["AAA"], "local", Date.now(), { fetchBars: fetchBars({ AAA: cand }) })).toBeUndefined();
  });

  it("returns undefined when bar data is insufficient (never false-rejects)", async () => {
    const tiny = barsFromReturns(R.slice(0, 3));
    expect(await avgReturnCorrelation("AAA", ["H"], "local", Date.now(), { fetchBars: fetchBars({ AAA: tiny, H: tiny }) })).toBeUndefined();
  });
});

describe("applyCorrelationClusterGate", () => {
  function buy(symbol: string): TradeProposal {
    return { symbol, side: "buy", type: "market", timeInForce: "gfd", marketHours: "regular_hours", rationale: "x", tradeThesisTag: "t", entryMarketRegime: "r" };
  }
  function sell(symbol: string): TradeProposal {
    return { ...buy(symbol), side: "sell" };
  }
  const held: EquityPosition[] = [{ symbol: "HELD", quantity: 10, averageCost: 100, marketValue: 1000 }];

  it("drops a highly-correlated OPENING buy but keeps an exit; passes when cap off / no holdings", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const candBars = barsFromReturns(R);
    (fetchDailyOHLC as Mock).mockImplementation(async (sym: string) => (sym === "AAA" || sym === "HELD" ? candBars : null)); // AAA≈HELD → corr ~1
    const { applyCorrelationClusterGate } = await import("../src/lib/strategy");

    const proposals = [buy("AAA"), sell("AAA")];
    const policy = { ...DEFAULT_POLICY, accountNumber: "X", maxAvgCorrelation: 0.8 };

    const kept = await applyCorrelationClusterGate(proposals, policy, held, "local");
    expect(kept.map((p) => `${p.symbol}:${p.side}`)).toEqual(["AAA:sell"]); // buy dropped (corr>cap), exit kept

    // Cap off → unchanged; no holdings → unchanged.
    expect((await applyCorrelationClusterGate(proposals, { ...policy, maxAvgCorrelation: undefined }, held, "local")).length).toBe(2);
    expect((await applyCorrelationClusterGate(proposals, policy, [], "local")).length).toBe(2);
  });

  it("keeps an opening buy whose correlation is BELOW the cap", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const candBars = barsFromReturns(R);
    const negBars = barsFromReturns(R.map((x) => -x)); // corr ~ -1 < cap
    (fetchDailyOHLC as Mock).mockImplementation(async (sym: string) => (sym === "AAA" ? candBars : sym === "HELD" ? negBars : null));
    const { applyCorrelationClusterGate } = await import("../src/lib/strategy");

    const kept = await applyCorrelationClusterGate([buy("AAA")], { ...DEFAULT_POLICY, accountNumber: "X", maxAvgCorrelation: 0.8 }, held, "local");
    expect(kept.length).toBe(1);
  });

  it("re-proves ownership after the correlation await before auditing or keeping the proposal", async () => {
    const { fetchDailyOHLC } = await import("../src/lib/history");
    const candBars = barsFromReturns(R);
    (fetchDailyOHLC as Mock).mockImplementation(async () => candBars);
    const { applyCorrelationClusterGate } = await import("../src/lib/strategy");
    let checks = 0;
    const assertOwned = () => {
      checks++;
      if (checks === 2) throw new Error("lease lost after correlation");
    };

    await expect(applyCorrelationClusterGate(
      [buy("AAA")],
      { ...DEFAULT_POLICY, accountNumber: "X", maxAvgCorrelation: 0.8 },
      held,
      "local",
      assertOwned
    )).rejects.toThrow("lease lost after correlation");
  });
});
