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
import { clearHistoryCache, fetchDailyOHLC } from "../src/lib/history";
import { POST as importRoute } from "../app/api/admin/securities/import/route";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-securities-import-${randomUUID()}.db`)}`;
});

beforeEach(() => {
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
    process.env.APP_B_INGEST_TOKEN = "s3cret-token";
    expect(verifySecuritiesImportToken(reqWith("Bearer wrong"))).toBe(false);
    expect(verifySecuritiesImportToken(reqWith(""))).toBe(false);
    expect(verifySecuritiesImportToken(reqWith("Bearer s3cret-token"))).toBe(true);
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
    process.env.APP_B_INGEST_TOKEN = "tok";
    const res = await importRoute(postJson({ prices: [] }, "Bearer nope"));
    expect(res.status).toBe(401);
  });

  it("persists refs/prices/spx and returns counts on a valid token", async () => {
    process.env.APP_B_INGEST_TOKEN = "tok";
    const res = await importRoute(
      postJson(
        { refs: [{ ticker: "AAPL", companyName: "Apple" }], prices: [{ ticker: "AAPL", closes: seqCloses(3) }], spx: seqCloses(2, 5000), origin: "app-a" },
        "Bearer tok"
      )
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; refs: number; pricedTickers: number; priceRows: number; spxRows: number };
    expect(json).toMatchObject({ ok: true, refs: 1, pricedTickers: 1, priceRows: 3, spxRows: 2 });
    expect(getImportedPriceCloses("AAPL")).toHaveLength(3);
  });

  it("no-echo guard: a payload tagged with App B's own origin is acked but NOT stored", async () => {
    process.env.APP_B_INGEST_TOKEN = "tok";
    const res = await importRoute(postJson({ prices: [{ ticker: "AAPL", closes: seqCloses(3) }], origin: "app-b" }, "Bearer tok"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; skipped?: boolean };
    expect(json).toMatchObject({ ok: true, skipped: true });
    expect(getImportedPriceCloses("AAPL")).toHaveLength(0);
  });

  it("ignores insider/shortVolume on the inbound path", async () => {
    process.env.APP_B_INGEST_TOKEN = "tok";
    const res = await importRoute(
      postJson({ prices: [{ ticker: "F", closes: seqCloses(2) }], insider: [{ ticker: "F" }], shortVolume: [{ ticker: "F" }] }, "Bearer tok")
    );
    expect(res.status).toBe(200);
    expect(getImportedPriceCloses("F")).toHaveLength(2);
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

  // ── perf-17: a stale imported series must not permanently pin the cascade ────────────
  //
  // Production observed the SPY benchmark (src/lib/benchmark.ts, which calls fetchDailyOHLC via
  // this same imported-EOD tier) stuck reporting "source imported-eod" since 2026-07-24 — the
  // tier used to accept ANY imported hit with >=2 bars unconditionally, with no freshness check,
  // so a live tier (Tradier/Alpaca/Massive/ROIC/Tiingo/Yahoo/Marketstack) never even ran once the
  // imported series stopped being refreshed. These three tests cover the fix end to end: still
  // short-circuits when fresh (unchanged behavior, no wasted live call), falls through to a live
  // provider when stale, and falls back to the stale series (not null) if every live tier ALSO
  // fails.

  it("perf-17: still short-circuits immediately when the imported series IS fresh — no live tier is ever called", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    // seqCloses(400) from 2024-01-01 reaches ~2025-02-04 — comfortably past "now" below, so this
    // series is fresh as of that "now" by definition (its last bar is in the FUTURE relative to
    // "now", which trivially satisfies "includes the most recently completed session").
    upsertImportedPrices([{ ticker: "FRESHIMP", closes: seqCloses(400) }]);
    const fetchMock = vi.fn(async () => new Response("must not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const bars = await fetchDailyOHLC("FRESHIMP", Date.UTC(2025, 0, 1));
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(400);
    expect(bars![0]).toMatchObject({ close: 100 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("perf-17: falls through to a live provider when the imported series has gone STALE", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    // seqCloses(250) from 2024-01-01 ends ~2024-09-06 — stale relative to "now" below.
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
    // The live Yahoo fetch actually ran — the stale imported series did not short-circuit it.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("query1.finance.yahoo.com"))).toBe(true);
    expect(bars!.some((b) => b.close === 500 && b.source === "yahoo-finance")).toBe(true);
    // The stale imported history is preserved (merged), still tagged with its own source rather
    // than inheriting "yahoo-finance" from the bars it was merged with.
    expect(bars!.some((b) => b.close === 100 && b.source === "imported-eod")).toBe(true);
  });

  it("perf-17: falls back to the stale imported series (not null) when every live tier ALSO fails", async () => {
    process.env.SECURITIES_IMPORT_HISTORY_TIER_ENABLED = "1";
    upsertImportedPrices([{ ticker: "STALENOLIVE", closes: seqCloses(250) }]);
    // beforeEach already stubs fetch to throw for every URL — every live tier fails.
    const bars = await fetchDailyOHLC("STALENOLIVE", Date.UTC(2025, 0, 1));
    expect(bars).not.toBeNull();
    expect(bars).toHaveLength(250);
    expect(bars![0]).toMatchObject({ close: 100 });
    // The WHOLE series is a stale fallback here, so it is tagged as one — a consumer that keys on
    // the stale source (benchmark.ts `fellBackToStaleCache`) can then tell it from a live feed.
    expect(bars!.every((b) => b.source === "imported-eod-stale")).toBe(true);
  });
});
