import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal, betaScaledStopPct } from "../src/lib/policy";
import {
  allowedProposalSides,
  enrichOpeningProposal,
  deterministicBearFilter,
  generateProactiveRiskProposals
} from "../src/lib/strategy";
import type {
  AccountCapabilities,
  EquityPosition,
  MarketQuote,
  MarketScan,
  Portfolio,
  TradeProposal,
  TradingPolicy
} from "../src/lib/types";

// The wash-sale gate resolves a DB-backed locked provenance map when the caller omits one; stub it out.
vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn(() => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn(() => new Map())
}));

const shortCapable: AccountCapabilities = {
  equityTrading: true, shortSelling: true, optionsTrading: false,
  futuresTrading: false, cryptoTrading: false, marginEnabled: true, accountType: "brokerage"
};
const noShortCapable: AccountCapabilities = { ...shortCapable, shortSelling: false };

const portfolio: Portfolio = {
  accountNumber: "A1", totalMarketValue: 10000, buyingPower: 100000,
  equityMarketValue: 5000, optionMarketValue: 0, cash: 5000
};

function policy(extra: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY, systemState: "active", accountNumber: "A1",
    includedIndices: [], additionalSymbols: ["AAPL", "TSLA", "NVDA"], ...extra
  };
}

// A policy with the size/exposure caps relaxed so a single risk gate can be tested in isolation.
function isolatingPolicy(extra: Partial<TradingPolicy> = {}): TradingPolicy {
  return policy({
    maxOrderPctOfNav: 100, maxDailyNotional: 1_000_000, maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000, maxNetExposurePct: 1000, ...extra
  });
}

function scan(quotes: Record<string, { price?: number; beta?: number; sector?: string }>): MarketScan {
  const quotesBySymbol: MarketScan["quotesBySymbol"] = {};
  for (const [sym, q] of Object.entries(quotes)) {
    quotesBySymbol[sym] = { symbol: sym, price: q.price ?? 100, score: 50, beta: q.beta, sector: q.sector };
  }
  return { source: "test", generatedAt: "now", scannedSymbols: 0, returnedQuotes: 0, topCandidates: [], sectorBySymbol: {}, quotesBySymbol, warnings: [] };
}

function buy(extra: Partial<TradeProposal> = {}): TradeProposal {
  return { symbol: "TSLA", side: "buy", type: "market", dollarAmount: 100, timeInForce: "gfd", marketHours: "regular_hours", rationale: "t", tradeThesisTag: "Breakout", entryMarketRegime: "Bull", ...extra };
}

function quote(extra: Partial<MarketQuote> & { symbol: string }): MarketQuote {
  return { price: 100, volume: 1_000_000, intradayChangePct: 0, positionMarketValue: 0, score: 60, ...extra };
}

describe("allowedProposalSides (SHORT_SELLING two-layer gate)", () => {
  it("is long-only when shorting is disabled in policy", () => {
    expect(allowedProposalSides(policy({ shortSellingEnabled: false }), { id: "1", broker: "alpaca", environment: "paper", accountNumber: "A1", label: "x", capabilities: shortCapable }))
      .toEqual(["buy", "sell"]);
  });
  it("is long-only when the account cannot short, even if policy enables it", () => {
    expect(allowedProposalSides(policy({ shortSellingEnabled: true }), { id: "1", broker: "alpaca", environment: "paper", accountNumber: "A1", label: "x", capabilities: noShortCapable }))
      .toEqual(["buy", "sell"]);
  });
  it("includes short/cover only when policy AND account both allow it", () => {
    expect(allowedProposalSides(policy({ shortSellingEnabled: true }), { id: "1", broker: "alpaca", environment: "paper", accountNumber: "A1", label: "x", capabilities: shortCapable }))
      .toEqual(["buy", "sell", "short", "cover"]);
  });
  it("is long-only when there is no connected account", () => {
    expect(allowedProposalSides(policy({ shortSellingEnabled: true }), undefined)).toEqual(["buy", "sell"]);
  });
});

describe("betaScaledStopPct", () => {
  it("returns the base unchanged when disabled", () => expect(betaScaledStopPct(8, 2, false)).toBe(8));
  it("widens the stop for high-beta names", () => expect(betaScaledStopPct(8, 2, true)).toBe(16));
  it("tightens the stop for low-beta names", () => expect(betaScaledStopPct(8, 0.5, true)).toBe(4));
  it("clamps an extreme beta to 2.0x", () => expect(betaScaledStopPct(8, 9, true)).toBe(16));
  it("clamps a tiny beta to 0.5x", () => expect(betaScaledStopPct(8, 0.1, true)).toBe(4));
  it("is a no-op when beta is missing", () => expect(betaScaledStopPct(8, undefined, true)).toBe(8));
  it("is a no-op when the base is zero/off", () => expect(betaScaledStopPct(0, 2, true)).toBe(0));
});

