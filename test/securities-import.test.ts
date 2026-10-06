import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearImportedSecuritiesForTests,
  getImportedCacheCounts,
  getImportedPriceCloses,
  getImportedRef,
  getImportedSpxCloses,
  persistSecuritiesImport,
  upsertImportedPrices,
  upsertImportedRefs,
  upsertImportedSpx,
  type ImportedCloseInput
} from "../src/lib/db-securities-import";
import { verifySecuritiesImportToken, securitiesImportToken } from "../src/lib/securities-import-auth";
import { clearHistoryCache, fetchDailyOHLC, toBusinessDay } from "../src/lib/history";
import { latestCompletedTradingSessionEtKey } from "../src/lib/market-hours";
import { POST as importRoute } from "../app/api/admin/securities/import/route";
import { SECURITIES_IMPORT_MAX_BYTES } from "../src/lib/bounded-body";
import { RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";

function securitiesImportTestToken(): string {
  const token = process.env.SECURITIES_IMPORT_TEST_TOKEN;
  if (!token) {
    throw new Error("SECURITIES_IMPORT_TEST_TOKEN is required for securities-import tests");
  }
  return token;
}

function bearerAuth(token: string): string {
  return `Bearer ${token}`;
}

function configureIngestToken(): string {
  const token = securitiesImportTestToken();
  process.env.APP_B_INGEST_TOKEN = token;
  return token;
}

function ingestAuthHeader(): string {
  return bearerAuth(configureIngestToken());
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-securities-import-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetRateLimiter();
  clearImportedSecuritiesForTests();
  clearHistoryCache();
  delete process.env.APP_B_INGEST_TOKEN;
  delete process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED;
  delete process.env.SECURITIES_IMPORT_MIN_BARS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** n sequential daily closes starting 2024-01-01 (deterministic dates/values). */
function seqCloses(n: number, startClose = 100): ImportedCloseInput[] {
  const base = Date.UTC(2024, 0, 1);
  const out: ImportedCloseInput[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ date: new Date(base + i * 86_400_000).toISOString().slice(0, 10), close: startClose + i, volume: 1000 + i });
  }
  return out;
}

// ── db-securities-import ────────────────────────────────────────────────────────

