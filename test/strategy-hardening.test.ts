import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal, betaScaledStopPct } from "../src/lib/policy";
import {
  BULL_PROPOSAL_REQUIRED_KEYS,
  firstQuoteTolerantBlockEnd,
  enrichOpeningProposal,
  filterRepairedProposals,
  filterStopPlansByLiveBasis,
  generateProactiveRiskProposals,
  sanitizeProposals
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
import { allowedProposalSides, deterministicBearFilter } from "../src/lib/strategy-risk";

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
  it("attaches stop/take brackets for Tradier limit orders (native OTOCO/OTO bracket support)", () => {
    const p = enrichOpeningProposal(buy({ type: "limit", limitPrice: 100 }), policy({ activeBroker: "tradier", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }), marketScan);
    expect(p.bracketStopLoss).toBe(92);
    expect(p.bracketTakeProfit).toBe(120);
  });
  it("does not attach brackets for Tradier market orders (multi-leg entry does not support market type)", () => {
    const p = enrichOpeningProposal(buy(), policy({ activeBroker: "tradier", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }), marketScan);
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
  });
  it("keeps native brackets for a Tradier market entry the marketable-limit conversion turns into a limit (PR #1701 finding 2)", () => {
    // A Tradier `market` entry that qualifies for marketable-limit conversion becomes a `limit`
    // order a few lines later — a type Tradier's native OTOCO/OTO bracket DOES support. The strip
    // must NOT fire for it, or the converted limit order ends up with no native broker-held
    // protection. dollarAmount 1000 / price 100 = 10 whole shares (>= 1), so it converts.
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000 }),
      policy({ activeBroker: "tradier", marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"], riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan
    );
    expect(p.type).toBe("limit"); // converted to a marketable limit
    // The bracket legs anchor to the CONVERTED limit price, not the pre-conversion reference (Codex
    // review, PR #1738): no real ask on this quote, so the buy limit is refPrice*(1+15bps)=100.15,
    // and the legs price off that (100.15*0.92=92.14 stop, 100.15*1.2=120.18 take) — NOT 92/120 off
    // the raw 100 reference. The take-profit must stay strictly above the entry limit or the OTOCO
    // would be rejected / exit at a loss.
    expect(p.limitPrice).toBe(100.15);
    expect(p.bracketStopLoss).toBe(92.14); // native bracket legs survived AND repriced to the limit
    expect(p.bracketTakeProfit).toBe(120.18);
    expect(p.bracketTakeProfit!).toBeGreaterThan(p.limitPrice!);
    expect(p.bracketStopLoss!).toBeLessThan(p.limitPrice!);
    // The market-entry strip's "not supported" annotation must NOT have been applied.
    expect(p.rationale).not.toContain("Tradier native entry brackets are not supported");
  });
  it("reprices bracket legs to a marketable-limit that lands ABOVE the reference via a real ask (Codex PR #1738)", () => {
    // The finding's exact shape: a wide/stale spread pushes the converted buy limit well above the
    // reference. A take-profit priced off the raw reference could then sit AT/BELOW the fill. With the
    // fix, both legs anchor to the actual limit so the take-profit is always a real profit target.
    // ref/entry 100, real ask 120 -> buy limit 120*(1+15bps)=120.18; 20% take -> 120.18*1.2=144.22.
    const withWideAsk: MarketScan = {
      ...marketScan,
      quotesBySymbol: {
        TSLA: { symbol: "TSLA", price: 100, ask: 120, score: 50, sources: { ask: "alpaca" } }
      }
    };
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000 }),
      policy({ activeBroker: "tradier", marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"], riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      withWideAsk
    );
    expect(p.type).toBe("limit");
    expect(p.limitPrice).toBe(120.18);
    expect(p.bracketTakeProfit).toBe(144.22); // off the limit, not 120 off the reference
    expect(p.bracketStopLoss).toBe(110.57); // 120.18*0.92
    // The pre-fix bug: take-profit would have been 120, i.e. BELOW the 120.18 entry — an instant loss.
    expect(p.bracketTakeProfit!).toBeGreaterThan(p.limitPrice!);
  });
  it("strips Tradier brackets when a pathological buffer makes the marketable-limit non-positive — conversion no-ops, order stays market (Codex PR #1738)", () => {
    // marketableLimitBufferBps 10000 (buffer 1.0) makes a SHORT limit bid*(1-1.0)=0 → non-positive →
    // marketableLimitPrice undefined → the conversion block leaves the order type: "market". Gating the
    // strip on the ACTUAL converted price (not just the willBecomeMarketableLimit predicate) means the
    // un-converted Tradier market order correctly has its OTOCO legs stripped rather than handed to a
    // gateway that can't carry them.
    const withBid: MarketScan = {
      ...marketScan,
      quotesBySymbol: { TSLA: { symbol: "TSLA", price: 100, bid: 100, score: 50, sources: { bid: "alpaca" } } }
    };
    const p = enrichOpeningProposal(
      buy({ side: "short", dollarAmount: 1000, bracketStopLoss: 105, bracketTakeProfit: 80 }),
      policy({ activeBroker: "tradier", shortSellingEnabled: true, marketableLimitEntries: true, permittedOrderTypes: ["market", "limit"], tuning: { marketableLimitBufferBps: 10000 }, riskRules: { shortStopLossPct: 5, takeProfitPct: 20 } }),
      withBid
    );
    expect(p.type).toBe("market"); // conversion no-op'd (computed limit was non-positive)
    expect(p.bracketStopLoss).toBeUndefined(); // legs stripped — Tradier can't bracket a market entry
    expect(p.bracketTakeProfit).toBeUndefined();
    expect(p.rationale).toContain("Tradier native entry brackets are not supported");
  });
  it("still strips brackets for a Tradier market entry that will NOT convert (marketable-limit off)", () => {
    // Guardrail for the finding-2 fix: with the conversion disabled the entry STAYS a market order,
    // which Tradier can't bracket — the strip must still fire.
    const p = enrichOpeningProposal(
      buy({ dollarAmount: 1000 }),
      policy({ activeBroker: "tradier", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan
    );
    expect(p.type).toBe("market");
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
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
  it("ignores the ATR map entirely when atrStops is explicitly off", () => {
    // atrStops now defaults ON, so exercise the OFF path explicitly: the ATR map is ignored and the
    // flat 10% stop applies, which a -15% move breaches.
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules, atrStops: false }), {}, { TSLA: 20 });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
});

describe("generateProactiveRiskProposals per-position stop plans", () => {
  const positions: EquityPosition[] = [{ symbol: "TSLA", quantity: 10, averageCost: 100, marketValue: 850, sector: "Auto" }];
  const prices = { TSLA: 85 }; // down 15%
  const stopRules: TradingPolicy["riskRules"] = { stopLossPct: 10 };
  const noStopRules: TradingPolicy["riskRules"] = { stopLossPct: 0 };

  it("a 'none' plan suppresses the exit even though the flat % would have breached", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules }), {}, {}, undefined, {}, { TSLA: "none" });
    expect(out.some((p) => p.symbol === "TSLA")).toBe(false);
  });

  it("a 'trailing' plan suppresses this generator's fixed/ATR exit (trailing is handled elsewhere)", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules }), {}, {}, undefined, {}, { TSLA: "trailing" });
    expect(out.some((p) => p.symbol === "TSLA")).toBe(false);
  });

  it("a 'fixed' plan pins to STOP_PLAN_FALLBACK_STOP_PCT (8%) when the account has NO stop-loss % configured at all", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: noStopRules }), {}, {}, undefined, {}, { TSLA: "fixed" });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });

  it("an 'atr' plan uses the supplied per-symbol ATR pct even with no account-wide stop-loss configured", () => {
    // A wide 20% ATR distance is NOT breached by a -15% move.
    const wide = generateProactiveRiskProposals(positions, prices, policy({ riskRules: noStopRules }), {}, { TSLA: 20 }, undefined, {}, { TSLA: "atr" });
    expect(wide.some((p) => p.symbol === "TSLA")).toBe(false);
    // A tight 5% ATR distance IS breached.
    const tight = generateProactiveRiskProposals(positions, prices, policy({ riskRules: noStopRules }), {}, { TSLA: 5 }, undefined, {}, { TSLA: "atr" });
    expect(tight.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });

  it("an 'atr' plan falls back to STOP_PLAN_FALLBACK_STOP_PCT when no ATR pct was supplied for the symbol", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: noStopRules }), {}, {}, undefined, {}, { TSLA: "atr" });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });

  it("universal availability: a plan-only account (no account-wide stop configured, no atrStops toggle) still protects the position", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: noStopRules, atrStops: false, betaScaledStops: false }), {}, {}, undefined, {}, { TSLA: "fixed" });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });

  it("a plan for a DIFFERENT symbol does not affect this one — 'default' (absent) keeps the account's own precedence", () => {
    const out = generateProactiveRiskProposals(positions, prices, policy({ riskRules: stopRules }), {}, {}, undefined, {}, { AAPL: "none" });
    expect(out.some((p) => p.symbol === "TSLA" && p.side === "sell")).toBe(true);
  });
});

