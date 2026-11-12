import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanAfterLiveRecovery } from "../app/console/scan/use-live-scan";
import { resetDbForTesting } from "../src/lib/db";
import { clearMarketCache, scanMarket } from "../src/lib/market";
import { resetProviderRateLimiterState } from "../src/lib/provider-rate-limit";
import {
  awaitScanRecovery,
  formatScanPriceAge,
  resetScanRecoveriesForTests,
  scanSnapshotPriceLabel
} from "../src/lib/scan-seed-preview";
import type { MarketQuoteSummary, MarketScan } from "../src/lib/types";

const pricesAsOf = "2026-11-11T20:14:00.000Z";
const now = Date.parse("2026-11-11T20:37:00.000Z");
const age = "Prices as of 2:14 PM, 23 min old";

function seedQuote(asOf: string): MarketQuoteSummary {
  return {
    symbol: "AAPL",
    companyName: "Apple",
    price: 91,
    score: 44,
    sector: "Technology",
    intradayChangePct: 0.4,
    provider: "persisted-strategy-scan",
    asOf
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function yahooQuoteResponse() {
  return new Response(
    JSON.stringify({
      quoteResponse: {
        result: [
          {
            symbol: "AAPL",
            regularMarketPrice: 210.5,
            regularMarketPreviousClose: 208,
            regularMarketVolume: 1_000_000,
            regularMarketTime: Date.parse("2026-11-11T20:36:00.000Z") / 1000,
            bid: 210.4,
            ask: 210.6,
            fullExchangeName: "NasdaqGS",
            shortName: "Apple"
          }
        ]
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function emptyNasdaq() {
  return new Response(JSON.stringify({ data: { table: { rows: [] } } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("interactive seed preview", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "agentic-scan-seed-")), "scan-seed.db")}`;
    resetDbForTesting();
  });

  beforeEach(() => {
    clearMarketCache();
    resetProviderRateLimiterState();
    resetScanRecoveriesForTests();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetScanRecoveriesForTests();
  });

  it("labels a 2:14 PM snapshot as 23 minutes old", () => {
    expect(formatScanPriceAge(pricesAsOf, now)).toBe(age);
    expect(scanSnapshotPriceLabel({ pricesAsOf, refreshPending: true, now })).toBe(
      `${age}.\u00A0 Updating with live prices.`
    );
    expect(scanSnapshotPriceLabel({ pricesAsOf, refreshPending: false, now })).toBe(age);
  });

  it("returns the saved snapshot before live recovery, then replaces it", async () => {
    let yahooReleased = false;
    let releaseYahoo: (response: Response) => void = () => {};
    const yahooGate = new Promise<Response>((resolve) => {
      releaseYahoo = (response) => {
        yahooReleased = true;
        resolve(response);
      };
    });
    const snapshotAsOf = new Date(Date.now() - 23 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("api.nasdaq.com")) return emptyNasdaq();
      if (url.includes("fc.yahoo.com")) {
        return new Response("", { status: 200, headers: { "set-cookie": "A=B" } });
      }
      if (url.includes("/v1/test/getcrumb")) return new Response("crumb", { status: 200 });
      if (url.includes("/v7/finance/quote") || url.includes("/v8/finance/chart/AAPL")) return yahooGate;
      return new Response("nope", { status: 404 });
    }));

    const pending = scanMarket(["AAPL"], [], undefined, undefined, [], {
      enrichmentMode: "skip",
      previewSeedBeforeLiveRecovery: true,
      seedAsOf: snapshotAsOf,
      seedEnrichment: { AAPL: seedQuote(snapshotAsOf) }
    });
    const first = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("seed preview waited on live recovery")), 3_000);
      })
    ]);

    expect(yahooReleased).toBe(false);
    expect(first.pricesAsOf).toBe(snapshotAsOf);
    expect(first.generatedAt).toBe(snapshotAsOf);
    expect(first.refreshPending).toBe(true);
    expect(first.recoveryId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.topCandidates[0]?.price).toBe(91);
    expect(first.topCandidates[0]?.symbol).toBe("AAPL");

    releaseYahoo(yahooQuoteResponse());
    const live = await awaitScanRecovery(first.recoveryId ?? "", undefined);
    expect(live && "keptSnapshot" in live).toBe(false);
    if (!live || "keptSnapshot" in live) throw new Error("expected a live scan");
    expect(live.topCandidates.some((quote) => quote.symbol === "AAPL" && quote.price === 210.5)).toBe(true);
    expect(live.refreshPending).toBeUndefined();
    expect(live.pricesAsOf).toBeUndefined();
  });

  it("keeps the saved snapshot and its age when live recovery fails", async () => {
    const snapshotAsOf = new Date(Date.now() - 23 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("api.nasdaq.com")) return emptyNasdaq();
      return new Response("nope", { status: 404 });
    }));

    const first = await scanMarket(["AAPL"], [], undefined, undefined, [], {
      enrichmentMode: "skip",
      previewSeedBeforeLiveRecovery: true,
      seedAsOf: snapshotAsOf,
      seedEnrichment: { AAPL: seedQuote(snapshotAsOf) }
    });
    expect(first.pricesAsOf).toBe(snapshotAsOf);
    expect(first.topCandidates[0]?.price).toBe(91);

    const live = await awaitScanRecovery(first.recoveryId ?? "", undefined);
    expect(live).toEqual({ keptSnapshot: true, pricesAsOf: snapshotAsOf, refreshPending: false });
    expect(scanSnapshotPriceLabel({ pricesAsOf: first.pricesAsOf, refreshPending: false, now: Date.now() })).toMatch(
      /^Prices as of .+23 min old$/
    );
  });

  it("replaces the snapshot in the client and keeps it when recovery fails", () => {
    const snapshot = {
      source: "persisted-strategy-scan",
      generatedAt: pricesAsOf,
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [{ symbol: "AAPL", price: 91 }],
      sectorBySymbol: {},
      quotesBySymbol: {},
      warnings: [],
      pricesAsOf,
      refreshPending: true,
      recoveryId: "11111111-1111-4111-8111-111111111111"
    } as unknown as MarketScan;
    const live = {
      ...snapshot,
      source: "yahoo-finance",
      generatedAt: "2026-11-11T20:40:00.000Z",
      refreshPending: undefined,
      pricesAsOf: undefined,
      topCandidates: [{ symbol: "AAPL", price: 210.5 }]
    } as unknown as MarketScan;
    const replaced = scanAfterLiveRecovery(snapshot, live, now);
    expect(replaced.scan.topCandidates[0]?.price).toBe(210.5);
    expect(replaced.priceAgeLabel).toBeNull();

    const kept = scanAfterLiveRecovery(
      snapshot,
      { keptSnapshot: true, pricesAsOf, refreshPending: false },
      now
    );
    expect(kept.scan.topCandidates[0]?.price).toBe(91);
    expect(kept.priceAgeLabel).toBe(age);
  });

  it("follows a live reply that is itself another refreshPending preview", () => {
    const snapshot = {
      source: "persisted-strategy-scan",
      generatedAt: pricesAsOf,
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [{ symbol: "AAPL", price: 91 }],
      sectorBySymbol: {},
      quotesBySymbol: {},
      warnings: [],
      pricesAsOf,
      refreshPending: true,
      recoveryId: "11111111-1111-4111-8111-111111111111"
    } as unknown as MarketScan;
    const chainedId = "22222222-2222-4222-8222-222222222222";
    const chained = {
      ...snapshot,
      recoveryId: chainedId
    } as unknown as MarketScan;
    const next = scanAfterLiveRecovery(snapshot, chained, now);
    expect(next.scan.recoveryId).toBe(chainedId);
    expect(next.scan.refreshPending).toBe(true);
    expect(next.priceAgeLabel).toBe(`${age}.\u00A0 Updating with live prices.`);
  });

  it("keeps the snapshot when a refreshPending reply has no recovery id", () => {
    const snapshot = {
      source: "persisted-strategy-scan",
      generatedAt: pricesAsOf,
      scannedSymbols: 1,
      returnedQuotes: 1,
      topCandidates: [{ symbol: "AAPL", price: 91 }],
      sectorBySymbol: {},
      quotesBySymbol: {},
      warnings: [],
      pricesAsOf,
      refreshPending: true,
      recoveryId: "11111111-1111-4111-8111-111111111111"
    } as unknown as MarketScan;
    const stuck = { ...snapshot, recoveryId: undefined, topCandidates: [{ symbol: "AAPL", price: 1 }] } as unknown as MarketScan;
    const kept = scanAfterLiveRecovery(snapshot, stuck, now);
    expect(kept.scan.topCandidates[0]?.price).toBe(91);
    expect(kept.scan.recoveryId).toBe("11111111-1111-4111-8111-111111111111");
    expect(kept.priceAgeLabel).toBe(age);
  });

  it("pins recoveries on globalThis so a second module copy can await them", async () => {
    const result = { keptSnapshot: true as const, pricesAsOf, refreshPending: false };
    const { registerScanRecovery } = await import("../src/lib/scan-seed-preview");
    registerScanRecovery("33333333-3333-4333-8333-333333333333", "user-1", Promise.resolve(result));
    const shared = globalThis.__socraticScanSeedPreviewRecoveries;
    expect(shared?.has("33333333-3333-4333-8333-333333333333")).toBe(true);
    const again = await shared?.get("33333333-3333-4333-8333-333333333333")?.promise;
    expect(again).toEqual(result);
  });

  it("stops background live recovery when the caller aborts", async () => {
    const snapshotAsOf = new Date(Date.now() - 23 * 60_000).toISOString();
    let yahooStarted = false;
    let yahooAborted = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("api.nasdaq.com")) return emptyNasdaq();
      if (url.includes("fc.yahoo.com")) {
        return new Response("", { status: 200, headers: { "set-cookie": "A=B" } });
      }
      if (url.includes("/v1/test/getcrumb")) return new Response("crumb", { status: 200 });
      if (url.includes("/v7/finance/quote") || url.includes("/v8/finance/chart/AAPL")) {
        yahooStarted = true;
        return await new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            yahooAborted = true;
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => {
            yahooAborted = true;
            reject(signal.reason ?? new Error("aborted"));
          }, { once: true });
        });
      }
      return new Response("nope", { status: 404 });
    }));

    const controller = new AbortController();
    const first = await scanMarket(["AAPL"], [], undefined, undefined, [], {
      enrichmentMode: "skip",
      previewSeedBeforeLiveRecovery: true,
      seedAsOf: snapshotAsOf,
      seedEnrichment: { AAPL: seedQuote(snapshotAsOf) },
      signal: controller.signal
    });
    expect(first.refreshPending).toBe(true);
    expect(first.recoveryId).toMatch(/^[0-9a-f-]{36}$/i);

    await vi.waitFor(() => expect(yahooStarted).toBe(true));
    controller.abort(new Error("caller cancelled"));
    const live = await awaitScanRecovery(first.recoveryId ?? "", undefined);
    expect(yahooAborted).toBe(true);
    expect(live).toEqual({ keptSnapshot: true, pricesAsOf: snapshotAsOf, refreshPending: false });
  });
});