describe("entry-drift guard", () => {
  const base = { portfolio, positions: [] as EquityPosition[], dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 100 };
  it("rejects a stale opening MARKET order whose price drifted past maxEntryDriftPct", () => {
    const d = evaluateTradeProposal(buy({ referencePrice: 100 }), { ...base, policy: policy({ maxEntryDriftPct: 10 }), marketScan: scan({ TSLA: { price: 115 } }) });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(true);
  });
  it("allows an opening order within the drift tolerance", () => {
    const d = evaluateTradeProposal(buy({ referencePrice: 100 }), { ...base, policy: policy({ maxEntryDriftPct: 10 }), marketScan: scan({ TSLA: { price: 105 } }) });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(false);
    expect(d.approved).toBe(true);
  });
  it("does NOT apply to limit orders (the broker's limit already caps the fill)", () => {
    const d = evaluateTradeProposal(buy({ type: "limit", dollarAmount: undefined, quantity: 1, limitPrice: 100, referencePrice: 100 }), { ...base, policy: policy({ maxEntryDriftPct: 10 }), marketScan: scan({ TSLA: { price: 130 } }) });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(false);
  });
  it("does apply to fractional opening limits because Robinhood routes them as market orders", () => {
    const d = evaluateTradeProposal(buy({ type: "limit", dollarAmount: undefined, quantity: 0.5, limitPrice: 100, referencePrice: 100 }), {
      ...base,
      policy: policy({ activeBroker: "robinhood", maxEntryDriftPct: 10 }),
      marketScan: scan({ TSLA: { price: 130 } })
    });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(true);
  });
  it("does not apply to fractional opening limits on brokers that preserve the limit", () => {
    const d = evaluateTradeProposal(buy({ type: "limit", dollarAmount: undefined, quantity: 0.5, limitPrice: 100, referencePrice: 100 }), {
      ...base,
      policy: policy({ activeBroker: "alpaca", maxEntryDriftPct: 10 }),
      marketScan: scan({ TSLA: { price: 130 } })
    });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(false);
  });
  it("does not fire without a referencePrice anchor", () => {
    const d = evaluateTradeProposal(buy(), { ...base, policy: policy({ maxEntryDriftPct: 10 }), marketScan: scan({ TSLA: { price: 130 } }) });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(false);
  });
  it("is disabled when maxEntryDriftPct is 0", () => {
    const d = evaluateTradeProposal(buy({ referencePrice: 100 }), { ...base, policy: policy({ maxEntryDriftPct: 0 }), marketScan: scan({ TSLA: { price: 200 } }) });
    expect(d.reasons.some((r) => r.startsWith("entry_drift"))).toBe(false);
  });
});

describe("maxPortfolioBeta cap", () => {
  // Equity 100k; one 50k long with beta 1.5 → current portfolio beta 0.75.
  const positions: EquityPosition[] = [{ symbol: "AAPL", quantity: 250, averageCost: 200, marketValue: 50000, sector: "Technology" }];
  const marketScan = scan({ AAPL: { price: 200, beta: 1.5 }, NVDA: { price: 100, beta: 2.0 } });
  const ctx = (extra: Partial<TradingPolicy>) => ({
    policy: isolatingPolicy(extra), portfolio: { ...portfolio, totalMarketValue: 100000 },
    positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 4000, marketScan
  });
  const candidate = buy({ symbol: "NVDA", dollarAmount: 4000 });

  it("blocks an opening buy that pushes projected portfolio beta past the cap", () => {
    const d = evaluateTradeProposal(candidate, ctx({ maxPortfolioBeta: 0.8 }));
    expect(d.reasons.some((r) => r.includes("portfolio beta"))).toBe(true);
  });
  it("allows the same buy when the projected beta is under the cap", () => {
    const d = evaluateTradeProposal(candidate, ctx({ maxPortfolioBeta: 1.0 }));
    expect(d.reasons.some((r) => r.includes("portfolio beta"))).toBe(false);
    expect(d.approved).toBe(true);
  });
  it("is inert when maxPortfolioBeta is undefined", () => {
    const d = evaluateTradeProposal(candidate, ctx({}));
    expect(d.reasons.some((r) => r.includes("portfolio beta"))).toBe(false);
  });
});

