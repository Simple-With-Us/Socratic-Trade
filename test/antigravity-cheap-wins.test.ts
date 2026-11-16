import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { enrichOpeningProposal } from "../src/lib/strategy";
import type { MarketQuote, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { applyDeterministicSizing } from "../src/lib/strategy-risk";

// Covers the functional "cheap wins" distilled from Antigravity's strategy critique:
//   - ADV (market-impact) order-size cap in deterministic sizing
//   - marketable-limit entry conversion in enrichOpeningProposal
// (The vol-panic brake is unit-tested in macro.test.ts; the ADV approval gate in policy.test.ts.
//  The former RED_TEAM_LLM_PROVIDER selector was DELETED 2026-07-07 — the single-adversary
//  consolidation killed the env override; the reviewer's provider comes only from the user's
//  explicit redTeamLlmModel.)

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-cheapwins-${randomUUID()}.db`)}`;
});

const PORTFOLIO: Portfolio = {
  accountNumber: "A",
  totalMarketValue: 1_000_000,
  buyingPower: 1_000_000,
  equityMarketValue: 0,
  optionMarketValue: 0,
  cash: 1_000_000
};

function quote(partial: Partial<MarketQuote> & { symbol: string; price: number; volume: number }): MarketQuote {
  return {
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 1,
    ...partial
  } as MarketQuote;
}

function scanWith(q: MarketQuote): MarketScan {
  return {
    source: "test",
    generatedAt: "2026-06-22T00:00:00.000Z",
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [q],
    sectorBySymbol: {},
    quotesBySymbol: { [q.symbol]: { symbol: q.symbol, price: q.price, bid: q.bid, ask: q.ask, score: q.score } },
    warnings: []
  };
}

function buyProposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "entry",
    tradeThesisTag: "Momentum-Breakout",
    entryMarketRegime: "Tech-Bull",
    confidenceScore: 95,
    ...over
  };
}

describe("ADV (market-impact) sizing cap", () => {
  it("trims an order to maxOrderPctOfAdv % of the name's daily $-volume", () => {
    // Fresh account → unproven thesis → floor sizing = 10% of maxOrderNotional 10000 = $1000.
    // Daily $-vol = price 100 × volume 100 = $10,000; 5% ADV cap = $500 < $1000 → trims.
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber: "ADV-1",
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxOrderPctOfAdv: 5
    };
    const scan = scanWith(quote({ symbol: "NVDA", price: 100, volume: 100 }));
    const sized = applyDeterministicSizing(buyProposal(), policy, PORTFOLIO, "paper", "local", [], scan);
    expect(sized.dollarAmount).toBe(500);
    expect(sized.rationale).toContain("ADV cap");
  });

  it("is a no-op when the cap is generous relative to liquidity", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber: "ADV-2",
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxOrderPctOfAdv: 5
    };
    // Daily $-vol = $1,000,000; 5% = $50,000 ≫ $1000 floor → untouched.
    const scan = scanWith(quote({ symbol: "NVDA", price: 100, volume: 10_000 }));
    const sized = applyDeterministicSizing(buyProposal(), policy, PORTFOLIO, "paper", "local", [], scan);
    expect(sized.dollarAmount).toBe(1000);
    expect(sized.rationale).not.toContain("ADV cap");
  });

  it("never false-trims when the cap is disabled or the gauge is missing", () => {
    const base: TradingPolicy = { ...DEFAULT_POLICY, accountNumber: "ADV-3", maxOrderNotional: 10_000, maxOrderPctOfNav: undefined };
    // disabled
    const disabled = applyDeterministicSizing(buyProposal(), { ...base, maxOrderPctOfAdv: undefined }, PORTFOLIO, "paper", "local", [], scanWith(quote({ symbol: "NVDA", price: 100, volume: 1 })));
    expect(disabled.dollarAmount).toBe(1000);
    // no marketScan passed → can't compute ADV → untouched
    const noScan = applyDeterministicSizing(buyProposal(), { ...base, maxOrderPctOfAdv: 5 }, PORTFOLIO, "paper", "local", []);
    expect(noScan.dollarAmount).toBe(1000);
  });

  it("raises Alpaca bracket-sized dollar buys to at least one whole share when risk caps allow it", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber: "BRACKET-MIN",
      activeBroker: "alpaca",
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxOrderPctOfAdv: undefined,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 6, takeProfitPct: 18 }
    };
    const scan = scanWith(quote({ symbol: "V", price: 334.12, volume: 1_000_000 }));
    const sized = applyDeterministicSizing(buyProposal({ symbol: "V", dollarAmount: 50 }), policy, PORTFOLIO, "paper", "local", [], scan);
    const enriched = enrichOpeningProposal(sized, policy, scan);

    expect(sized.dollarAmount).toBe(335);
    expect(sized.rationale).toContain("whole-share bracket");
    expect(enriched.bracketStopLoss).toBeCloseTo(314.07, 2);
    expect(enriched.bracketTakeProfit).toBeCloseTo(394.26, 2);
  });

  it("raises to a whole share for an explicit 'fixed'/'atr' stop plan even when the account's own stopLossPct/takeProfitPct are both 0 (the plan guarantees a bracket via the universal-availability fallback — Codex review, PR #1371)", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber: "BRACKET-MIN-PLAN",
      activeBroker: "alpaca",
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxOrderPctOfAdv: undefined,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0, takeProfitPct: 0 } // bare account
    };
    const scan = scanWith(quote({ symbol: "V", price: 334.12, volume: 1_000_000 }));
    const sized = applyDeterministicSizing(
      buyProposal({ symbol: "V", dollarAmount: 50, stopPlan: { style: "fixed" } }),
      policy, PORTFOLIO, "paper", "local", [], scan
    );
    expect(sized.dollarAmount).toBe(335); // one whole share at $334.12, not left sub-share
    expect(sized.rationale).toContain("whole-share bracket");
    const enriched = enrichOpeningProposal(sized, policy, scan);
    expect(enriched.bracketStopLoss).toBeCloseTo(307.39, 2); // STOP_PLAN_FALLBACK_STOP_PCT (8%) below entry
  });

  it("does NOT bump a sub-share order for a 'trailing'/'none' plan (no bracket is ever attached for these, so there's nothing to size a whole share for)", () => {
    const policy: TradingPolicy = {
      ...DEFAULT_POLICY,
      accountNumber: "BRACKET-MIN-NOPLAN",
      activeBroker: "alpaca",
      maxOrderNotional: 10_000,
      maxOrderPctOfNav: undefined,
      maxOrderPctOfAdv: undefined,
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 6, takeProfitPct: 18 }
    };
    const scan = scanWith(quote({ symbol: "V", price: 334.12, volume: 1_000_000 }));
    const sized = applyDeterministicSizing(
      buyProposal({ symbol: "V", dollarAmount: 50, stopPlan: { style: "trailing" } }),
      policy, PORTFOLIO, "paper", "local", [], scan
    );
    expect(sized.dollarAmount).toBe(50); // left as-is, no whole-share bump
    expect(sized.rationale).not.toContain("whole-share bracket");
  });
});

