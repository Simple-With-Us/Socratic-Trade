import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-delayed-fallback-${randomUUID()}.db`)}`;
});

vi.mock("../src/lib/tax", () => ({
  getUserWashSaleLockedSymbols: vi.fn((_userId: string) => new Set<string>()),
  getUserWashSaleLockProvenance: vi.fn((_userId: string) => new Map())
}));

import { DEFAULT_POLICY } from "../src/lib/defaults";
import { evaluateTradeProposal } from "../src/lib/policy";
import {
  DELAYED_FALLBACK_STAMP,
  delayedFallbackCardLabel,
  delayedFallbackCardTitle,
  isDelayedYahooFallbackQuote,
  isYahooFallbackProvider
} from "../src/lib/quote-delayed-fallback";
import { delayedFallbackStampLabel, pendingShowsDelayedFallback } from "../src/lib/proposal-price-review";
import { quoteAgeSecForStalenessGate } from "../src/lib/quotes-cascade";
import type { EquityPosition, MarketScan, Portfolio, TradeProposal, TradingPolicy } from "../src/lib/types";

const NOW = new Date("2026-08-18T15:00:00.000Z");

const portfolio: Portfolio = {
  accountNumber: "A1",
  totalMarketValue: 10000,
  buyingPower: 5000,
  equityMarketValue: 5000,
  optionMarketValue: 0,
  cash: 5000
};

const positions: EquityPosition[] = [];

const basePolicy: TradingPolicy = {
  ...DEFAULT_POLICY,
  systemState: "active",
  strategyAuthority: "decide",
  accountNumber: "A1",
  includedIndices: [],
  additionalSymbols: ["XOM"]
};

const buyProposal = (): TradeProposal => ({
  symbol: "XOM",
  side: "buy",
  type: "market",
  dollarAmount: 10,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "test",
  tradeThesisTag: "test",
  entryMarketRegime: "test"
});

function scanWith(quote: {
  asOf?: string;
  fetchedAt?: string;
  provider?: string;
  delayedFallback?: boolean;
  price?: number;
}): MarketScan {
  const row = {
    symbol: "XOM",
    price: quote.price ?? 110,
    volume: 100,
    score: 1,
    asOf: quote.asOf,
    fetchedAt: quote.fetchedAt,
    provider: quote.provider,
    delayedFallback: quote.delayedFallback
  };
  return {
    source: quote.provider ?? "test",
    generatedAt: quote.fetchedAt ?? NOW.toISOString(),
    scannedSymbols: 1,
    returnedQuotes: 1,
    topCandidates: [row as any],
    sectorBySymbol: {},
    quotesBySymbol: { XOM: row as any },
    warnings: []
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
    now: NOW
  };
}

describe("delayed Yahoo fallback detection", () => {
  it("names yahoo-finance-delayed and cascade Yahoo ids as fallback providers", () => {
    expect(isYahooFallbackProvider("yahoo-finance-delayed")).toBe(true);
    expect(isYahooFallbackProvider("yahoo-finance-batch")).toBe(true);
    expect(isYahooFallbackProvider("yahoo-finance-single")).toBe(true);
    expect(isYahooFallbackProvider("alpaca-snapshot")).toBe(false);
    expect(delayedFallbackCardLabel()).toBe("Delayed Quote");
    expect(delayedFallbackStampLabel()).toBe(DELAYED_FALLBACK_STAMP);
    expect(delayedFallbackCardTitle()).toBe("This price is delayed.  You can still approve the order.");
  });

  it("treats an explicit delayedFallback stamp or yahoo-finance-delayed as delayed fallback", () => {
    expect(isDelayedYahooFallbackQuote({ delayedFallback: true, provider: "yahoo-finance-batch" })).toBe(true);
    expect(isDelayedYahooFallbackQuote({ provider: "yahoo-finance-delayed" })).toBe(true);
    expect(isDelayedYahooFallbackQuote({ provider: "alpaca-snapshot", asOf: NOW.toISOString() })).toBe(false);
  });

  it("treats a Yahoo cascade print older than the live bar as delayed fallback", () => {
    const now = NOW.getTime();
    const delayedAsOf = new Date(now - 15 * 60 * 1000).toISOString();
    expect(isDelayedYahooFallbackQuote({ provider: "yahoo-finance-batch", asOf: delayedAsOf }, now, 120)).toBe(true);
    expect(
      isDelayedYahooFallbackQuote(
        { provider: "yahoo-finance-batch", asOf: new Date(now - 30_000).toISOString() },
        now,
        120
      )
    ).toBe(false);
  });

  it("never calls Tradier venue delay delayed fallback", () => {
    expect(
      isDelayedYahooFallbackQuote({
        provider: "tradier",
        venuePriceAuthoritative: true,
        delayedFallback: false,
        asOf: new Date(NOW.getTime() - 15 * 60 * 1000).toISOString()
      })
    ).toBe(false);
  });
});

