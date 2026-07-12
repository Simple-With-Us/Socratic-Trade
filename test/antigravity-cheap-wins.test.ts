import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { applyDeterministicSizing, enrichOpeningProposal } from "../src/lib/strategy";
import { redTeamProvider } from "../src/lib/red-team";
import type { MarketQuote, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

// Covers the four functional "cheap wins" distilled from Antigravity's strategy critique:
//   - ADV (market-impact) order-size cap in deterministic sizing
//   - marketable-limit entry conversion in enrichOpeningProposal
//   - the optional cross-provider Red Team provider selector
// (The vol-panic brake is unit-tested in macro.test.ts; the ADV approval gate in policy.test.ts.)

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
});

describe("redTeamProvider selector", () => {
  const original = process.env.RED_TEAM_LLM_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.RED_TEAM_LLM_PROVIDER;
    else process.env.RED_TEAM_LLM_PROVIDER = original;
  });

  it("defaults to openai", () => {
    delete process.env.RED_TEAM_LLM_PROVIDER;
    expect(redTeamProvider()).toBe("openai");
  });

  it("selects anthropic when explicitly set (case-insensitive)", () => {
    process.env.RED_TEAM_LLM_PROVIDER = "Anthropic";
    expect(redTeamProvider()).toBe("anthropic");
  });

  it("ignores unrecognized values", () => {
    process.env.RED_TEAM_LLM_PROVIDER = "gemini";
    expect(redTeamProvider()).toBe("openai");
  });
});