describe("filterStopPlansByLiveBasis (Codex review, PR #1371)", () => {
  const pos = (symbol: string, averageCost: number, quantity = 10): EquityPosition => ({
    symbol, quantity, averageCost, marketValue: quantity * averageCost
  });

  it("keeps a plan whose recorded avgCost matches the live position exactly", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "trailing", avgCost: 100, side: "long" } },
      [pos("NVDA", 100)]
    );
    expect(out).toEqual({ NVDA: "trailing" });
  });

  it("keeps a plan within the small rounding tolerance", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "fixed", avgCost: 100.001, side: "long" } },
      [pos("NVDA", 100)]
    );
    expect(out).toEqual({ NVDA: "fixed" });
  });

  it("drops a plan recorded for a LONG lot when the live position at the same symbol/basis is now a SHORT (a closed long re-shorted at a coincidentally similar cost basis is a different lot, not a continuation)", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "trailing", avgCost: 100, side: "long" } },
      [pos("NVDA", 100, -10)]
    );
    expect(out).toEqual({});
  });

  it("drops a STALE plan whose recorded avgCost no longer matches the live position (closed + re-bought at a different basis)", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "none", avgCost: 100 } },
      [pos("NVDA", 130)] // re-bought at a materially different cost basis
    );
    expect(out).toEqual({});
  });

  it("drops a plan for a symbol with NO current position at all (no basis to compare — a persisted row only makes sense for a scale-in)", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "trailing", avgCost: 100 } },
      []
    );
    expect(out).toEqual({});
  });

  it("drops a plan for a fully-closed position (quantity ~0)", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "trailing", avgCost: 100 } },
      [pos("NVDA", 100, 0)]
    );
    expect(out).toEqual({});
  });

  it("drops 'default' style plans (the no-op case) regardless of basis", () => {
    const out = filterStopPlansByLiveBasis(
      { NVDA: { style: "default", avgCost: 100 } },
      [pos("NVDA", 100)]
    );
    expect(out).toEqual({});
  });
});

