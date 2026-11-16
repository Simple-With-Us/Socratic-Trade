import { describe, expect, it } from "vitest";
import {
  ctDateKey,
  ctDateTime,
  renderWatchlistDigestBrief,
  renderWatchlistDigestFull,
  renderWatchlistDigestMedium,
  WATCHLIST_DIGEST_BRIEF_MAX_CHARS
} from "../src/lib/report-renderer";
import type { WatchlistReportContext, WatchlistSymbolReport } from "../src/lib/report-context";
import type { SymbolProposalTrajectoryRow } from "../src/lib/db-proposals";

function trajectoryRow(overrides: Partial<SymbolProposalTrajectoryRow> = {}): SymbolProposalTrajectoryRow {
  return {
    id: "p1",
    createdAt: "2026-08-10T20:00:00.000Z",
    decision: "placed",
    side: "buy",
    tradeThesisTag: "momentum_breakout",
    entryMarketRegime: "risk_on",
    confidenceScore: 0.72,
    referencePrice: 228,
    ...overrides
  };
}

function symbolReport(overrides: Partial<WatchlistSymbolReport> = {}): WatchlistSymbolReport {
  return {
    symbol: "AAPL",
    addedAt: "2026-01-01T00:00:00.000Z",
    quote: { symbol: "AAPL", price: 230.12, score: 1, intradayChangePct: 1.5 },
    latestProposal: trajectoryRow(),
    trajectory: [trajectoryRow()],
    ...overrides
  };
}

function context(symbols: WatchlistSymbolReport[], overrides: Partial<WatchlistReportContext> = {}): WatchlistReportContext {
  return {
    userId: "local",
    generatedAt: "2026-08-11T20:20:00.000Z",
    marketScanAsOf: "2026-08-11T20:15:00.000Z",
    symbols,
    ...overrides
  };
}

describe("ctDateKey / ctDateTime", () => {
  it("renders the Central-Time calendar day, not the UTC one, near a day boundary", () => {
    // 2026-01-15T05:30:00Z is 2026-01-14 23:30 Central (CST, UTC-6) — a different calendar day.
    expect(ctDateKey("2026-01-15T05:30:00.000Z")).toBe("2026-01-14");
  });

  it("is DST-safe across a summer instant (CDT, UTC-5)", () => {
    // 2026-07-15T04:30:00Z is 2026-07-14 23:30 Central (CDT, UTC-5).
    expect(ctDateKey("2026-07-15T04:30:00.000Z")).toBe("2026-07-14");
  });

  it("falls back to '-' rather than throwing on an unparseable timestamp", () => {
    expect(ctDateKey("not-a-date")).toBe("-");
    expect(ctDateKey(undefined)).toBe("-");
    expect(ctDateTime(undefined)).toBe("no data yet");
  });

  it("ctDateTime always labels the zone CT", () => {
    expect(ctDateTime("2026-08-11T20:15:00.000Z")).toMatch(/CT$/);
  });
});

