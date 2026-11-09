import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { allowedSymbolsForPolicy, applyOpeningOrderHeadroom, evaluateTradeProposal } from "../src/lib/policy";
import type { AccountCapabilities, EquityPosition, MarketQuote, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";
import { getUserWashSaleLockProvenance } from "../src/lib/tax";
import type { WashSaleLockMap } from "../src/lib/tax";

// Mock the tax module so the authoritative wash-sale gate tests don't need a DB.
vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string): WashSaleLockMap => new Map()),
}));

// Minimal AccountCapabilities that grants short-selling for tests that verify the enabled path.
const shortCapableAccount: AccountCapabilities = {
  equityTrading: true,
  shortSelling: true,
  optionsTrading: false,
  futuresTrading: false,
  cryptoTrading: false,
  marginEnabled: true,
  accountType: "brokerage"
};

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000
};

const positions: EquityPosition[] = [{ symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 1000, sector: "Technology" }];

const enabledPolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["AAPL", "TSLA"],
  // maxQuoteAgeSec defaulted to 120 on 2026-07-28 (guard enablement); these tests exercise OTHER
  // gates without a marketScan in context, so pin the staleness gate off — a missing timestamp is
  // treated as stale while the gate is on.
  maxQuoteAgeSec: 0
};

const proposal: TradeProposal = {
  symbol: "TSLA",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
};