describe("upsertImportedPrices / getImportedPriceCloses", () => {
  it("persists closes keyed ticker+date, ascending, and dedups idempotently", () => {
    const res = upsertImportedPrices([{ ticker: "aapl", closes: seqCloses(3) }]);
    expect(res).toEqual({ tickers: 1, rows: 3 });
    const closes = getImportedPriceCloses("AAPL");
    expect(closes.map((c) => c.date)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(closes[0]).toEqual({ date: "2024-01-01", close: 100, volume: 1000 });
    // re-importing the same rows is idempotent (upsert by ticker+date)
    upsertImportedPrices([{ ticker: "AAPL", closes: seqCloses(3) }]);
    expect(getImportedPriceCloses("AAPL")).toHaveLength(3);
  });

  it("drops invalid dates and non-finite closes", () => {
    const res = upsertImportedPrices([
      { ticker: "MSFT", closes: [{ date: "not-a-date", close: 10 }, { date: "2024-02-01", close: Number.NaN }, { date: "2024-02-02", close: 42 }] }
    ]);
    expect(res).toEqual({ tickers: 1, rows: 1 });
    expect(getImportedPriceCloses("MSFT")).toEqual([{ date: "2024-02-02", close: 42 }]);
  });

  it("a later close value overwrites an earlier one for the same date", () => {
    upsertImportedPrices([{ ticker: "NVDA", closes: [{ date: "2024-03-01", close: 50 }] }]);
    upsertImportedPrices([{ ticker: "NVDA", closes: [{ date: "2024-03-01", close: 55 }] }]);
    expect(getImportedPriceCloses("NVDA")).toEqual([{ date: "2024-03-01", close: 55, volume: undefined }].map((c) => ({ date: c.date, close: c.close })));
  });
});

describe("upsertImportedSpx / getImportedSpxCloses", () => {
  it("persists the SPX series keyed by date", () => {
    expect(upsertImportedSpx(seqCloses(4, 5000))).toBe(4);
    const spx = getImportedSpxCloses();
    expect(spx).toHaveLength(4);
    expect(spx[0]).toEqual({ date: "2024-01-01", close: 5000, volume: 1000 });
  });
});

describe("upsertImportedRefs / getImportedRef", () => {
  it("upserts non-destructively (COALESCE keeps prior fields when a later push omits them)", () => {
    upsertImportedRefs([{ ticker: "tsla", companyName: "Tesla", sector: "Auto", marketCap: 1e12 }]);
    upsertImportedRefs([{ ticker: "TSLA", industry: "EV" }]); // omits companyName/sector
    const ref = getImportedRef("TSLA");
    expect(ref?.companyName).toBe("Tesla");
    expect(ref?.sector).toBe("Auto");
    expect(ref?.industry).toBe("EV");
    expect(ref?.marketCap).toBe(1e12);
  });

});

describe("persistSecuritiesImport + getImportedCacheCounts", () => {
  it("persists a whole payload and reports counts", () => {
    const result = persistSecuritiesImport({
      refs: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
      prices: [{ ticker: "AAPL", closes: seqCloses(2) }],
      spx: seqCloses(3, 5000)
    });
    expect(result).toEqual({ refs: 2, pricedTickers: 1, priceRows: 2, spxRows: 3 });
    expect(getImportedCacheCounts()).toEqual({ refs: 2, pricedTickers: 1, priceRows: 2, spxRows: 3 });
  });
});

// ── auth ──────────────────────────────────────────────────────────────────────

describe("securities-import auth", () => {
  function reqWith(auth?: string): Request {
    return new Request("http://localhost/api/admin/securities/import", {
      method: "POST",
      headers: auth ? { authorization: auth } : {}
    });
  }

  it("is default-closed: no token configured rejects everything", () => {
    expect(securitiesImportToken()).toBeUndefined();
    expect(verifySecuritiesImportToken(reqWith("Bearer anything"))).toBe(false);
  });

  it("rejects a wrong / length-mismatched token and accepts the exact token", () => {
    configureIngestToken();
    expect(verifySecuritiesImportToken(reqWith("Bearer wrong"))).toBe(false);
    expect(verifySecuritiesImportToken(reqWith(""))).toBe(false);
    expect(verifySecuritiesImportToken(reqWith(ingestAuthHeader()))).toBe(true);
  });
});

// ── route (POST /api/admin/securities/import) ───────────────────────────────────

function postJson(body: unknown, auth?: string): Request {
  return new Request("http://localhost/api/admin/securities/import", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body)
  });
}

