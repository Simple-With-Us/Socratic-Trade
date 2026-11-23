// ST-4641 (audit F1): the market_scan audit row carries a BOUNDED summary, the full
// whole-universe tape lives in the durable `market_scan_latest` row (one per user+scope),
// and the `/api/scan` HTTP response only ships quotes for candidates + held.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-market-scan-latest-${randomUUID()}.db`)}`;

import { audit, getDb, latestAuditByKind } from "../src/lib/db";
import { summarizeMarketScanForAudit } from "../src/lib/audit-bounded-run";
import { capMarketScanQuotesForResponse } from "../src/lib/dashboard-snapshot-projection";
import { getLatestMarketScanRow, upsertLatestMarketScan } from "../src/lib/db-market-scan";
import { latestPersistedMarketScan, persistLatestMarketScan } from "../src/lib/market-scan-latest";
import { newestPersistedMarketScan } from "../src/lib/market-scan-freshness";
import { marketScanQuotesFromScan } from "../src/lib/scan-singleflight";
import type { MarketScan } from "../src/lib/types";

function makeScan(generatedAt: string, symbols: string[] = ["AAPL", "MSFT", "NVDA"]): MarketScan {
  const quotesBySymbol: Record<string, { symbol: string; price: number; score: number }> = {};
  for (const symbol of symbols) {
    quotesBySymbol[symbol] = { symbol, price: 100, score: 1 };
  }
  return {
    source: "test",
    generatedAt,
    scannedSymbols: symbols.length,
    returnedQuotes: symbols.length,
    topCandidates: symbols.slice(0, 2).map((symbol) => ({ symbol, price: 100, score: 1 })),
    sectorBySymbol: {},
    quotesBySymbol,
    warnings: []
  } as unknown as MarketScan;
}

beforeEach(() => {
  getDb().prepare("DELETE FROM audit_events").run();
  getDb().prepare("DELETE FROM market_scan_latest").run();
});

describe("market_scan audit bounding + market_scan_latest tape (ST-4641 / audit F1)", () => {
  it("stores a BOUNDED summary in the audit row, not the whole tape", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z", ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"]);
    const auditId = audit("market_scan", { scan: summarizeMarketScanForAudit(scan) }, "local");
    persistLatestMarketScan({ userId: "local", auditId, scan });

    const row = latestAuditByKind("market_scan", "local");
    const payload = row!.payload as { scan: { omitted?: boolean; quotesBySymbol?: unknown; topSymbols?: string[] } };
    expect(payload.scan.omitted).toBe(true);
    expect(payload.scan.quotesBySymbol).toBeUndefined();
    expect(payload.scan.topSymbols).toEqual(["AAPL", "MSFT"]);
    // The audit row is now a few hundred bytes, not the multi-MB tape.
    const raw = getDb()
      .prepare("SELECT payload FROM audit_events WHERE id = ?")
      .get(auditId) as { payload: string };
    expect(raw.payload.length).toBeLessThan(1000);
  });

  it("keeps ONE tape row per (user, scope) and upserts on every scan", () => {
    const first = makeScan("2026-11-23T10:00:00.000Z");
    upsertLatestMarketScan({ userId: "local", connectedAccountId: "acct-1", scan: first });
    const second = makeScan("2026-11-23T11:00:00.000Z");
    upsertLatestMarketScan({ userId: "local", connectedAccountId: "acct-1", scan: second });

    const rows = getDb().prepare("SELECT COUNT(*) AS cnt FROM market_scan_latest").get() as { cnt: number };
    expect(rows.cnt).toBe(1);
    const row = getLatestMarketScanRow("local", "acct-1");
    expect(row?.scan.generatedAt).toBe("2026-11-23T11:00:00.000Z");
  });

  it("reads the tape back as the newest persisted market scan", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z");
    const auditId = audit("market_scan", { scan: summarizeMarketScanForAudit(scan) }, "local");
    persistLatestMarketScan({ userId: "local", auditId, scan });

    const newest = newestPersistedMarketScan("local");
    expect(newest?.scan.generatedAt).toBe("2026-11-23T10:00:00.000Z");
    // The entry id is the audit row id, so the freshness lane's fast gate still matches.
    expect(newest?.entry.id).toBe(auditId);
    expect(newest?.entry.kind).toBe("market_scan");
  });

  it("scopes the tape: the account row wins, and the newest row at any scope is the fallback", () => {
    const accountScan = makeScan("2026-11-23T11:00:00.000Z");
    upsertLatestMarketScan({
      userId: "local",
      connectedAccountId: "acct-1",
      scan: accountScan,
      persistedAt: "2026-11-23T12:00:00.000Z"
    });
    const globalScan = makeScan("2026-11-23T10:00:00.000Z");
    upsertLatestMarketScan({
      userId: "local",
      scan: globalScan,
      persistedAt: "2026-11-23T12:05:00.000Z"
    });

    // The account-scoped row is preferred for an account-scoped read.
    expect(getLatestMarketScanRow("local", "acct-1")?.scan.generatedAt).toBe("2026-11-23T11:00:00.000Z");
    // A user-wide read falls back to the newest row at ANY scope (mirrors the old
    // `latestAuditByKind(kind, userId)` lookup, which had no account filter).
    expect(getLatestMarketScanRow("local")?.scan.generatedAt).toBe("2026-11-23T10:00:00.000Z");
  });

  it("backfills a legacy full-payload audit row into the table exactly once", () => {
    const legacy = makeScan("2026-11-23T08:00:00.000Z");
    audit("market_scan", { scan: legacy }, "legacy-user");

    // No tape row yet — the reader falls back to the legacy audit payload and backfills it.
    const found = latestPersistedMarketScan("legacy-user");
    expect(found?.scan.generatedAt).toBe("2026-11-23T08:00:00.000Z");
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS cnt FROM market_scan_latest WHERE user_id = 'legacy-user'")
      .get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it("never treats a bounded audit summary as a usable tape", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z");
    audit("market_scan", { scan: summarizeMarketScanForAudit(scan) }, "bounded-user");
    expect(newestPersistedMarketScan("bounded-user")).toBeUndefined();
  });

  it("seeds a scan from the tape's quote map", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z");
    upsertLatestMarketScan({ userId: "local", scan });
    const row = getLatestMarketScanRow("local");
    const quotes = marketScanQuotesFromScan(row?.scan, row?.persistedAt, Date.parse("2026-11-23T12:00:00.000Z"));
    expect(Object.keys(quotes ?? {}).sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});

describe("/api/scan response cap (ST-4641 / audit F1 response side)", () => {
  it("ships only candidate + held quotes", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z", ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"]);
    const capped = capMarketScanQuotesForResponse(scan, ["TSLA"]);
    // Candidates (AAPL, MSFT) plus the held position (TSLA).
    expect(Object.keys(capped.quotesBySymbol).sort()).toEqual(["AAPL", "MSFT", "TSLA"]);
    // The full tape is untouched on the scan itself.
    expect(Object.keys(scan.quotesBySymbol)).toHaveLength(5);
  });

  it("returns an empty map when there are no candidates or held positions", () => {
    const scan = makeScan("2026-11-23T10:00:00.000Z", ["AAPL"]);
    scan.topCandidates = [];
    const capped = capMarketScanQuotesForResponse(scan);
    expect(capped.quotesBySymbol).toEqual({});
  });
});
