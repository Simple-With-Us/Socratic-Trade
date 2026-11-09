import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { SkippedCandidateReturn } from "../src/lib/performance";
import type { MarketScan } from "../src/lib/types";

// Audit items 3.1/3.2/4.4: FMP price targets + quality fields must reach the LLM prompt
// representation (omitted entirely when absent — never a placeholder), and counterfactual
// feedback must be two-sided (labeled missed winners AND avoided losers), not regret-only.

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-prompt-wiring-${randomUUID()}.db`)}`;
});

type Candidate = MarketScan["topCandidates"][number];

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    symbol: "TEST",
    price: 100,
    asOf: "2026-07-15T14:30:00.000Z",
    ...overrides
  } as Candidate;
}

describe("compactCandidateForPrompt price-target + quality wiring (items 3.1/3.2)", () => {
  it("includes tgtMean, derived tgtUpsidePct, roa and grossMarginPct when present", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const compact = compactCandidateForPrompt(
      candidate({ price: 200, targetMean: 233, returnOnAssets: 12.345, grossProfitMargin: 46.71 }),
      0
    );
    expect(compact.tgtMean).toBe(233);
    // (233 - 200) / 200 = 16.5%, rounded to 1dp (prompt tokens are real cost)
    expect(compact.tgtUpsidePct).toBe(16.5);
    expect(compact.roa).toBe(12.3);
    expect(compact.grossMarginPct).toBe(46.7);
  });

  it("omits the keys entirely when the data is absent — never a placeholder value", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const compact = compactCandidateForPrompt(candidate({ price: 200 }), 0);
    expect("tgtMean" in compact).toBe(false);
    expect("tgtUpsidePct" in compact).toBe(false);
    expect("roa" in compact).toBe(false);
    expect("grossMarginPct" in compact).toBe(false);
  });

  it("derives no upside when price is missing/non-positive even if targetMean exists", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const compact = compactCandidateForPrompt(candidate({ price: 0, targetMean: 50 }), 0);
    expect("tgtUpsidePct" in compact).toBe(false);
  });

  it("prefers the real returnOnEquity over the eps*pb approximation in the prompt roe", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const withReal = compactCandidateForPrompt(
      candidate({ price: 100, eps: 5, pbRatio: 2, returnOnEquity: 31.42 }),
      0
    );
    expect(withReal.roe).toBe(31.4);
    // fallback: no reported value -> structural approximation (5 * 2 / 100 = 10%)
    const withoutReal = compactCandidateForPrompt(candidate({ price: 100, eps: 5, pbRatio: 2 }), 0);
    expect(withoutReal.roe).toBe(10);
  });
});

function cfRow(symbol: string, returnPct: number, extra: Partial<SkippedCandidateReturn> = {}): SkippedCandidateReturn {
  return {
    runId: `run-${symbol}`,
    symbol,
    refPrice: 100,
    currentPrice: 100 * (1 + returnPct / 100),
    returnPct,
    ...extra
  };
}

describe("selectBalancedCounterfactuals (item 4.4)", () => {
  it("labels missed winners AND avoided losers distinctly, excluding the +/-3% dead zone", async () => {
    const { selectBalancedCounterfactuals } = await import("../src/lib/strategy");
    const rows = [cfRow("WIN1", 8), cfRow("FLAT", 1.5), cfRow("LOSE1", -6), cfRow("WIN2", 4), cfRow("LOSE2", -12)];
    const selected = selectBalancedCounterfactuals(rows);
    expect(selected.map((r) => [r.symbol, r.label])).toEqual([
      ["WIN1", "missed_winner"],
      ["WIN2", "missed_winner"],
      ["LOSE2", "avoided_loser"],
      ["LOSE1", "avoided_loser"]
    ]);
  });

  it("splits the bounded budget between both directions when both tails are deep", async () => {
    const { selectBalancedCounterfactuals } = await import("../src/lib/strategy");
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => cfRow(`W${i}`, 20 - i)),
      ...Array.from({ length: 10 }, (_, i) => cfRow(`L${i}`, -20 + i))
    ];
    const selected = selectBalancedCounterfactuals(rows, 8);
    expect(selected).toHaveLength(8);
    expect(selected.filter((r) => r.label === "missed_winner")).toHaveLength(4);
    expect(selected.filter((r) => r.label === "avoided_loser")).toHaveLength(4);
    // strongest examples first in each direction
    expect(selected[0].returnPct).toBe(20);
    expect(selected[4].returnPct).toBe(-20);
  });

  it("donates an underfilled side's remainder to the other, keeping the total bounded", async () => {
    const { selectBalancedCounterfactuals } = await import("../src/lib/strategy");
    const oneWinner = [cfRow("W0", 9), ...Array.from({ length: 10 }, (_, i) => cfRow(`L${i}`, -30 + i))];
    const skewedToLosers = selectBalancedCounterfactuals(oneWinner, 8);
    expect(skewedToLosers).toHaveLength(8);
    expect(skewedToLosers.filter((r) => r.label === "missed_winner")).toHaveLength(1);
    expect(skewedToLosers.filter((r) => r.label === "avoided_loser")).toHaveLength(7);

    const winnersOnly = Array.from({ length: 10 }, (_, i) => cfRow(`W${i}`, 30 - i));
    const allWinners = selectBalancedCounterfactuals(winnersOnly, 8);
    expect(allWinners).toHaveLength(8);
    expect(allWinners.every((r) => r.label === "missed_winner")).toBe(true);
  });

  it("passes benchmarkReturnPct (SPY-relative context) through untouched when present", async () => {
    const { selectBalancedCounterfactuals } = await import("../src/lib/strategy");
    const selected = selectBalancedCounterfactuals([
      cfRow("WIN", 7, { benchmarkReturnPct: 1.2 }),
      cfRow("LOSE", -9, { benchmarkReturnPct: -0.4 })
    ]);
    expect(selected.find((r) => r.symbol === "WIN")?.benchmarkReturnPct).toBe(1.2);
    expect(selected.find((r) => r.symbol === "LOSE")?.benchmarkReturnPct).toBe(-0.4);
  });

  it("returns empty (field omitted upstream) when nothing cleared either threshold", async () => {
    const { selectBalancedCounterfactuals } = await import("../src/lib/strategy");
    expect(selectBalancedCounterfactuals([cfRow("A", 2.9), cfRow("B", -2.9)])).toEqual([]);
  });
});