describe("sanitizeProposals — per-position stop plan coercion (Codex review, PR #1371)", () => {
  it("drops a 'none' plan with no rationale entirely (an unauditable no-stop choice must never silently apply, and must never manufacture a 'default' RESET of an existing override)", () => {
    const [p] = sanitizeProposals([buy({ stopPlan: { style: "none" } })]);
    expect(p.stopPlan).toBeUndefined();
  });

  it("drops a 'none' plan with a blank/whitespace-only rationale too", () => {
    const [p] = sanitizeProposals([buy({ stopPlan: { style: "none", rationale: "   " } })]);
    expect(p.stopPlan).toBeUndefined();
  });

  it("keeps a 'none' plan WITH a real rationale", () => {
    const [p] = sanitizeProposals([buy({ stopPlan: { style: "none", rationale: "high-conviction, riding through drawdown" } })]);
    expect(p.stopPlan).toEqual({ style: "none", rationale: "high-conviction, riding through drawdown" });
  });

  it("preserves an EXPLICIT 'default' instead of collapsing it to no-plan-at-all (so a scale-in can reset a persisted override)", () => {
    const [p] = sanitizeProposals([buy({ stopPlan: { style: "default" } })]);
    expect(p.stopPlan).toEqual({ style: "default" });
  });

  it("drops stopPlan entirely when the LLM sends none at all (null) — distinct from an explicit 'default'", () => {
    const [p] = sanitizeProposals([buy({ stopPlan: undefined })]);
    expect(p.stopPlan).toBeUndefined();
  });

  it("drops stopPlan for a sell/cover proposal even if one is somehow attached", () => {
    const [p] = sanitizeProposals([buy({ side: "sell", stopPlan: { style: "trailing" } })]);
    expect(p.stopPlan).toBeUndefined();
  });
});