describe("deterministicBearFilter fundamentals veto", () => {
  const positions: EquityPosition[] = [];
  it("TAGS (advisory, keeps) a buy whose FCF yield is below the floor", () => {
    const { kept, vetoed } = deterministicBearFilter([buy({ symbol: "NVDA" })], positions, [quote({ symbol: "NVDA", fcfYield: -5 })], "Bull", { fcfYieldFloorPct: 0 });
    // Advisory pre-veto (tag-not-drop): KEPT + tagged, still reported in `vetoed` for telemetry.
    expect(kept).toHaveLength(1);
    expect(kept[0].preVetoReasons?.[0]).toMatch(/^deterministic_bear_veto: Fundamentals veto: FCF yield/);
    expect(vetoed[0].reason).toContain("FCF yield");
  });
  it("TAGS (advisory, keeps) a buy whose debt/equity exceeds the ceiling", () => {
    const { kept, vetoed } = deterministicBearFilter([buy({ symbol: "NVDA" })], positions, [quote({ symbol: "NVDA", fcfYield: 5, debtToEquity: 4 })], "Bull", { debtToEquityCeiling: 3 });
    expect(kept).toHaveLength(1);
    expect(kept[0].preVetoReasons?.[0]).toMatch(/^deterministic_bear_veto: Fundamentals veto: debt\/equity/);
    expect(vetoed[0].reason).toContain("debt/equity");
  });
  it("keeps a buy when the fundamentals field is unavailable (no false veto)", () => {
    const { kept } = deterministicBearFilter([buy({ symbol: "NVDA" })], positions, [quote({ symbol: "NVDA" })], "Bull", { fcfYieldFloorPct: 0, debtToEquityCeiling: 3 });
    expect(kept).toHaveLength(1);
  });
  it("keeps a buy when no thresholds are configured", () => {
    const { kept } = deterministicBearFilter([buy({ symbol: "NVDA" })], positions, [quote({ symbol: "NVDA", fcfYield: -20, debtToEquity: 99 })], "Bull");
    expect(kept).toHaveLength(1);
  });
});