describe("marketable-limit entry conversion", () => {
  const policyOn: TradingPolicy = { ...DEFAULT_POLICY, activeBroker: "alpaca", marketableLimitEntries: true };

  it("converts a notional market buy into a quantity+limit priced through the ask", () => {
    const scan = scanWith(quote({ symbol: "NVDA", price: 100, ask: 100.5, bid: 99.5, volume: 1_000_000 }));
    const out = enrichOpeningProposal(buyProposal({ dollarAmount: 1000 }), policyOn, scan);
    expect(out.type).toBe("limit");
    expect(out.quantity).toBe(10); // floor(1000 / refPrice 100)
    expect(out.dollarAmount).toBeUndefined();
    // 100.5 * (1 + 15bps) = 100.65 (rounded)
    expect(out.limitPrice).toBeCloseTo(100.65, 2);
    expect(out.rationale).toContain("Marketable-limit");
  });

  it("leaves the order as market when disabled", () => {
    const scan = scanWith(quote({ symbol: "NVDA", price: 100, ask: 100.5, volume: 1_000_000 }));
    const out = enrichOpeningProposal(buyProposal({ dollarAmount: 1000 }), { ...policyOn, marketableLimitEntries: false }, scan);
    expect(out.type).toBe("market");
    expect(out.dollarAmount).toBe(1000);
  });

  it("leaves sub-share notional as a market order (can't express <1 share as a limit)", () => {
    const scan = scanWith(quote({ symbol: "NVDA", price: 100, ask: 100.5, volume: 1_000_000 }));
    const out = enrichOpeningProposal(buyProposal({ dollarAmount: 50 }), policyOn, scan); // floor(50/100)=0
    expect(out.type).toBe("market");
    expect(out.dollarAmount).toBe(50);
    expect(out.bracketStopLoss).toBeUndefined();
    expect(out.rationale).toContain("Native Alpaca bracket skipped");
  });

  it("clears LLM bracket fields when a $4.60 Alpaca order cannot fund one $87.77 share", () => {
    const scan = scanWith(quote({ symbol: "EXE", price: 87.77, ask: 87.8, volume: 1_000_000 }));
    const out = enrichOpeningProposal(
      buyProposal({
        symbol: "EXE",
        dollarAmount: 4.6,
        referencePrice: 87.77,
        bracketStopLoss: 86.1,
        bracketTakeProfit: 94.2,
        bracketStopLimit: 85.9
      }),
      policyOn,
      scan
    );

    expect(out.type).toBe("market");
    expect(out.dollarAmount).toBe(4.6);
    expect(out.bracketStopLoss).toBeUndefined();
    expect(out.bracketTakeProfit).toBeUndefined();
    expect(out.bracketStopLimit).toBeUndefined();
    expect(out.rationale).toContain("Native Alpaca bracket skipped");
  });
});