describe("enrichOpeningProposal per-position stop plans", () => {
  const marketScan = scan({ TSLA: { price: 100 } });

  it("a 'trailing' plan on the proposal discards any LLM-proposed bracket stop AND take-profit (a resting TP-only leg would itself look like broker-held coverage and suppress the real trailing stop)", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "trailing" }, bracketStopLoss: 90 }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan
    );
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
  });

  it("strips a 'trailing'/'none' plan's bracket legs even on a SUB-SHARE dollar order (canUseWholeShareBracket false) — leaving them would make the Alpaca gateway treat it as a bracket dollar order and reject it for being below one whole share (Codex review, PR #1371)", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "trailing" }, dollarAmount: 50, quantity: undefined, bracketStopLoss: 90, bracketTakeProfit: 120 }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan // TSLA @ $100 — $50 is sub-share
    );
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
  });

  it("a 'none' plan on the proposal discards any LLM-proposed bracket stop AND take-profit (no bracket legs at all — the position runs unprotected by design)", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "none", rationale: "high-conviction thesis, no stop desired" }, bracketStopLoss: 90 }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan
    );
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
  });

  it("a 'fixed' plan pins to STOP_PLAN_FALLBACK_STOP_PCT (8%) when the account has no stop-loss % configured", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "fixed" } }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 0 } }),
      marketScan
    );
    expect(p.bracketStopLoss).toBe(92); // 100 * (1 - 8/100)
  });

  it("an 'atr' plan uses the supplied per-symbol ATR pct for the opening bracket", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "atr" } }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 0 } }),
      marketScan,
      { TSLA: 5 }
    );
    expect(p.bracketStopLoss).toBe(95); // 100 * (1 - 5/100)
  });

  it("a 'default' (no explicit plan) opening does NOT attach an ATR bracket stop when the account has atrStops on but NO base stop-loss % configured (ATR only SCALES an already-enabled flat stop — Codex review, PR #1371)", () => {
    const p = enrichOpeningProposal(
      buy(), // no stopPlan at all — "default" precedence
      policy({ activeBroker: "alpaca", atrStops: true, riskRules: { stopLossPct: 0 } }),
      marketScan,
      { TSLA: 5 } // a positive ATR pct IS available for this symbol
    );
    expect(p.bracketStopLoss).toBeUndefined();
  });

  it("a 'default' opening DOES use the ATR pct when atrStops is on AND the account has a base stop-loss % configured (ATR scales the already-enabled flat stop)", () => {
    const p = enrichOpeningProposal(
      buy(),
      policy({ activeBroker: "alpaca", atrStops: true, riskRules: { stopLossPct: 8 } }),
      marketScan,
      { TSLA: 5 }
    );
    expect(p.bracketStopLoss).toBe(95); // 100 * (1 - 5/100) — ATR wins over the flat 8%
  });

  it("a 'fixed'/'atr' plan ALWAYS reprices the bracket stop, discarding even a valid LLM-proposed one (the pinned plan distance must never silently diverge from what every other enforcement layer prices for this symbol)", () => {
    const fixed = enrichOpeningProposal(
      buy({ stopPlan: { style: "fixed" }, bracketStopLoss: 90 }), // 90 IS a valid on-the-correct-side LLM stop
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8 } }),
      marketScan
    );
    expect(fixed.bracketStopLoss).toBe(92); // repriced to the pinned 8%, not the LLM's 90
    const atr = enrichOpeningProposal(
      buy({ stopPlan: { style: "atr" }, bracketStopLoss: 90 }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 0 } }),
      marketScan,
      { TSLA: 5 }
    );
    expect(atr.bracketStopLoss).toBe(95); // repriced to the pinned ATR 5%, not the LLM's 90
  });

  it("honors a PERSISTED plan (stopPlanBySymbol, e.g. a scale-in add) when the proposal itself carries no fresh stopPlan, AND stamps it onto the returned proposal so the approval card's disclosure (which reads p.stopPlan directly) shows the inherited choice (Codex review, PR #1371)", () => {
    const p = enrichOpeningProposal(
      buy(),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan,
      {},
      { TSLA: "trailing" }
    );
    expect(p.bracketStopLoss).toBeUndefined();
    expect(p.bracketTakeProfit).toBeUndefined();
    expect(p.stopPlan).toEqual({ style: "trailing" });
  });

  it("the proposal's OWN fresh stopPlan takes precedence over a stale persisted one", () => {
    const p = enrichOpeningProposal(
      buy({ stopPlan: { style: "fixed" } }),
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan,
      {},
      { TSLA: "none" }
    );
    expect(p.bracketStopLoss).toBe(92);
  });

  it("carries the inherited plan's ORIGINAL rationale onto the stamped stopPlan (a 'none' plan's required justification must survive a scale-in, not be erased to NULL on the fill upsert) (Codex review, PR #1371)", () => {
    const p = enrichOpeningProposal(
      buy(), // scale-in add that omits its own stopPlan — inherits the persisted "none" plan
      policy({ activeBroker: "alpaca", riskRules: { stopLossPct: 8, takeProfitPct: 20 } }),
      marketScan,
      {},
      { TSLA: "none" },
      { TSLA: "high-conviction thesis, riding through the drawdown" }
    );
    // Pre-fix the stamp was style-only ({ style: "none" }); the rationale was dropped by
    // filterStopPlansByLiveBasis and never threaded here, so recordFillFromProposal later nulled the
    // stored justification on the scale-in fill's upsert.
    expect(p.stopPlan).toEqual({ style: "none", rationale: "high-conviction thesis, riding through the drawdown" });
  });
});