describe("enrichOpeningProposal (broker brackets + entry anchor)", () => {
  const marketScan = scan({ TSLA: { price: 100 } });
  it("stamps referencePrice and attaches stop/take brackets for an Alpaca long", () => {
    const p = enrichOpeningProposal(buy(), policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }), marketScan);
    expect(p.referencePrice).toBe(100);
    expect(p.bracketStopLoss).toBe(92);
    expect(p.bracketTakeProfit).toBe(120);
  });
  it("keeps the decision-time market anchor separate from a below-market limit entry", () => {
    const p = enrichOpeningProposal(
      buy({ type: "limit", dollarAmount: undefined, quantity: 1, limitPrice: 95 }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan
    );
    expect(p.referencePrice).toBe(100);
    expect(p.limitPrice).toBe(95);
    expect(p.bracketStopLoss).toBe(87.4);
    expect(p.bracketTakeProfit).toBe(114);
  });
  it("inverts bracket legs for a short (stop above, take below)", () => {
    const p = enrichOpeningProposal(buy({ side: "short" }), policy({ activeBroker: "alpaca", shortSellingEnabled: true, riskRules: { shortStopLossPct: 5, takeProfitPct: 20 } }), marketScan);
    expect(p.bracketStopLoss).toBe(105);
    expect(p.bracketTakeProfit).toBe(80);
  });
  it("attaches no brackets on a broker without native bracket support, but still sets referencePrice", () => {
    const p = enrichOpeningProposal(buy(), policy({ activeBroker: "test", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }), marketScan);
    expect(p.referencePrice).toBe(100);
    expect(p.bracketStopLoss).toBeUndefined();
  });
  it("attaches no brackets when brokerBracketsEnabled is false", () => {
    const p = enrichOpeningProposal(buy(), policy({ activeBroker: "alpaca", brokerBracketsEnabled: false, riskRules: { stopLossPct: 8 } }), marketScan);
    expect(p.bracketStopLoss).toBeUndefined();
  });
  it("leaves non-opening (sell) proposals untouched", () => {
    const sell = buy({ side: "sell" });
    expect(enrichOpeningProposal(sell, policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8 } }), marketScan)).toEqual(sell);
  });

  // Item 2: synthetic bid/ask must NOT anchor marketable-limit pricing.
  it("prices a marketable-limit buy through a REAL ask", () => {
    const withRealAsk: MarketScan = {
      ...marketScan,
      quotesBySymbol: {
        TSLA: { symbol: "TSLA", price: 100, ask: 101, score: 50, sources: { ask: "alpaca" } }
      }
    };
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000 }),
      policy({ activeBroker: "test", marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"] }),
      withRealAsk
    );
    // 101 * (1 + 15bps) = 101.1515 → round2 101.15.
    expect(p.type).toBe("limit");
    expect(p.limitPrice).toBe(101.15);
  });

  it("degrades a marketable-limit buy to a refPrice-based limit when the ask is synthetic", () => {
    const withSyntheticAsk: MarketScan = {
      ...marketScan,
      quotesBySymbol: {
        TSLA: { symbol: "TSLA", price: 100, ask: 101, score: 50, syntheticAsk: true, sources: { ask: "yahoo-finance-synthetic" } }
      }
    };
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000, referencePrice: 100 }),
      policy({ activeBroker: "test", marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"] }),
      withSyntheticAsk
    );
    // refPrice (100), NOT the synthetic ask (101): 100 * (1 + 15bps) = 100.15.
    expect(p.type).toBe("limit");
    expect(p.limitPrice).toBe(100.15);
  });

  it("prices each side independently: a synthetic BID must not discard a REAL ask for a buy", () => {
    const mixed: MarketScan = {
      ...marketScan,
      quotesBySymbol: {
        // Real ask (alpaca) alongside a synthetic bid (e.g. a later provider supplied the bid).
        TSLA: {
          symbol: "TSLA",
          price: 100,
          ask: 101,
          bid: 99,
          score: 50,
          sources: { ask: "alpaca", bid: "yahoo-finance-synthetic" }, syntheticBid: true
        }
      }
    };
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000, referencePrice: 100 }),
      policy({ activeBroker: "test", marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"] }),
      mixed
    );
    // A buy anchors on the REAL ask (101); the synthetic BID is irrelevant to it and must not degrade
    // the limit to refPrice. 101 * (1 + 15bps) = 101.15 (would be 100.15 under the old all-or-nothing flag).
    expect(p.type).toBe("limit");
    expect(p.limitPrice).toBe(101.15);
  });
});

describe("generateProactiveRiskProposals beta-scaled stops", () => {
  const positions: EquityPosition[] = [{ symbol: "TSLA", quantity: 10, averageCost: 100, marketValue: 850, sector: "Auto" }];
  const prices = { TSLA: 85 }; // down 15%
  const stopRules: TradingPolicy["riskRules"] = { stopLossPct: 10 };

  it("stops out at the flat threshold when beta scaling is off", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, betaScaledStops: false }), { TSLA: 2 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
  it("widens the stop for a high-beta name so a -15% move no longer breaches a 10% (×2) stop", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, betaScaledStops: true }), { TSLA: 2 });
    expect(out.some((p) => p.symbol === "TSLA")).toBe(false);
  });
  it("tightens the stop for a low-beta name (10% × 0.5 = 5%) so -15% breaches", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, betaScaledStops: true }), { TSLA: 0.5 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
});

describe("generateProactiveRiskProposals ATR stops", () => {
  const positions: EquityPosition[] = [{ symbol: "TSLA", quantity: 10, averageCost: 100, marketValue: 850, sector: "Auto" }];
  const prices = { TSLA: 85 }; // down 15%
  const stopRules: TradingPolicy["riskRules"] = { stopLossPct: 10 };

  it("uses the ATR-based stop distance (wider) so a -15% move no longer breaches a 20% ATR stop", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, atrStops: true }), {}, { TSLA: 20 });
    expect(out.some((p) => p.symbol === "TSLA")).toBe(false);
  });
  it("uses the ATR-based stop distance (tighter) so a -15% move breaches a 5% ATR stop", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, atrStops: true }), {}, { TSLA: 5 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
  it("ATR takes precedence over beta-scaling when both are on (beta 2 would widen to 20%, ATR 5% overrides)", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, atrStops: true, betaScaledStops: true }), { TSLA: 2 }, { TSLA: 5 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
  it("falls back to the fixed/beta stop when no ATR pct is supplied for the symbol", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, atrStops: true }), {}, {});
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
  it("ignores the ATR map entirely when atrStops is off (default)", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules }), {}, { TSLA: 20 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
});