describe("delayed Yahoo fallback — KEEP TRADING (owner 2026-08-18)", () => {
  it("does not fail-closed an opening when the tape is delayed Yahoo with a fresh fetch", () => {
    const delayedPrint = new Date(NOW.getTime() - 18 * 60 * 1000).toISOString();
    const fetchedNow = new Date(NOW.getTime() - 5_000).toISOString();
    const proposal = buyProposal();
    const result = evaluateTradeProposal(
      proposal,
      ctx(
        { ...basePolicy, maxQuoteAgeSec: 120 },
        scanWith({
          asOf: delayedPrint,
          fetchedAt: fetchedNow,
          provider: "yahoo-finance-single",
          delayedFallback: true
        })
      )
    );
    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.escalations ?? []).toHaveLength(0);
    expect(proposal.type).toBe("market");
    expect(proposal.quoteDelayedFallback).toBe(true);
    expect(proposal.quoteProvider).toBe("yahoo-finance-single");
    expect(proposal.rationale).not.toMatch(/Yahoo delayed tape|delayed fallback|Infisical/i);
    expect(result.quoteStale).toBeUndefined();
  });

  it("ages delayed Yahoo by fetchedAt so a 15m print does not convert the opening to a limit", () => {
    const now = NOW.getTime();
    const r = quoteAgeSecForStalenessGate(
      {
        asOf: new Date(now - 18 * 60 * 1000).toISOString(),
        fetchedAt: new Date(now - 8_000).toISOString(),
        delayedFallback: true,
        provider: "yahoo-finance-delayed"
      },
      now
    );
    expect(r.delayedFallback).toBe(true);
    expect(r.missing).toBe(false);
    expect(r.ageSec).toBe(8);
  });

  it("still does not block when a delayed Yahoo fetch snapshot is itself stale — limit backup only", () => {
    const staleFetch = new Date(NOW.getTime() - 600_000).toISOString();
    const delayedPrint = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
    const proposal = buyProposal();
    const result = evaluateTradeProposal(
      proposal,
      ctx(
        { ...basePolicy, maxQuoteAgeSec: 120 },
        scanWith({
          asOf: delayedPrint,
          fetchedAt: staleFetch,
          provider: "yahoo-finance-delayed",
          delayedFallback: true
        })
      )
    );
    expect(result.approved).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(proposal.type).toBe("limit");
    expect(proposal.quoteDelayedFallback).toBe(true);
    expect(proposal.rationale).toContain("delayed quote");
    expect(proposal.rationale).toContain("not blocked");
  });
});

describe("approval-card delayed fallback stamp", () => {
  it("shows the stamp when the dashboard flagged the Now price", () => {
    expect(pendingShowsDelayedFallback({ delayedFallback: true })).toBe(true);
    expect(pendingShowsDelayedFallback({ proposal: { quoteDelayedFallback: true } })).toBe(true);
    expect(pendingShowsDelayedFallback({ delayedFallback: false, proposal: {} })).toBe(false);
  });
});