describe("firstQuoteTolerantBlockEnd (Bull trailing-JSON ambiguity, Codex round 11)", () => {
  it("finds the end of a single-quoted block whose strings contain braces, and exposes trailing JSON", () => {
    const text = "{'proposals': [{'rationale': 'breaks the {wedge}'}]} Correction: []";
    const end = firstQuoteTolerantBlockEnd(text);
    expect(end).toBeGreaterThan(0);
    expect(text.slice(end + 1)).toContain("[]"); // the guard treats this trailing JSON as ambiguous
  });

  it("reports no trailing JSON for a clean single block", () => {
    const text = "{'proposals': []}";
    const end = firstQuoteTolerantBlockEnd(text);
    expect(end).toBe(text.length - 1);
    expect(/[[{]/.test(text.slice(end + 1))).toBe(false);
  });
});

describe("filterRepairedProposals (post-jsonrepair completeness gate, Codex P1 PR #1696)", () => {
  const complete = () => ({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    quantity: null,
    dollarAmount: 1000,
    limitPrice: null,
    stopPrice: null,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Breakout over the 50d with volume confirmation.",
    tradeThesisTag: "Momentum-Breakout",
    confidenceScore: 72,
    autonomyOverride: null,
    bracketStopLoss: 172.5,
    bracketTakeProfit: 205,
    stopPlan: { style: "atr", rationale: null }
  });

  it("keeps a schema-complete proposal", () => {
    const { kept, dropped } = filterRepairedProposals([complete()]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it("drops a proposal truncated mid-object (missing tail keys), keeping complete siblings", () => {
    const truncated: Record<string, unknown> = { symbol: "NVDA", side: "buy", type: "market" };
    const { kept, dropped } = filterRepairedProposals([complete(), truncated]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.symbol).toBe("AAPL");
    expect(dropped).toBe(1);
  });

  it("drops a proposal whose judgment fields are empty even when every key is present", () => {
    const hollow = { ...complete(), rationale: "  ", tradeThesisTag: "", confidenceScore: Number.NaN };
    const { kept, dropped } = filterRepairedProposals([hollow]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it("drops a repaired proposal whose identity fields have wrong TYPES even with all keys present (Codex round 2)", () => {
    // json_object-mode repair can produce schema-invalid values; a numeric symbol would crash
    // normalizeSymbol(.trim()) downstream and abort the whole run.
    const wrongTypes = { ...complete(), symbol: 42 };
    const badSide = { ...complete(), side: { verdict: "buy" } };
    const badType = { ...complete(), type: "market_if_touched" };
    const { kept, dropped } = filterRepairedProposals([wrongTypes, badSide, badType, complete()]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.symbol).toBe("AAPL");
    expect(dropped).toBe(3);
  });

  it("drops a repaired proposal for a symbol outside the run's schema enum (Codex round 10)", () => {
    // A repaired sell on an UNHELD symbol would reach Alpaca as side:sell and open an
    // unintended short — the openings candidate gate only checks buy/short.
    const offEnum = { ...complete(), symbol: "ZZZQ", side: "sell" };
    const restricted = filterRepairedProposals([offEnum, complete()], ["buy", "sell"], ["AAPL", "NVDA"]);
    expect(restricted.kept).toHaveLength(1);
    expect(restricted.kept[0]?.symbol).toBe("AAPL");
    expect(restricted.dropped).toBe(1);
    // No enum (schema bare-string fallback) keeps prior behavior.
    const unrestricted = filterRepairedProposals([offEnum], ["buy", "sell"]);
    expect(unrestricted.kept).toHaveLength(1);
  });

  it("drops a repaired short when the run's schema is long-only (Codex round 8)", () => {
    const shortIdea = { ...complete(), side: "short" };
    const longOnly = filterRepairedProposals([shortIdea, complete()], ["buy", "sell"]);
    expect(longOnly.kept).toHaveLength(1);
    expect(longOnly.kept[0]?.side).toBe("buy");
    expect(longOnly.dropped).toBe(1);
    // Same proposal survives when the run's schema exposes shorts.
    const shortsOn = filterRepairedProposals([shortIdea], ["buy", "sell", "short", "cover"]);
    expect(shortsOn.kept).toHaveLength(1);
  });

  it("strips schema-extraneous fields from kept repaired proposals (Codex round 7)", () => {
    // additionalProperties: false — a smuggled bracketStopLimit would turn the protective stop
    // into a stop-limit order at the Alpaca adapter.
    const smuggler = { ...complete(), bracketStopLimit: 171.9, stopPlan: { style: "atr", rationale: null, resetAll: true } };
    const { kept, dropped } = filterRepairedProposals([smuggler]);
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(1);
    expect("bracketStopLimit" in (kept[0] as unknown as Record<string, unknown>)).toBe(false);
    expect("resetAll" in ((kept[0]?.stopPlan ?? {}) as Record<string, unknown>)).toBe(false);
    expect(kept[0]?.bracketStopLoss).toBe(172.5);
  });

  it("drops a repaired proposal with a fabricated (non-playbook) thesis tag (Codex round 6)", () => {
    // A tag outside THESIS_PLAYBOOK has no scorecard history, so it would bypass the
    // negative-expectancy skip gate as "unproven".
    const madeUpTag = { ...complete(), tradeThesisTag: "vibes-based-momentum" };
    const { kept, dropped } = filterRepairedProposals([madeUpTag, complete()]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.tradeThesisTag).toBe("Momentum-Breakout");
    expect(dropped).toBe(1);
  });

  it("drops repaired proposals with null execution enums, out-of-range confidence, or invalid stopPlan (Codex round 5)", () => {
    const nullTif = { ...complete(), timeInForce: null };
    const nullHours = { ...complete(), marketHours: null };
    const maxedConfidence = { ...complete(), confidenceScore: 999 };
    const bareReset = { ...complete(), stopPlan: { style: "default" } }; // missing required rationale key
    const nakedNone = { ...complete(), stopPlan: { style: "none", rationale: "  " } }; // no-stop without justification
    const { kept, dropped } = filterRepairedProposals([nullTif, nullHours, maxedConfidence, bareReset, nakedNone, complete()]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(5);
  });

  it("drops repaired proposals with out-of-enum timeInForce or coercible autonomyOverride (Codex round 4)", () => {
    // "day" is not in the gfd/gtc schema enum — Alpaca maps unknown strings to gtc.
    const dayTif = { ...complete(), timeInForce: "day" };
    // An object thesis coerces to "[object Object]" and could pass preference gates as a
    // "real" override thesis under execute mode.
    const junkOverride = { ...complete(), autonomyOverride: { requested: true, thesis: {} } };
    const validOverride = {
      ...complete(),
      autonomyOverride: { requested: true, thesis: "Earnings momentum intact.", preferenceConflicts: [], invalidation: null, cashDeploymentPct: null }
    };
    const { kept, dropped } = filterRepairedProposals([dayTif, junkOverride, validOverride]);
    expect(kept).toHaveLength(1);
    expect((kept[0]?.autonomyOverride as { thesis?: string })?.thesis).toBe("Earnings momentum intact.");
    expect(dropped).toBe(2);
  });

  it("drops a repaired proposal whose sizing fields are non-numeric strings (Codex round 3)", () => {
    // sanitize preserves a string dollarAmount via ??, and Robinhood later calls .toFixed on it.
    const stringMoney = { ...complete(), dollarAmount: "100" };
    const stringQty = { ...complete(), quantity: "3" };
    const nullsOk = { ...complete(), dollarAmount: null, limitPrice: null };
    const { kept, dropped } = filterRepairedProposals([stringMoney, stringQty, nullsOk]);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("drops non-object entries outright", () => {
    const { kept, dropped } = filterRepairedProposals([null, 42, "proposal", [complete()]]);
    expect(kept).toHaveLength(0);
    expect(dropped).toBe(4);
  });

  it("the completeness gate and the structured-output schema share one required-keys source", () => {
    // If a future schema change adds/removes a required key, this import proves the gate moves
    // with it (the schema literal spreads the same constant).
    expect(BULL_PROPOSAL_REQUIRED_KEYS).toContain("stopPlan");
    expect(BULL_PROPOSAL_REQUIRED_KEYS).toContain("tradeThesisTag");
    expect(new Set(BULL_PROPOSAL_REQUIRED_KEYS).size).toBe(BULL_PROPOSAL_REQUIRED_KEYS.length);
  });
});