describe("evaluateTradeProposal", () => {
  it("approves an in-policy order", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: enabledPolicy,
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks an opening order that exceeds the maxOrderPctOfAdv market-impact cap", () => {
    const tslaQuote = { symbol: "TSLA", price: 10, volume: 100, intradayChangePct: 0, positionMarketValue: 0, score: 1 } as MarketQuote;
    const marketScan = {
      source: "test", generatedAt: "2026-06-22T00:00:00.000Z", scannedSymbols: 1, returnedQuotes: 1,
      topCandidates: [tslaQuote], sectorBySymbol: {}, quotesBySymbol: {}, warnings: []
    } as MarketScan;
    // daily $-vol = 10 × 100 = $1,000; 5% ADV cap = $50; order $100 > $50 → reject.
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, maxOrderPctOfNav: undefined, maxOrderNotional: 10_000, maxOrderPctOfAdv: 5 },
      portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 100,
      washSaleLockedSymbols: new Set(), marketScan
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("daily $-volume"))).toBe(true);
  });

  it("allows the same order when the ADV cap is disabled", () => {
    const tslaQuote = { symbol: "TSLA", price: 10, volume: 100, intradayChangePct: 0, positionMarketValue: 0, score: 1 } as MarketQuote;
    const marketScan = {
      source: "test", generatedAt: "2026-06-22T00:00:00.000Z", scannedSymbols: 1, returnedQuotes: 1,
      topCandidates: [tslaQuote], sectorBySymbol: {}, quotesBySymbol: {}, warnings: []
    } as MarketScan;
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, maxOrderPctOfNav: undefined, maxOrderNotional: 10_000, maxOrderPctOfAdv: undefined },
      portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 100,
      washSaleLockedSymbols: new Set(), marketScan
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks a buy of a wash-sale-locked symbol when the guard is on and handling is explicitly 'block'", () => {
    // "auto" (the default since 2026-07-03) always proceeds — explicitly opt into "block" to
    // exercise the hard-stop path this test is about.
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, taxSettings: { washSaleGuard: true, washSaleHandling: "block" as const, shortTermRatePct: 24, longTermRatePct: 15 } },
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      washSaleLockedSymbols: new Set(["TSLA"])
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("wash-sale"))).toBe(true);
  });

  it("allows a locked-symbol buy when the wash-sale guard is disabled", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, taxSettings: { washSaleGuard: false, shortTermRatePct: 24, longTermRatePct: 15 } },
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      washSaleLockedSymbols: new Set(["TSLA"])
    });
    expect(decision.approved).toBe(true);
  });

  // Authoritative cross-account wash-sale gate (architecture-blueprint §3.3):
  // the gate must block the buy even when the caller omits the locked set/map,
  // resolving the provenance via getUserWashSaleLockProvenance(userId) itself.
  it("blocks a buy of a wash-sale-locked symbol at the gate even when washSaleLockedSymbols is omitted", () => {
    vi.mocked(getUserWashSaleLockProvenance).mockReturnValueOnce(
      new Map([["TSLA", { account: "ACC1", clearDate: new Date("2026-07-20T00:00:00.000Z"), lossUsd: 100 }]])
    );
    // "auto" (the default since 2026-07-03) always proceeds — explicitly opt into "block" to
    // exercise the hard-stop path this test is about.
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, taxSettings: { washSaleGuard: true, washSaleHandling: "block" as const, shortTermRatePct: 24, longTermRatePct: 15 } },
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      userId: "user-test",
      // intentionally omitting washSaleLocks/washSaleLockedSymbols — gate must resolve it itself
    });
    expect(getUserWashSaleLockProvenance).toHaveBeenCalledWith("user-test", expect.any(Date));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("wash-sale"))).toBe(true);
  });

  it("does not call getUserWashSaleLockProvenance when washSaleLockedSymbols is pre-populated", () => {
    vi.mocked(getUserWashSaleLockProvenance).mockClear();
    // "auto" (the default since 2026-07-03) always proceeds — explicitly opt into "block" to
    // exercise the hard-stop path this test is about.
    const decision = evaluateTradeProposal(proposal, {
      policy: { ...enabledPolicy, taxSettings: { washSaleGuard: true, washSaleHandling: "block" as const, shortTermRatePct: 24, longTermRatePct: 15 } },
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10,
      washSaleLockedSymbols: new Set(["TSLA"]),
      userId: "user-test",
    });
    // Pre-populated set is used directly; no extra DB call.
    expect(getUserWashSaleLockProvenance).not.toHaveBeenCalled();
    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes("wash-sale"))).toBe(true);
  });

  it("blocks symbols outside the allowed universe", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "MSFT" }, context());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("allows a dynamic-universe symbol when it is present in the latest market scan", () => {
    const marketScan = {
      source: "test",
      generatedAt: "2026-06-23T00:00:00.000Z",
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [],
      sectorBySymbol: {},
      quotesBySymbol: { XYZ: { symbol: "XYZ", price: 25, score: 62 } },
      warnings: []
    } as MarketScan;
    const decision = evaluateTradeProposal({ ...proposal, symbol: "XYZ" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["russell2000"], additionalSymbols: [] },
      estimatedNotional: 10,
      marketScan
    });

    expect(decision.approved).toBe(true);
  });

  it("blocks a dynamic-universe symbol when no scan proves membership", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "XYZ" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["russell2000"], additionalSymbols: [] },
      estimatedNotional: 10
    });

    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("allows S&P 500 symbols when the S&P universe is selected", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["sp500"], additionalSymbols: [] },
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  it("allows Nasdaq 100 and Dow 30 symbols when those universes are selected", () => {
    const nasdaqDecision = evaluateTradeProposal({ ...proposal, symbol: "ASML" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["nasdaq100"], additionalSymbols: [] },
      estimatedNotional: 10
    });
    const dowDecision = evaluateTradeProposal({ ...proposal, symbol: "GS" }, {
      ...context(),
      policy: { ...enabledPolicy, includedIndices: ["dow30"], additionalSymbols: [] },
      estimatedNotional: 10
    });

    expect(nasdaqDecision.approved).toBe(true);
    expect(dowDecision.approved).toBe(true);
  });

  it("subtracts the ignore list from selected indexes and additional watchlist symbols", () => {
    const policy: TradingPolicy = { ...enabledPolicy, includedIndices: ["dow30"], additionalSymbols: ["AAPL", "TSLA"], blocklist: ["AAPL", "GS"] };
    const allowedSymbols = allowedSymbolsForPolicy(policy);
    const blockedDecision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, { ...context(), policy, estimatedNotional: 10 });

    expect(allowedSymbols).not.toContain("AAPL");
    expect(allowedSymbols).not.toContain("GS");
    expect(allowedSymbols).toContain("TSLA");
    expect(blockedDecision.approved).toBe(false);
    expect(blockedDecision.reasons.join(" ")).toContain("not in the allowed universe");
  });

  it("blocks orders over max notional", () => {
    const decision = evaluateTradeProposal({ ...proposal, dollarAmount: 1200 }, context(1200));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds the maximum order limit");
  });

  it("blocks opening orders that sit inside the max but leave no execution buffer", () => {
    expect(applyOpeningOrderHeadroom(4.99)).toBe(4.74);
    const decision = evaluateTradeProposal({ ...proposal, dollarAmount: 4.95 }, {
      ...context(4.95),
      policy: { ...enabledPolicy, maxOrderNotional: 4.99, maxOrderPctOfNav: undefined, maxDailyNotional: 100 }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("less than 5% buffer");
    expect(decision.reasons.join(" ")).toContain("$4.74");
  });

  it("blocks daily notional overflow", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      policy: { ...enabledPolicy, maxDailyNotional: 500, maxDailyPctOfNav: undefined },
      dailyNotionalUsed: 495
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Daily notional");
  });

  it("blocks daily order count overflow", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      dailyOrderCount: 10
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Daily opening-order count");
  });

  it("blocks hourly notional overflow independently of the daily cap (R1)", () => {
    const base = context();
    const decision = evaluateTradeProposal(proposal, {
      ...base,
      policy: { ...base.policy, maxHourlyNotional: 100 },
      hourlyNotionalUsed: 95 // 95 + 10 estimated > 100, but well under the daily cap
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Hourly notional");
  });

  it("allows an order within the hourly cap (R1)", () => {
    const base = context();
    const decision = evaluateTradeProposal(proposal, {
      ...base,
      policy: { ...base.policy, maxHourlyNotional: 1000 },
      hourlyNotionalUsed: 100
    });
    expect(decision.approved).toBe(true);
  });

  it("blocks over-concentrated post-trade exposure", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL", dollarAmount: 2000 }, context(2000));
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Projected AAPL exposure");
  });

  it("blocks sector cap overflow using position metadata", () => {
    const decision = evaluateTradeProposal({ ...proposal, symbol: "AAPL" }, {
      ...context(),
      policy: { ...enabledPolicy, sectorCaps: { Technology: 10 } }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("Technology sector exposure");
  });

  it("blocks adding to positions past stop-loss or take-profit rules", () => {
    const stopLoss = evaluateTradeProposal({ ...proposal, symbol: "AAPL", limitPrice: 150 }, {
      ...context(),
      positions: [{ symbol: "AAPL", quantity: 5, averageCost: 250, marketValue: 1000, sector: "Technology" }]
    });
    const takeProfit = evaluateTradeProposal({ ...proposal, symbol: "AAPL", limitPrice: 150 }, {
      ...context(),
      positions: [{ symbol: "AAPL", quantity: 5, averageCost: 100, marketValue: 1500, sector: "Technology" }]
    });
    expect(stopLoss.approved).toBe(false);
    expect(stopLoss.reasons.join(" ")).toContain("Stop-loss");
    expect(takeProfit.approved).toBe(false);
    expect(takeProfit.reasons.join(" ")).toContain("Take-profit");
  });

  it("blocks fractional or dollar-based orders outside regular hours", () => {
    const decision = evaluateTradeProposal({ ...proposal, marketHours: "extended_hours" }, context());
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("regular-hours only");
  });

  it("blocks selling more than held quantity", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 10, dollarAmount: undefined, limitPrice: 200 },
      context(2000)
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds current AAPL holdings");
  });

  it("allows sell orders to bypass max order notional and daily notional limits", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 1, dollarAmount: undefined, limitPrice: 2000 },
      {
        ...context(2000),
        dailyNotionalUsed: 2000,
        dailyOrderCount: 10
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("preserves crisis-regime opening buys when no crisis exposure cap is configured", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Crisis (Extreme Volatility)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50
        }
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("blocks opening exposure over the configured cap in crisis or inverted regimes", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Cautious (Inverted Curve)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("crisis/inverted-regime cap 5%");
  });

  it("does not apply the crisis exposure cap in normal regimes", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Neutral (Normal Volatility)", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("does not apply the crisis cap to a non-canonical free-text regime label (typed-enum hardening)", () => {
    // Same over-cap opening exposure as the blocking case above, but with a bare non-canonical
    // "Crisis" label. The old substring rule (includes("crisis")) would have capped it; the typed
    // adoption maps any non-canonical string to `unknown`, so a stray label can never silently trip
    // the crisis cap. Production always persists a canonical label via determineMarketRegime.
    const decision = evaluateTradeProposal(
      { ...proposal, entryMarketRegime: "Crisis", dollarAmount: 1200 },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("does not block risk-reducing sells or covers with the crisis exposure cap", () => {
    const sell = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 1, dollarAmount: undefined, limitPrice: 1200, entryMarketRegime: "Crisis (Extreme Volatility)" },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        }
      }
    );
    const cover = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 1, dollarAmount: undefined, limitPrice: 1200, entryMarketRegime: "Cautious (Inverted Curve)" },
      {
        ...context(1200),
        policy: {
          ...enabledPolicy,
          additionalSymbols: ["AAPL", "VOO", "TSLA"],
          shortSellingEnabled: true,
          maxOrderNotional: 2000,
          maxOrderPctOfNav: 100,
          maxDailyNotional: 5000,
          maxSymbolExposurePct: 50,
          tuning: { crisisMaxOpeningExposurePct: 5 }
        },
        accountCapabilities: shortCapableAccount,
        positions: [
          ...positions,
          { symbol: "TSLA", quantity: -2, averageCost: 1000, marketValue: -2000, sector: "Consumer Cyclical" }
        ]
      }
    );
    expect(sell.approved).toBe(true);
    expect(cover.approved).toBe(true);
  });

  it("blocks when system state is halted", () => {
    const decision = evaluateTradeProposal(proposal, {
      ...context(),
      policy: { ...enabledPolicy, systemState: "halted" }
    });
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("halted");
  });

  it("rejects short proposals", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, side: "short" },
      context()
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain('Order side "short" rejected');
  });

  it("allows risk-reducing cover proposals even when opening shorting is disabled", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 1, dollarAmount: undefined },
      {
        ...context(),
        policy: { ...enabledPolicy, shortSellingEnabled: false, additionalSymbols: ["AAPL", "TSLA"] },
        positions: [...positions, { symbol: "TSLA", quantity: -2, averageCost: 100, marketValue: -200, sector: "Auto" }]
      }
    );
    expect(decision.approved).toBe(true);
  });

  // T1 — maxSymbolExposureNotional must be side-aware (regression for the side-blind cap
  // that could block automated de-risking exits).
  it("maxSymbolExposureNotional blocks an opening buy that pushes symbol notional over the cap", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "buy", dollarAmount: 500 },
      { ...context(500), policy: { ...enabledPolicy, maxSymbolExposureNotional: 1200 } }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("notional exposure");
  });

  it("maxSymbolExposureNotional does NOT block a risk-reducing sell", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 2, dollarAmount: undefined, type: "market" },
      { ...context(500), policy: { ...enabledPolicy, maxSymbolExposureNotional: 800 } }
    );
    expect(decision.reasons.join(" ")).not.toContain("notional exposure");
  });

  it("maxSymbolExposureNotional does NOT block a full-position exit sell", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 5, dollarAmount: undefined, type: "market" },
      { ...context(1000), policy: { ...enabledPolicy, maxSymbolExposureNotional: 800 } }
    );
    expect(decision.reasons.join(" ")).not.toContain("notional exposure");
  });

  it("maxSymbolExposureNotional does NOT block a quantity-only market sell when estimatedNotional is zero", () => {
    // Regression for: a market sell with quantity-only (no price, no dollarAmount) produces
    // estimatedNotional=0. The old code computed projectedNotional = max(0, existingValue - 0)
    // = existingValue, which blocked the sell when existingValue > cap. Closing orders are now
    // unconditionally allowed.
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 5, dollarAmount: undefined, type: "market" },
      { ...context(0), policy: { ...enabledPolicy, maxSymbolExposureNotional: 800 } }
    );
    expect(decision.reasons.join(" ")).not.toContain("notional exposure");
  });

  // T7 — enabled-path short/cover guardrails.
  it("short without a mandatory stop-loss is rejected when short selling is enabled", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "MSFT", side: "short", dollarAmount: 1000 },
      { ...context(1000), policy: { ...enabledPolicy, shortSellingEnabled: true, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 0 } }, accountCapabilities: shortCapableAccount }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("mandatory stop-loss");
  });

  it("an explicit stopPlan: 'none' short satisfies the mandatory-stop-loss gate (owner decision, 2026-07-15 — a deliberate no-stop choice is okay)", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "MSFT", side: "short", dollarAmount: 1000, stopPlan: { style: "none", rationale: "deliberately unhedged short thesis" } },
      { ...context(1000), policy: { ...enabledPolicy, shortSellingEnabled: true, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 0 } }, accountCapabilities: shortCapableAccount }
    );
    expect(decision.reasons.join(" ")).not.toContain("mandatory stop-loss");
  });

  it("an explicit stopPlan: 'default' short does NOT satisfy the mandatory-stop-loss gate (defers to the account's own precedence, which here guarantees nothing)", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "MSFT", side: "short", dollarAmount: 1000, stopPlan: { style: "default" } },
      { ...context(1000), policy: { ...enabledPolicy, shortSellingEnabled: true, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 0 } }, accountCapabilities: shortCapableAccount }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("mandatory stop-loss");
  });

  it("short over maxShortOrderNotional is rejected", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "MSFT", side: "short", dollarAmount: 5000 },
      { ...context(5000), policy: { ...enabledPolicy, shortSellingEnabled: true, maxShortOrderNotional: 1000, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 10 } }, accountCapabilities: shortCapableAccount }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("max short order limit");
  });

  it("opening short over maxShortExposurePct is rejected", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "MSFT", side: "short", dollarAmount: 6000 },
      { ...context(6000), policy: { ...enabledPolicy, shortSellingEnabled: true, maxShortExposurePct: 50, riskRules: { ...enabledPolicy.riskRules, shortStopLossPct: 10 } }, accountCapabilities: shortCapableAccount }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("short exposure");
  });

  it("cover exceeding the held short is rejected", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 3, dollarAmount: undefined, type: "market" },
      {
        ...context(100),
        policy: { ...enabledPolicy, shortSellingEnabled: true, additionalSymbols: ["AAPL", "MSFT", "TSLA"] },
        accountCapabilities: shortCapableAccount,
        positions: [...positions, { symbol: "TSLA", quantity: -2, averageCost: 1000, marketValue: -2000, sector: "Consumer Cyclical" }]
      }
    );
    expect(decision.approved).toBe(false);
    expect(decision.reasons.join(" ")).toContain("exceeds current TSLA short");
  });

  it("a valid in-range cover is approved", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 1, dollarAmount: undefined, type: "market" },
      {
        ...context(1000),
        policy: { ...enabledPolicy, shortSellingEnabled: true, additionalSymbols: ["AAPL", "MSFT", "TSLA"] },
        accountCapabilities: shortCapableAccount,
        positions: [...positions, { symbol: "TSLA", quantity: -2, averageCost: 1000, marketValue: -2000, sector: "Consumer Cyclical" }]
      }
    );
    expect(decision.approved).toBe(true);
  });

  it("does not charge risk-reducing covers against the daily opening-order cap", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "TSLA", side: "cover", quantity: 1, dollarAmount: undefined, type: "market" },
      {
        ...context(1000),
        dailyOrderCount: enabledPolicy.maxDailyOrders,
        policy: { ...enabledPolicy, shortSellingEnabled: true, additionalSymbols: ["AAPL", "MSFT", "TSLA"] },
        accountCapabilities: shortCapableAccount,
        positions: [...positions, { symbol: "TSLA", quantity: -2, averageCost: 1000, marketValue: -2000, sector: "Consumer Cyclical" }]
      }
    );
    expect(decision.approved).toBe(true);
    expect(decision.reasons.join(" ")).not.toContain("Daily opening-order count");
  });

  // T10 — whole-portfolio gross/net exposure gates (previously silent no-ops).
  it("maxGrossExposurePct blocks an opening buy that pushes gross over the cap", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "buy", dollarAmount: 9500 },
      { ...context(9500), policy: { ...enabledPolicy, maxGrossExposurePct: 100 } }
    );
    // grossNow 1000 (AAPL) + 9500 = 10500 > 10000 cap → blocked.
    expect(decision.reasons.join(" ")).toContain("gross exposure");
  });

  it("maxNetExposurePct blocks an opening buy that pushes net over the cap", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "buy", dollarAmount: 9500 },
      { ...context(9500), policy: { ...enabledPolicy, maxNetExposurePct: 100 } }
    );
    expect(decision.reasons.join(" ")).toContain("net exposure");
  });

  it("gross/net caps do NOT block a risk-reducing sell even when already over the cap", () => {
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 5, dollarAmount: undefined, type: "market" },
      { ...context(1000), policy: { ...enabledPolicy, maxGrossExposurePct: 5, maxNetExposurePct: 5 } }
    );
    expect(decision.reasons.join(" ")).not.toContain("gross exposure");
    expect(decision.reasons.join(" ")).not.toContain("net exposure");
  });

  it("net cap does NOT block a risk-exit sell whose notional is the 'price unavailable' sentinel", () => {
    // Regression: a risk-exit SELL with no live quote carried estimatedNotional = MAX_SAFE_INTEGER
    // (the over-cap sentinel). netDelta = -MAX overshot net through zero to ~-9e15, so
    // |netProjected| > cap AND > |netNow| → the risk-reducing exit was BLOCKED with
    // "Projected net exposure $-9,007,199,254,740,800 exceeds net cap". Closes are now exempt.
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 1, dollarAmount: undefined, type: "market" },
      { ...context(Number.MAX_SAFE_INTEGER), policy: { ...enabledPolicy, maxNetExposurePct: 100, maxGrossExposurePct: 100 } }
    );
    expect(decision.reasons.join(" ")).not.toContain("net exposure");
    expect(decision.reasons.join(" ")).not.toContain("gross exposure");
    expect(decision.approved).toBe(true);
  });

  it("per-symbol % cap does NOT block a SELL of an already-over-cap position (the risk-exit trigger)", () => {
    // maxSymbolExposurePct is ON by default (25%). An over-cap position is precisely what triggers a
    // risk-exit (strategy prompts "SELL/TRIM any position exceeding maxSymbolExposurePct%"), so the cap
    // must never block the exit it demanded. Covers BOTH the un-priced exit (estimatedNotional 0, the
    // alpaca fix's fallback) AND a normally-priced partial exit (a pre-existing latent block the
    // MAX_SAFE_INTEGER sentinel used to mask).
    const overCapPositions: EquityPosition[] = [
      { symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 4000, sector: "Technology" } // 40% of $10k
    ];
    for (const est of [0, 1000]) {
      const decision = evaluateTradeProposal(
        { ...proposal, symbol: "AAPL", side: "sell", quantity: 5, dollarAmount: undefined, type: "market" },
        { policy: { ...enabledPolicy, maxSymbolExposurePct: 25 }, portfolio, positions: overCapPositions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: est }
      );
      expect(decision.reasons.join(" ")).not.toContain("exposure");
      expect(decision.approved).toBe(true);
    }
  });

  it("sector % cap does NOT block a SELL of a name in an already-over-cap sector", () => {
    const techPositions: EquityPosition[] = [
      { symbol: "AAPL", quantity: 5, averageCost: 200, marketValue: 4000, sector: "Technology" } // 40% tech in $10k book
    ];
    const decision = evaluateTradeProposal(
      { ...proposal, symbol: "AAPL", side: "sell", quantity: 5, dollarAmount: undefined, type: "market" },
      { policy: { ...enabledPolicy, sectorCaps: { Technology: 25 } }, portfolio, positions: techPositions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 0 }
    );
    expect(decision.reasons.join(" ")).not.toContain("sector exposure");
    expect(decision.approved).toBe(true);
  });

  it("default 100% gross/net caps do not block a small in-policy order", () => {
    const decision = evaluateTradeProposal(proposal, {
      policy: enabledPolicy,
      portfolio,
      positions,
      dailyNotionalUsed: 0,
      dailyOrderCount: 0,
      estimatedNotional: 10
    });
    expect(decision.approved).toBe(true);
  });

  describe("bracket-order permission (Codex review, PR #1371)", () => {
    // A bare account: no "bracket" in permittedOrderTypes, no stopLossPct configured — the two
    // pre-existing green-lights for a bracket order.
    const barePolicy: TradingPolicy = { ...enabledPolicy, riskRules: { ...enabledPolicy.riskRules, stopLossPct: 0 } };

    it("still blocks a bracket with no explicit stop plan on a bare account (unchanged baseline)", () => {
      const decision = evaluateTradeProposal(
        { ...proposal, bracketStopLoss: 9 },
        { policy: barePolicy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 10 }
      );
      expect(decision.approved).toBe(false);
      expect(decision.reasons.join(" ")).toContain("Bracket orders require");
    });

    it("permits a bracket on a bare account when the proposal carries an explicit 'fixed' stop plan (the plan guarantees the bracket via the universal-availability fallback)", () => {
      const decision = evaluateTradeProposal(
        { ...proposal, bracketStopLoss: 9, stopPlan: { style: "fixed" } },
        { policy: barePolicy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 10 }
      );
      expect(decision.reasons.join(" ")).not.toContain("Bracket orders require");
    });

    it("permits a bracket on a bare account when the proposal carries an explicit 'atr' stop plan", () => {
      const decision = evaluateTradeProposal(
        { ...proposal, bracketStopLoss: 9, stopPlan: { style: "atr" } },
        { policy: barePolicy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 10 }
      );
      expect(decision.reasons.join(" ")).not.toContain("Bracket orders require");
    });

    it("does NOT permit a bracket on a bare account for a 'trailing'/'none'/'default' plan (those never attach a bracket leg in the first place, so this shouldn't matter, but the permission gate itself must not misread them as a green light)", () => {
      const decision = evaluateTradeProposal(
        { ...proposal, bracketStopLoss: 9, stopPlan: { style: "trailing" } },
        { policy: barePolicy, portfolio, positions, dailyNotionalUsed: 0, dailyOrderCount: 0, estimatedNotional: 10 }
      );
      expect(decision.reasons.join(" ")).toContain("Bracket orders require");
    });
  });
});

function context(estimatedNotional = 10) {
  return {
    policy: enabledPolicy,
    portfolio,
    positions,
    dailyNotionalUsed: 0,
    dailyOrderCount: 0,
    estimatedNotional
  };
}
