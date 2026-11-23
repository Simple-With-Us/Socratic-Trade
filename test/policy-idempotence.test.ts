import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-idem-${randomUUID()}.db`)}`;
});

vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string) => new Map()),
}));

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

const FRESH_GENERATED_AT = new Date(NOW.getTime() - 5_000).toISOString();

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("evaluateTradeProposal idempotence (ST-4654 duplicate-note guard)", () => {
  it("approved stale-quote conversion: second evaluation of the SAME object does not duplicate the backup note or re-pin differently", () => {
    const staleAsOf = new Date(NOW.getTime() - 600_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60 };
    const proposal: TradeProposal = { ...buyProposal, referencePrice: 9.5 };
    const context = ctx(policy, scanWith(staleAsOf, FRESH_GENERATED_AT));

    const first = evaluateTradeProposal(proposal, context);
    const afterFirst = structuredClone(proposal);
    const second = evaluateTradeProposal(proposal, context);

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    expect(proposal).toEqual(afterFirst);
    expect(proposal.type).toBe("limit");
    expect(proposal.limitPrice).toBe(9.5);
    expect(countOccurrences(proposal.rationale, "[Stale quote backup:")).toBe(1);
    expect(second.reasons).toEqual(first.reasons);
    expect(second.approved).toBe(first.approved);
  });

  it("approved scan-age note: proposal and decision are deep-equal across two evaluations of the same object", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString();
    const staleGeneratedAt = new Date(NOW.getTime() - 7_200_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxFundamentalsAgeSec: 3600 };
    const proposal: TradeProposal = { ...buyProposal };
    const context = ctx(policy, scanWith(freshAsOf, staleGeneratedAt));

    const first = evaluateTradeProposal(proposal, context);
    const afterFirst = structuredClone(proposal);
    const second = evaluateTradeProposal(proposal, context);

    expect(first.approved).toBe(true);
    expect(proposal).toEqual(afterFirst);
    expect(second).toEqual(first);
    expect(countOccurrences(proposal.rationale, "[Scan-age note:")).toBe(1);
  });

  it("blocked case carrying a scan-age note: proposal and decision are deep-equal across two evaluations", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString();
    const staleGeneratedAt = new Date(NOW.getTime() - 7_200_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, systemState: "halted", maxFundamentalsAgeSec: 3600 };
    const proposal: TradeProposal = { ...buyProposal };
    const context = ctx(policy, scanWith(freshAsOf, staleGeneratedAt));

    const first = evaluateTradeProposal(proposal, context);
    const afterFirst = structuredClone(proposal);
    const second = evaluateTradeProposal(proposal, context);

    expect(first.approved).toBe(false);
    expect(first.reasons).toContain("System is halted.");
    expect(proposal).toEqual(afterFirst);
    expect(second).toEqual(first);
    expect(countOccurrences(proposal.rationale, "[Scan-age note:")).toBe(1);
  });

  it("approved SHORT stale-quote conversion pins the limit idempotently (never below the decided entry)", () => {
    const staleAsOf = new Date(NOW.getTime() - 600_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxQuoteAgeSec: 60, shortSellingEnabled: true };
    const proposal: TradeProposal = { ...buyProposal, side: "short", referencePrice: 9.5 };
    const context = { ...ctx(policy, scanWith(staleAsOf, FRESH_GENERATED_AT)), accountCapabilities: { shortSelling: true } as any };

    const first = evaluateTradeProposal(proposal, context);
    const afterFirst = structuredClone(proposal);
    const second = evaluateTradeProposal(proposal, context);

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(true);
    expect(proposal).toEqual(afterFirst);
    expect(proposal.type).toBe("limit");
    expect(proposal.limitPrice).toBe(9.5);
    expect(countOccurrences(proposal.rationale, "[Stale quote backup:")).toBe(1);
    expect(second.reasons).toEqual(first.reasons);
  });

  it("missing scan timestamp note is also appended at most once", () => {
    const freshAsOf = new Date(NOW.getTime() - 10_000).toISOString();
    const policy: TradingPolicy = { ...basePolicy, maxFundamentalsAgeSec: 3600 };
    const proposal: TradeProposal = { ...buyProposal };
    const scan = scanWith(freshAsOf, FRESH_GENERATED_AT);
    (scan as any).generatedAt = undefined;
    const context = ctx(policy, scan);

    evaluateTradeProposal(proposal, context);
    const afterFirst = structuredClone(proposal);
    evaluateTradeProposal(proposal, context);

    expect(proposal).toEqual(afterFirst);
    expect(countOccurrences(proposal.rationale, "[Scan-age note:")).toBe(1);
  });
});
