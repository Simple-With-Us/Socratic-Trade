import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-staleness-gate-${randomUUID()}.db`)}`;
});

vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string) => new Map()),
}));

// import AFTER env + mock are set
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const NOW = new Date("2026-06-26T15:00:00.000Z");

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000,
};

const positions: EquityPosition[] = [];

const basePolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["TSLA"],
};

const buyProposal: TradeProposal = {
  symbol: "TSLA",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test",
};

const sellProposal: TradeProposal = { ...buyProposal, side: "sell" };

function scanWith(asOf: string | undefined, generatedAt: string): MarketScan {
  return {
    source: "test",
    generatedAt,
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [{ symbol: "TSLA", price: 10, volume: 100, intradayChangePct: 0, positionMarketValue: 0, score: 1, asOf } as any],
    sectorBySymbol: {},
    quotesBySymbol: { TSLA: { symbol: "TSLA", price: 10, score: 1, asOf } as any },
    warnings: [],
  } as MarketScan;
}

function ctx(policy: TradingPolicy, marketScan?: MarketScan) {
  return {
    policy,
    portfolio,
    positions,
    dailyNotionalUsed: 0,
    dailyOrderCount: 0,
    estimatedNotional: 10,
    washSaleLockedSymbols: new Set<string>(),
    marketScan,
    now: NOW,
  };
}

const FRESH_GENERATED_AT = new Date(NOW.getTime() - 5_000).toISOString(); // 5s ago

describe("staleness gate", () => {
  it("converts to limit order and warns on opening buy whose quote is older than maxQuoteAgeSec", () => {
    const staleAsOf = new Date(NOW.getTime() - 600_000).toISOString(); // 600s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("limit");
    expect(proposal.limitPrice).toBe(10);
    expect(result.quoteStale).toBeDefined();
    expect(result.quoteStale?.ageSec).toBe(600);
    expect(result.quoteStale?.referencePrice).toBe(10);
    expect(proposal.rationale).toContain("Stale quote backup");
    expect(proposal.rationale).toContain("not blocked");
    expect(result.escalations ?? []).toHaveLength(0);
  });

  it("honors the proposal's referencePrice as the limit anchor when the quote is stale", () => {
    const staleAsOf = new Date(NOW.getTime() - 600_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    // Scan last print is 10; strategy decided the name is worth $9.50 — honor $9.50, not chase 10.
    const proposal: TradeProposal = { ...buyProposal, referencePrice: 9.5, type: "market" };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("limit");
    expect(proposal.limitPrice).toBe(9.5);
    expect(result.quoteStale?.referencePrice).toBe(9.5);
    expect(result.reasons).toEqual([]);
  });

  it("allows an opening buy whose quote is fresh", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(freshAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
  });

  it("allows a quote exactly at the threshold (boundary, strictly-greater check)", () => {
    const exactAsOf = new Date(NOW.getTime() - 60_000).toISOString(); // exactly 60s ago
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(exactAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
  });

  it("does not warn or mutate when the gate is OFF even with very old data", () => {
    const veryStaleAsOf = new Date(NOW.getTime() - 86_400_000).toISOString(); // 1 day ago
    const veryStaleGeneratedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 0 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(veryStaleAsOf, veryStaleGeneratedAt)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
  });

  it("blocks an opening when the quote has no provider observation time", () => {
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(undefined, FRESH_GENERATED_AT)));

    expect(result.approved).toBe(false);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
    expect(result.reasons.some((reason) => reason.startsWith("quote_age_unknown:"))).toBe(true);
    expect(result.reasons.some((reason) => reason.toLowerCase().includes("broker"))).toBe(false);
  });

  it("does not warn or mutate on missing quote timestamp when the gate is OFF", () => {
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 0 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(undefined, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
  });

  it("blocks an opening when the quote observation time does not parse", () => {
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith("not-a-date", FRESH_GENERATED_AT)));

    expect(result.approved).toBe(false);
    expect(proposal.type).toBe("market");
    expect(result.quoteStale).toBeUndefined();
    expect(result.reasons.some((reason) => reason.startsWith("quote_age_unknown:"))).toBe(true);
  });

  it("does NOT block or escalate on stale fundamentals — annotate only (owner: never block on staleness)", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // quote is fresh
    const staleGeneratedAt = new Date(NOW.getTime() - 7_200_000).toISOString(); // 7200s ago
    const policy: TradingPolicy = { ...basePolicy, maxFundamentalsAgeSec: 3600 };
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(freshAsOf, staleGeneratedAt)));
    expect(result.approved).toBe(true);
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
    expect(result.escalations ?? []).toHaveLength(0);
    expect(proposal.rationale).toContain("Scan-age note");
    expect(proposal.rationale).toContain("not blocking");
  });

  it("never blocks a risk-reducing SELL even with very stale data and the gate ON", () => {
    const veryStaleAsOf = new Date(NOW.getTime() - 86_400_000).toISOString();
    const veryStaleGeneratedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60, maxFundamentalsAgeSec: 60 };
    const proposal = { ...sellProposal };
    const result = evaluateTradeProposal(proposal, ctx(policy, scanWith(veryStaleAsOf, veryStaleGeneratedAt)));
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
    expect(proposal.type).toBe("market"); // sell exits are never gated/mutated for quote staleness
  });
});

describe("staleness gate — DEFAULT 120s (guard enablement 2026-07-28)", () => {
  it("converts to limit order and warns on a 300s-old quote under the default 120s gate", () => {
    const staleAsOf = new Date(NOW.getTime() - 300_000).toISOString(); // 300s ago
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(basePolicy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("limit");
    expect(result.quoteStale).toBeDefined();
    expect(result.quoteStale?.ageSec).toBe(300);
  });

  it("allows an opening buy on a 10s-old quote under the default 120s gate", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString(); // 10s ago
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(basePolicy, scanWith(freshAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
  });

  it("allows a quote exactly at the 120s default boundary (strictly-greater check)", () => {
    const exactAsOf = new Date(NOW.getTime() - 120_000).toISOString(); // exactly 120s ago
    const proposal = { ...buyProposal };
    const result = evaluateTradeProposal(proposal, ctx(basePolicy, scanWith(exactAsOf, FRESH_GENERATED_AT)));
    expect(result.approved).toBe(true);
    expect(proposal.type).toBe("market");
  });

  it("never gates a risk-reducing SELL under the default 120s gate", () => {
    const staleAsOf = new Date(NOW.getTime() - 300_000).toISOString();
    const proposal = { ...sellProposal };
    const result = evaluateTradeProposal(proposal, ctx(basePolicy, scanWith(staleAsOf, FRESH_GENERATED_AT)));
    expect(result.reasons.every((r) => !r.includes("staleness_gate"))).toBe(true);
    expect(proposal.type).toBe("market");
  });
});