describe("POST /api/admin/securities/import", () => {
  it("401s when no token is configured (default-closed)", async () => {
    const res = await importRoute(postJson({ prices: [] }, "Bearer x"));
    expect(res.status).toBe(401);
  });

  it("401s on a wrong token", async () => {
    configureIngestToken();
    const res = await importRoute(postJson({ prices: [] }, "Bearer nope"));
    expect(res.status).toBe(401);
  });

  it("persists refs/prices/spx and returns counts on a valid token", async () => {
    configureIngestToken();
    const res = await importRoute(
      postJson(
        { refs: [{ ticker: "AAPL", companyName: "Apple" }], prices: [{ ticker: "AAPL", closes: seqCloses(3) }], spx: seqCloses(2, 5000), origin: "app-a" },
        ingestAuthHeader()
      )
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; refs: number; pricedTickers: number; priceRows: number; spxRows: number };
    expect(json).toMatchObject({ ok: true, refs: 1, pricedTickers: 1, priceRows: 3, spxRows: 2 });
    expect(getImportedPriceCloses("AAPL")).toHaveLength(3);
  });

  it("no-echo guard: a payload tagged with App B's own origin is acked but NOT stored", async () => {
    configureIngestToken();
    const res = await importRoute(postJson({ prices: [{ ticker: "AAPL", closes: seqCloses(3) }], origin: "app-b" }, ingestAuthHeader()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; skipped?: boolean };
    expect(json).toMatchObject({ ok: true, skipped: true });
    expect(getImportedPriceCloses("AAPL")).toHaveLength(0);
  });

  it("ignores insider/shortVolume on the inbound path", async () => {
    configureIngestToken();
    const res = await importRoute(
      postJson(
        {
          prices: [{ ticker: "F", closes: seqCloses(2) }],
          insider: [
            {
              ticker: "F",
              date: "2024-01-01",
              sentiment: 0,
              buyFilings: 0,
              sellFilings: 0,
              buyShares: 0,
              sellShares: 0,
              owners: [],
            },
          ],
          shortVolume: [{ ticker: "F", date: "2024-01-01", ratio: 0.5, elevated: false }],
        },
        ingestAuthHeader()
      )
    );
    expect(res.status).toBe(200);
    expect(getImportedPriceCloses("F")).toHaveLength(2);
  });

  it("413s when the body exceeds SECURITIES_IMPORT_MAX_BYTES", async () => {
    configureIngestToken();
    const bigBody = JSON.stringify({ padding: "a".repeat(SECURITIES_IMPORT_MAX_BYTES) });
    const req = new Request("http://localhost/api/admin/securities/import", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ingestAuthHeader() },
      body: bigBody
    });
    const res = await importRoute(req);
    expect(res.status).toBe(413);
  });

  it("returns 429 after the per-IP rate limit is exceeded", async () => {
    configureIngestToken();
    const { limit } = RATE_LIMITS.securitiesImport;
    const headers = {
      "content-type": "application/json",
      authorization: ingestAuthHeader(),
      "cf-connecting-ip": "203.0.113.50"
    };
    for (let i = 0; i < limit; i++) {
      const ok = await importRoute(
        new Request("http://localhost/api/admin/securities/import", {
          method: "POST",
          headers,
          body: JSON.stringify({ prices: [] })
        })
      );
      expect(ok.status).toBe(200);
    }
    const blocked = await importRoute(
      new Request("http://localhost/api/admin/securities/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ prices: [] })
      })
    );
    expect(blocked.status).toBe(429);
  });

  it("400s when refs contain invalid row shapes (strict Zod at trust boundary)", async () => {
    configureIngestToken();
    const res = await importRoute(
      postJson({ refs: [{ ticker: "AAPL" }, { ticker: "" }, "not-an-object"] }, ingestAuthHeader())
    );
    expect(res.status).toBe(400);
  });

  it("accepts optional schemaVersion on the inbound payload", async () => {
    configureIngestToken();
    const res = await importRoute(postJson({ schemaVersion: "2.7.0", prices: [] }, ingestAuthHeader()));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { schemaVersion?: string };
    expect(json.schemaVersion).toBe("2.7.0");
  });

  it("strips control characters from schemaVersion before logging and echoing", async () => {
    configureIngestToken();
    const res = await importRoute(
      postJson({ schemaVersion: "2.7.0\n[securities-import] forged", prices: [] }, ingestAuthHeader())
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { schemaVersion?: string };
    expect(json.schemaVersion).toBe("2.7.0[securities-import] forged");
  });
});

// ── fetchDailyOHLC cache-aside tier ─────────────────────────────────────────────

