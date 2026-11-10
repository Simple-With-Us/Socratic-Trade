import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { audit, getDb, insertProposal } from "../src/lib/db";
import { addToWatchlist } from "../src/lib/watchlist";
import { buildWatchlistReportContext } from "../src/lib/report-context";
import { WATCHLIST_DIGEST_TRAJECTORY_LIMIT } from "../src/lib/report-context";
import type { MarketScan } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-report-context-${randomUUID()}.db`)}`;
  getDb();
});

function newUser(): string {
  return `u-${randomUUID()}`;
}

function baseProposal(symbol: string, overrides: Record<string, unknown> = {}) {
  return {
    symbol,
    side: "buy",
    type: "market",
    timeInForce: "day",
    marketHours: "regular",
    rationale: "test rationale",
    tradeThesisTag: "momentum_breakout",
    entryMarketRegime: "risk_on",
    confidenceScore: 0.7,
    referencePrice: 100,
    ...overrides
  };
}

function insertProposalAt(input: {
  id: string;
  userId: string;
  symbol: string;
  createdAt: string;
  status?: string;
  overrides?: Record<string, unknown>;
}): void {
  insertProposal({
    id: input.id,
    runId: `run-${input.id}`,
    accountNumber: "acct-1",
    proposal: baseProposal(input.symbol, input.overrides),
    decision: { approved: true, reasons: [] },
    status: input.status ?? "proposed",
    userId: input.userId
  });
  // insertProposal always stamps created_at = now(); backdate deterministically so
  // "newest first" ordering doesn't depend on real-clock spacing between inserts.
  getDb().prepare("UPDATE trade_proposals SET created_at = ? WHERE id = ?").run(input.createdAt, input.id);
}

describe("buildWatchlistReportContext", () => {
  it("includes a watchlisted symbol with empty fields when it has no scan or proposal data", () => {
    const userId = newUser();
    addToWatchlist(userId, "ZZZZ");

    const ctx = buildWatchlistReportContext(userId);

    expect(ctx.userId).toBe(userId);
    expect(ctx.marketScanAsOf).toBeUndefined();
    expect(ctx.symbols).toHaveLength(1);
    expect(ctx.symbols[0]!.symbol).toBe("ZZZZ");
    expect(ctx.symbols[0]!.quote).toBeUndefined();
    expect(ctx.symbols[0]!.latestProposal).toBeUndefined();
    expect(ctx.symbols[0]!.trajectory).toEqual([]);
  });

  it("attaches the latest persisted market_scan quote for a watchlisted symbol, never calling a provider", () => {
    const userId = newUser();
    addToWatchlist(userId, "AAPL");
    const scan: MarketScan = {
      source: "test-provider",
      generatedAt: new Date().toISOString(),
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: { symbol: "AAPL", price: 230.12, score: 1, intradayChangePct: 1.5 } },
      warnings: []
    };
    audit("market_scan", { scan }, userId);

    const ctx = buildWatchlistReportContext(userId);

    expect(ctx.marketScanAsOf).toBeDefined();
    expect(ctx.symbols[0]!.quote?.price).toBe(230.12);
    expect(ctx.symbols[0]!.quote?.intradayChangePct).toBe(1.5);
  });

  it("leaves quote undefined for a watchlisted symbol absent from the latest scan's quotesBySymbol", () => {
    const userId = newUser();
    addToWatchlist(userId, "GHOST");
    const scan: MarketScan = {
      source: "test-provider",
      generatedAt: new Date().toISOString(),
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [],
      sectorBySymbol: {},
      quotesBySymbol: { AAPL: { symbol: "AAPL", price: 230.12, score: 1 } },
      warnings: []
    };
    audit("market_scan", { scan }, userId);

    const ctx = buildWatchlistReportContext(userId);

    expect(ctx.symbols[0]!.symbol).toBe("GHOST");
    expect(ctx.symbols[0]!.quote).toBeUndefined();
  });

  it("caps the trajectory at WATCHLIST_DIGEST_TRAJECTORY_LIMIT, newest first, with latestProposal === trajectory[0]", () => {
    const userId = newUser();
    addToWatchlist(userId, "MSFT");
    const total = WATCHLIST_DIGEST_TRAJECTORY_LIMIT + 2;
    const base = Date.now() - total * 60_000;
    for (let i = 0; i < total; i++) {
      insertProposalAt({
        id: `p-${i}-${randomUUID()}`,
        userId,
        symbol: "MSFT",
        createdAt: new Date(base + i * 60_000).toISOString(), // strictly increasing
        overrides: { confidenceScore: 0.5 + i * 0.01 }
      });
    }

    const ctx = buildWatchlistReportContext(userId);
    const msft = ctx.symbols.find((s) => s.symbol === "MSFT")!;

    expect(msft.trajectory).toHaveLength(WATCHLIST_DIGEST_TRAJECTORY_LIMIT);
    expect(msft.latestProposal).toEqual(msft.trajectory[0]);
    // Newest first: the LAST inserted row (i = total-1, highest confidence) is trajectory[0].
    expect(msft.trajectory[0]!.confidenceScore).toBeCloseTo(0.5 + (total - 1) * 0.01, 5);
    // Strictly descending createdAt across the returned page.
    const times = msft.trajectory.map((r) => Date.parse(r.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("does not pad a symbol with fewer than the trajectory limit's worth of proposals", () => {
    const userId = newUser();
    addToWatchlist(userId, "THIN");
    insertProposalAt({ id: `p-thin-${randomUUID()}`, userId, symbol: "THIN", createdAt: new Date().toISOString() });

    const ctx = buildWatchlistReportContext(userId);
    const thin = ctx.symbols.find((s) => s.symbol === "THIN")!;

    expect(thin.trajectory).toHaveLength(1);
  });

  it("never leaks another user's proposals or watchlist into this user's context", () => {
    const userA = newUser();
    const userB = newUser();
    addToWatchlist(userA, "SHARED");
    addToWatchlist(userB, "SHARED");
    insertProposalAt({ id: `p-a-${randomUUID()}`, userId: userA, symbol: "SHARED", createdAt: new Date().toISOString() });

    const ctxB = buildWatchlistReportContext(userB);
    const sharedB = ctxB.symbols.find((s) => s.symbol === "SHARED")!;

    expect(sharedB.trajectory).toEqual([]);
    expect(sharedB.latestProposal).toBeUndefined();
  });

  it("carries the raw proposal status through as `decision` and the side unchanged", () => {
    const userId = newUser();
    addToWatchlist(userId, "TSLA");
    insertProposalAt({
      id: `p-tsla-${randomUUID()}`,
      userId,
      symbol: "TSLA",
      createdAt: new Date().toISOString(),
      status: "blocked",
      overrides: { side: "short" }
    });

    const ctx = buildWatchlistReportContext(userId);
    const tsla = ctx.symbols.find((s) => s.symbol === "TSLA")!;

    expect(tsla.latestProposal?.decision).toBe("blocked");
    expect(tsla.latestProposal?.side).toBe("short");
  });
});