describe("renderWatchlistDigestFull", () => {
  it("includes every watchlisted symbol as its own section", () => {
    const out = renderWatchlistDigestFull(context([symbolReport({ symbol: "AAPL" }), symbolReport({ symbol: "MSFT" })]));
    expect(out).toContain("AAPL");
    expect(out).toContain("MSFT");
  });

  it("renders honest no-data text instead of a fabricated quote or proposal", () => {
    const out = renderWatchlistDigestFull(
      context([symbolReport({ symbol: "GHOST", quote: undefined, latestProposal: undefined, trajectory: [] })])
    );
    expect(out).toContain("No market scan data for this symbol yet.");
    expect(out).toContain("No proposal history for this symbol yet.");
    expect(out).toContain("No proposal history yet."); // the trajectory table itself
  });

  it("never pads the trajectory table beyond what actually exists", () => {
    const twoRows = [trajectoryRow({ id: "a" }), trajectoryRow({ id: "b", tradeThesisTag: "mean_reversion" })];
    const out = renderWatchlistDigestFull(context([symbolReport({ trajectory: twoRows, latestProposal: twoRows[0] })]));
    // Both real thesis tags appear...
    expect(out).toContain("momentum_breakout");
    expect(out).toContain("mean_reversion");
    // ...and no synthesized placeholder marker sneaks in.
    expect(out).not.toMatch(/n\/a\s+n\/a\s+n\/a/i);
  });

  it("says so honestly when the watchlist itself is empty", () => {
    const out = renderWatchlistDigestFull(context([]));
    expect(out).toContain("No symbols on your watchlist yet.");
  });

  it("stamps generated-at and market-scan-as-of in Central Time", () => {
    const out = renderWatchlistDigestFull(context([symbolReport()]));
    expect(out).toMatch(/Generated: .*CT\./);
    expect(out).toMatch(/Market scan as of: .*CT\./);
  });
});

describe("renderWatchlistDigestMedium", () => {
  it("orders symbols by |intradayChangePct| descending — top movers first", () => {
    const small = symbolReport({ symbol: "SMALL", quote: { symbol: "SMALL", price: 10, score: 1, intradayChangePct: 0.5 } });
    const big = symbolReport({ symbol: "BIG", quote: { symbol: "BIG", price: 20, score: 1, intradayChangePct: -8.2 } });
    const mid = symbolReport({ symbol: "MID", quote: { symbol: "MID", price: 30, score: 1, intradayChangePct: 3.1 } });
    const out = renderWatchlistDigestMedium(context([small, big, mid]));
    const order = ["BIG", "MID", "SMALL"].map((s) => out.indexOf(s));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  it("still includes symbols with no quote data, after every symbol that has one", () => {
    const withQuote = symbolReport({ symbol: "HASQ", quote: { symbol: "HASQ", price: 10, score: 1, intradayChangePct: 1 } });
    const noQuote = symbolReport({ symbol: "NOQ", quote: undefined, latestProposal: undefined, trajectory: [] });
    const out = renderWatchlistDigestMedium(context([noQuote, withQuote]));
    expect(out.indexOf("HASQ")).toBeLessThan(out.indexOf("NOQ"));
    expect(out).toContain("no scan data");
  });

  it("says so honestly when the watchlist itself is empty", () => {
    expect(renderWatchlistDigestMedium(context([]))).toContain("No symbols on your watchlist yet.");
  });
});

describe("renderWatchlistDigestBrief", () => {
  it("renders one line per symbol", () => {
    const out = renderWatchlistDigestBrief(context([symbolReport({ symbol: "AAPL" }), symbolReport({ symbol: "MSFT" })]));
    const lines = out.split("\n");
    expect(lines.some((l) => l.startsWith("AAPL"))).toBe(true);
    expect(lines.some((l) => l.startsWith("MSFT"))).toBe(true);
  });

  it("stays within the hard char cap even for a very large watchlist", () => {
    const many = Array.from({ length: 400 }, (_, i) => symbolReport({ symbol: `SYM${i}` }));
    const out = renderWatchlistDigestBrief(context(many));
    expect(out.length).toBeLessThanOrEqual(WATCHLIST_DIGEST_BRIEF_MAX_CHARS);
    expect(out).toMatch(/\+\d+ more symbols? not shown/);
  });

  it("fits comfortably under every notify.ts channel cap for a normal-sized watchlist", () => {
    const normal = Array.from({ length: 15 }, (_, i) => symbolReport({ symbol: `SYM${i}` }));
    const out = renderWatchlistDigestBrief(context(normal));
    expect(out.length).toBeLessThanOrEqual(1024); // smallest cap: pushover
  });

  it("says so honestly when the watchlist itself is empty", () => {
    expect(renderWatchlistDigestBrief(context([]))).toContain("no symbols on your watchlist yet");
  });
});