describe("fetchDailyOHLC imported-EOD tier", () => {
  beforeEach(() => {
    // Stub the network so the keyed/free providers can never serve — isolates the local tier.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in test"); }));
  });

  it("serves imported closes (close-only bars) when enabled and dense enough", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedPrices([{ ticker: "DENSE", closes: seqCloses(250) }]);
    const bars = await fetchDailyOHLC("DENSE", Date.UTC(2025, 0, 1));
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(250);
    expect(bars![0]).toMatchObject({ close: 100 });
    expect(bars![0].open).toBeUndefined(); // close-only
  });

  it("does NOT serve when the tier is disabled (default)", async () => {
    upsertImportedPrices([{ ticker: "OFFSYM", closes: seqCloses(250) }]);
    const bars = await fetchDailyOHLC("OFFSYM", Date.UTC(2025, 0, 1));
    expect(bars).toBeNull(); // tier off + network stubbed to fail → cascade yields nothing
  });

  it("density guard: a sparse import (< SECURITIES_IMPORT_MIN_BARS) does not short-circuit", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedPrices([{ ticker: "SPARSE", closes: seqCloses(5) }]);
    const bars = await fetchDailyOHLC("SPARSE", Date.UTC(2025, 0, 1));
    expect(bars).toBeNull();
  });

  it("serves the imported ^GSPC series from the spx table", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedSpx(seqCloses(250, 5000));
    const bars = await fetchDailyOHLC("^GSPC", Date.UTC(2025, 0, 1));
    expect(bars).toHaveLength(250);
    expect(bars![0]).toMatchObject({ close: 5000 });
  });

  it("does not let a stale dense import beat a live source", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedPrices([{ ticker: "SPY", closes: seqCloses(250) }]);
    // Wednesday 2026-09-30 21:00 UTC is after the 16:00 ET cash close.
    const now = Date.UTC(2026, 8, 30, 21, 0, 0);
    const session = latestCompletedTradingSessionEtKey(now);
    const endSec = Math.floor(Date.parse(`${session}T20:00:00Z`) / 1000);
    const yahoo = JSON.stringify({
      chart: {
        result: [{
          timestamp: [endSec - 86_400, endSec],
          indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [10, 11], volume: [1, 1] }] }
        }]
      }
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com")
        ? new Response(yahoo, { status: 200 })
        : new Response("no other source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("SPY", now);
    expect(fetchMock).toHaveBeenCalled();
    expect(toBusinessDay(bars![bars!.length - 1].time)).toBe(session);
  });

  it("still serves a fresh dense import without calling the network", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    const now = Date.UTC(2026, 8, 30, 21, 0, 0);
    const session = latestCompletedTradingSessionEtKey(now);
    const end = Date.parse(`${session}T00:00:00Z`);
    const closes: ImportedCloseInput[] = [];
    for (let i = 0; i < 250; i++) {
      closes.push({
        date: new Date(end - (249 - i) * 86_400_000).toISOString().slice(0, 10),
        close: 100 + i,
        volume: 1
      });
    }
    upsertImportedPrices([{ ticker: "FRESH", closes }]);
    const fetchMock = vi.fn(async () => new Response("should not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("FRESH", now);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bars).toHaveLength(250);
    expect(toBusinessDay(bars![bars!.length - 1].time)).toBe(session);
  });

  // ── perf-17 extras kept on top of #4009's freshness gate ────────────────────────────────────
  //
  // #4009 (above) stops a stale import from short-circuiting the cascade.  What it did not cover:
  // when a live provider then answers, the stale import's older history should still be merged in
  // (a live source may return a shorter window), and when EVERY provider fails the fallback should
  // say which tier the frozen bars came from so the benchmark can flag the feed as stale.

  it("perf-17: merges the stale imported history with a live provider's bars, keeping import provenance", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    // seqCloses(250) from 2024-01-01 ends ~2024-09-06, stale relative to "now" below.
    upsertImportedPrices([{ ticker: "STALEIMP", closes: seqCloses(250) }]);
    const now = Date.UTC(2025, 0, 1);
    const yahooTimestampSec = Math.floor(now / 1000) - 5 * 86_400;
    const yahooBody = JSON.stringify({
      chart: {
        result: [
          {
            timestamp: [yahooTimestampSec, yahooTimestampSec + 86_400],
            indicators: { quote: [{ close: [500, 505] }] }
          }
        ]
      }
    });
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("query1.finance.yahoo.com")
        ? new Response(yahooBody, { status: 200 })
        : new Response("unexpected source", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("STALEIMP", now);
    expect(bars).not.toBeNull();
    expect(bars!.some((b) => b.close === 500 && b.source === "yahoo-finance")).toBe(true);
    // The stale imported history is preserved (merged), still tagged with its own source rather
    // than inheriting "yahoo-finance" from the bars it was merged with.
    expect(bars!.some((b) => b.close === 100 && b.source === "imported-eod")).toBe(true);
  });

  it("perf-17: an import-only fallback is stamped imported-eod-stale when every live tier fails", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedPrices([{ ticker: "STALENOLIVE", closes: seqCloses(250) }]);
    // beforeEach already stubs fetch to throw for every URL, so every live tier fails.
    const bars = await fetchDailyOHLC("STALENOLIVE", Date.UTC(2025, 0, 1));
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(250);
    expect(bars![0]).toMatchObject({ close: 100 });
    // The WHOLE series is a stale fallback, so it is tagged as one: a consumer that keys on the
    // stale source (benchmark.ts fellBackToStaleCache) can then tell it from a live feed.
    expect(bars!.every((b) => b.source === "imported-eod-stale")).toBe(true);
  });
});
