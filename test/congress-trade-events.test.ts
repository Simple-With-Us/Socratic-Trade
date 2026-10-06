import { randomUUID, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCongressEvent,
  applyCongressEvents,
  resetCongressEventDedupe
} from "../src/lib/congress-trade-events";
import { getServiceHealthSummaries } from "../src/lib/db-health";
import { coerceCongressTrade, CONGRESS_CURSOR_SETTING_KEY, fetchAppACongressTrades, getCongressSignals, refreshCongress, upsertCongressTrades } from "../src/lib/web-sources/congress";
import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "../src/lib/db";
import { getCongressDataset, getInsiderSignals, getSymbolWebSignals } from "../src/lib/web-sources";
import { POST as postCongressWebhook } from "../app/api/webhooks/congress/route";
import { RATE_LIMITS, resetRateLimiter } from "../src/lib/rate-limit";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-events-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetRateLimiter();
  resetCongressEventDedupe();
  delete process.env.CONGRESS_WEBHOOK_SECRET;
});

function congressWebhookTestSecret(): string {
  const secret = process.env.CONGRESS_WEBHOOK_TEST_SECRET;
  if (!secret) {
    throw new Error("CONGRESS_WEBHOOK_TEST_SECRET is required");
  }
  return secret;
}

function useCongressWebhookSecret(): string {
  const secret = congressWebhookTestSecret();
  process.env.CONGRESS_WEBHOOK_SECRET = secret;
  return secret;
}

const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe("applyCongressEvent — congress.trade", () => {
  it("upserts trades into the dataset and surfaces a per-symbol congress signal", () => {
    const res = applyCongressEvent({
      type: "congress.trade",
      id: `evt-${randomUUID()}`,
      data: {
        trades: [
          { symbol: "aapl", member: "Jane Doe", chamber: "house", side: "buy", tradedAt: recent(5), disclosedAt: recent(2) },
          { symbol: "AAPL", member: "John Roe", chamber: "senate", side: "buy", tradedAt: recent(6), disclosedAt: recent(3) }
        ]
      }
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toBeGreaterThanOrEqual(2);
    expect((getCongressDataset()?.trades ?? []).some((t) => t.symbol === "AAPL")).toBe(true);
    const sig = getSymbolWebSignals(["AAPL"]).AAPL?.congress;
    expect(sig).toBeDefined();
    expect(sig!.netSignal).toBeGreaterThanOrEqual(2); // two distinct members bought
  });

  it("coerces tolerant field aliases (ticker/txDate/type)", () => {
    const res = applyCongressEvent({
      type: "congress.trade",
      id: `evt-${randomUUID()}`,
      data: { trades: [{ ticker: "MSFT", name: "Sam Poe", type: "purchase", txDate: recent(4) }] }
    });
    expect(res.ok).toBe(true);
    expect((getCongressDataset()?.trades ?? []).some((t) => t.symbol === "MSFT")).toBe(true);
  });

  it("ignores rows with no usable ticker/side/date", () => {
    const res = applyCongressEvent({
      type: "congress.trade",
      id: `evt-${randomUUID()}`,
      data: { trades: [{ member: "Nobody" }, { symbol: "GOOG", side: "hold", tradedAt: recent(1) }] }
    });
    expect(res).toMatchObject({ ok: true, applied: 0, reason: "no-trades" });
  });

  it("counts net-new trades and is idempotent on re-send (different event id, same trade)", () => {
    const trade = { symbol: "RBLX", member: "AA", side: "buy", tradedAt: recent(3), disclosedAt: recent(1) };
    expect(applyCongressEvent({ type: "congress.trade", id: `evt-${randomUUID()}`, data: { trades: [trade] } }).applied).toBe(1);
    expect(applyCongressEvent({ type: "congress.trade", id: `evt-${randomUUID()}`, data: { trades: [trade] } }).applied).toBe(0);
  });
});

describe("coerceCongressTrade — App A /api/transactions confirmed shape", () => {
  it("maps the confirmed App A object fields", () => {
    expect(
      coerceCongressTrade({
        ticker: "aapl", memberName: "Jane Doe", chamber: "house", txType: "P",
        amountMin: 15000, amountMax: 50000, owner: "Self", txDate: "2026-06-10", filedDate: "2026-06-15", source: "primary"
      })
    ).toMatchObject({
      symbol: "AAPL", member: "Jane Doe", chamber: "house", side: "buy",
      amountLow: 15000, amountHigh: 50000, owner: "Self", tradedAt: "2026-06-10", disclosedAt: "2026-06-15"
    });
  });

  it("maps SEC codes P→buy and S / S_partial→sell, and 'senate'→senate", () => {
    expect(coerceCongressTrade({ ticker: "MSFT", txType: "S", txDate: "2026-06-01", chamber: "senate" })).toMatchObject({ side: "sell", chamber: "senate" });
    expect(coerceCongressTrade({ ticker: "MSFT", txType: "S_partial", txDate: "2026-06-01" })?.side).toBe("sell");
  });

  it("does NOT misclassify 'representative' as senate", () => {
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-06-01", chamber: "representative" })?.chamber).toBe("house");
  });

  it("rejects gifts and unparseable dates at ingestion", () => {
    expect(coerceCongressTrade({ ticker: "T", txType: "G", txDate: "2026-06-01" })).toBeNull();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "not-a-date" })).toBeNull();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-13-45" })).toBeNull();
  });

  it("keeps exchange and executive, and does not copy tradedAt into disclosedAt", () => {
    const exchange = coerceCongressTrade({ ticker: "T", txType: "E", txDate: "2026-06-01" });
    expect(exchange).toMatchObject({ side: "exchange", tradedAt: "2026-06-01" });
    expect(exchange?.disclosedAt).toBeUndefined();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-06-01", chamber: "executive" })?.chamber).toBe("executive");
    expect(coerceCongressTrade({ ticker: "T", txType: "exchange", txDate: "2026-06-01" })?.side).toBe("exchange");
  });

  it("keeps identity, prices, and latency from the feed payload", () => {
    expect(coerceCongressTrade({
      id: "tx-9",
      docId: "doc-9",
      rowKey: "row-9",
      ticker: "T",
      txType: "P",
      txDate: "2026-06-01",
      filedDate: "2026-06-03",
      party: "Democratic",
      bioguideId: "P000197",
      pdfUrl: "/api/documents/doc-9/pdf",
      disclosureLagDays: 3,
      stockActStatus: "on_time",
      priceAtTrade: 10,
      spxAtTrade: 5000,
      priceAtFiling: 11,
      spxAtFiling: 5010,
      latency: {
        provider: "fmp",
        providerDeltaSec: 12,
        status: "matched",
        providerPublishedAt: "2026-06-02T00:00:00.000Z"
      }
    })).toMatchObject({
      id: "tx-9",
      docId: "doc-9",
      rowKey: "row-9",
      party: "Democratic",
      bioguideId: "P000197",
      pdfUrl: "/api/documents/doc-9/pdf",
      disclosureLagDays: 3,
      stockActStatus: "on_time",
      priceAtTrade: 10,
      spxAtTrade: 5000,
      priceAtFiling: 11,
      spxAtFiling: 5010,
      disclosedAt: "2026-06-03",
      latencyProbeDelayMs: 12000,
      latencyProbeHealth: "matched",
      providerPublishedAt: "2026-06-02T00:00:00.000Z"
    });
  });

  it("dedupes on id, otherwise docId+rowKey, and still collapses rows with neither", () => {
    const day = recent(2);
    const self = coerceCongressTrade({ id: "zzz-self", ticker: "ZZZ", memberName: "Jane Doe", txType: "P", txDate: day, amountMin: 1000, owner: "self" });
    const spouse = coerceCongressTrade({ id: "zzz-spouse", ticker: "ZZZ", memberName: "Jane Doe", txType: "P", txDate: day, amountMin: 1000, owner: "spouse" });
    expect(self && spouse).toBeTruthy();
    expect(upsertCongressTrades([self!, spouse!]).added).toBe(2);
    expect((getCongressDataset()?.trades ?? []).filter((t) => t.symbol === "ZZZ")).toHaveLength(2);

    const rowA = coerceCongressTrade({ docId: "doc-q", rowKey: "1", ticker: "QQQ", memberName: "Jane Doe", txType: "P", txDate: day, amountMin: 1000, owner: "self" });
    const rowB = coerceCongressTrade({ docId: "doc-q", rowKey: "2", ticker: "QQQ", memberName: "Jane Doe", txType: "P", txDate: day, amountMin: 1000, owner: "spouse" });
    expect(upsertCongressTrades([rowA!, rowB!]).added).toBe(2);
    expect((getCongressDataset()?.trades ?? []).filter((t) => t.symbol === "QQQ")).toHaveLength(2);

    const first = coerceCongressTrade({ ticker: "YYY", memberName: "Same Person", txType: "P", txDate: day, amountMin: 5, owner: "self" });
    const second = coerceCongressTrade({ ticker: "YYY", memberName: "Same Person", txType: "P", txDate: day, amountMin: 5, owner: "spouse" });
    expect(upsertCongressTrades([first!, second!]).added).toBe(1);
    expect((getCongressDataset()?.trades ?? []).filter((t) => t.symbol === "YYY")).toHaveLength(1);
  });

  it("mentions exchanges in the bulletin without counting them as buys or sells", () => {
    const exchange = coerceCongressTrade({ id: "ex-1", ticker: "EXCH", memberName: "Jane Doe", txType: "E", txDate: recent(1) });
    expect(exchange?.side).toBe("exchange");
    upsertCongressTrades([exchange!]);
    const sig = getCongressSignals(["EXCH"]).EXCH;
    expect(sig?.buyCount).toBe(0);
    expect(sig?.sellCount).toBe(0);
    expect(sig?.netSignal).toBe(0);
    expect(sig?.bulletin).toContain("1 exchange disclosure");
  });

  it("does not call an exchange-only window 'mixed activity' or emit dangling 'by '", () => {
    // Regression: buyCount===0 && sellCount===0 used to fall through to the mixed-activity
    // branch, which rendered `0 buy(s) by  vs 0 sell(s) by .` because names([]) is the empty
    // string. The existing test above only pinned the trailing exchange clause, so it passed
    // while the leading sentence stayed misleading.
    const exchange = coerceCongressTrade({ id: "ex-only-1", ticker: "EXONLY", memberName: "Jane Doe", txType: "E", txDate: recent(1) });
    upsertCongressTrades([exchange!]);
    const bulletin = getCongressSignals(["EXONLY"]).EXONLY?.bulletin ?? "";

    // Honest leading sentence, and no invented buy/sell direction.
    expect(bulletin).toContain("no member buy or sell disclosures for EXONLY");
    expect(bulletin).not.toContain("mixed activity");
    expect(bulletin).not.toMatch(/0 buy\(s\)/);
    expect(bulletin).not.toMatch(/0 sell\(s\)/);
    // The malformed "by  vs" / trailing "by ." shape must not come back.
    expect(bulletin).not.toMatch(/by\s+vs/);
    expect(bulletin).not.toMatch(/by\s*\./);
    // The real signal after the leading sentence must survive the fix.
    expect(bulletin).toContain("1 exchange disclosure");
  });

  it("rejects future-dated and impossible (rolled-over) trade dates", () => {
    // A future trade date is a data error even when a valid disclosure date is present — the row must
    // NOT slip in under the disclosure date.
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2030-01-01" })).toBeNull();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2030-01-01", disclosedAt: "2026-06-01" })).toBeNull();
    // Even a NEAR-future date (within saneIsoDate's ±3-day timestamp skew) is impossible for a
    // timezone-less trade date, so it's rejected too.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: tomorrow })).toBeNull();
    // Impossible calendar dates that Date.parse would roll over (Feb 30 -> Mar 2) are rejected.
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-02-30" })).toBeNull();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-04-31" })).toBeNull();
    // A real past date still passes through unchanged.
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-06-01" })?.tradedAt).toBe("2026-06-01");
  });

  it("skips option trades and very-low-confidence rows (App B is equity-only)", () => {
    expect(coerceCongressTrade({ ticker: "AAPL", txType: "P", txDate: "2026-06-01", isOption: true })).toBeNull();
    expect(coerceCongressTrade({ ticker: "AAPL", txType: "P", txDate: "2026-06-01", confidence: 0.1 })).toBeNull();
    expect(coerceCongressTrade({ ticker: "AAPL", txType: "P", txDate: "2026-06-01", confidence: 0.9 })?.symbol).toBe("AAPL");
  });
});

describe("applyCongressEvent — insider.update", () => {
  it("accepts a precomputed insiderSentiment scalar", () => {
    const res = applyCongressEvent({
      type: "insider.update",
      id: `evt-${randomUUID()}`,
      data: { ticker: "NVDA", insiderSentiment: 80, asOf: recent(1) }
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(1);
    const sig = getInsiderSignals(["NVDA"]).NVDA;
    expect(sig?.insiderSentiment).toBe(80);
  });

  it("accepts raw Form-4 filings", () => {
    const res = applyCongressEvent({
      type: "insider.update",
      id: `evt-${randomUUID()}`,
      data: {
        filings: [{ symbol: "AMD", accession: "0001-25-000001", buyTx: 3, sellTx: 1, filedAt: recent(2) }]
      }
    });
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(1);
  });
});

describe("applyCongressEvent — dedupe + other types", () => {
  it("dedupes by event id (idempotent re-send)", () => {
    const id = `evt-${randomUUID()}`;
    const ev = { type: "congress.trade", id, data: { trades: [{ symbol: "TSLA", member: "X", side: "buy", tradedAt: recent(1) }] } };
    expect(applyCongressEvent(ev).duplicate).toBeFalsy();
    expect(applyCongressEvent(ev)).toMatchObject({ duplicate: true, applied: 0 });
  });

  it("does not commit dedupe id if processing fails (e.g. unknown type)", () => {
    const id = `evt-${randomUUID()}`;
    const ev = { type: "mystery", id };
    expect(applyCongressEvent(ev)).toMatchObject({ ok: false, reason: "unknown-type" });
    const validEv = { type: "congress.trade", id, data: { trades: [{ symbol: "NFLX", member: "Y", side: "buy", tradedAt: recent(1) }] } };
    const res = applyCongressEvent(validEv);
    expect(res.ok).toBe(true);
    expect(res.duplicate).toBeFalsy();
    expect(res.applied).toBe(1);
    expect(applyCongressEvent(validEv)).toMatchObject({ duplicate: true, applied: 0 });
  });

  it("acknowledges ref/price/spx events as informational no-ops", () => {
    for (const type of ["ref.upsert", "price.eod", "spx.eod"]) {
      expect(applyCongressEvent({ type, id: `evt-${randomUUID()}`, data: {} })).toMatchObject({ ok: true, applied: 0, reason: "accepted-noop" });
    }
  });

  it("rejects unknown and invalid events", () => {
    expect(applyCongressEvent({ type: "mystery", id: `evt-${randomUUID()}` })).toMatchObject({ ok: false, reason: "unknown-type" });
    expect(applyCongressEvent(null)).toMatchObject({ ok: false, reason: "invalid-event" });
  });

  it("applyCongressEvents maps a batch", () => {
    const results = applyCongressEvents([
      { type: "ref.upsert", id: `evt-${randomUUID()}`, data: {} },
      { type: "mystery", id: `evt-${randomUUID()}` }
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
  });
});

describe("fetchAppACongressTrades — public feed with rolling from= window", () => {
  beforeEach(() => {
    deleteInternalSetting(CONGRESS_CURSOR_SETTING_KEY);
    deleteInternalSetting("webSource:congress:lastAttempt");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE;
  });

  it("sends a from= window bound and coerces App A rows (oldest-first feed)", async () => {
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          transactions: [
            {
              id: "test-1", docId: "doc-1", filerId: "filer-1", owner: "self", assetName: "Apple", assetType: "stock", isOption: false,
              capGainsOver200: false, rawText: "AAPL", confidence: 1, source: "primary", createdAt: new Date().toISOString(),
              cursorSeq: 1,
              ticker: "AAPL", memberName: "Jane Doe", chamber: "house", txType: "P", txDate: recent(3), amountMin: 1, amountMax: 2
            }
          ],
          count: 1,
          total: 1,
          limit: 100,
          cursor: 1
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    const trades = await fetchAppACongressTrades(Date.now()).catch(e => { console.error("fetchAppACongressTrades Error:", e); return []; });
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]).toMatchObject({ symbol: "AAPL", side: "buy", member: "Jane Doe", chamber: "house" });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("from="); // rolling-window bound is sent
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain("since=");
    expect(trades[0]?.id).toBe("test-1");
  });

  it("pages the first backfill with from, then from plus since", async () => {
    let calls = 0;
    const fetchSpy = vi.fn(async (_url: string) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          transactions: [{ id: "p1", ticker: "AAPL", txType: "P", txDate: recent(3), memberName: "Jane", cursorSeq: 9, confidence: 1, isOption: false }],
          cursor: 9
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ transactions: [], cursor: 9 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const trades = await fetchAppACongressTrades(Date.now());
    expect(trades).toHaveLength(1);
    const first = String(fetchSpy.mock.calls[0][0]);
    const second = String(fetchSpy.mock.calls[1][0]);
    expect(first).toContain("from=");
    expect(first).not.toContain("since=");
    expect(second).toContain("from=");
    expect(second).toContain("since=9");
  });

  it("uses since alone once a cursor is stored", async () => {
    setInternalSetting(CONGRESS_CURSOR_SETTING_KEY, 42);
    const fetchSpy = vi.fn(async (_url: string) => new Response(JSON.stringify({ transactions: [], cursor: 42 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const trades = await fetchAppACongressTrades(Date.now());
    expect(trades).toEqual([]);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("since=42");
    expect(url).not.toContain("from=");
  });

  it("stores the cursor after a successful refresh and keeps rows on an empty incremental poll", async () => {
    deleteInternalSetting("webSource:congress:dataset");
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    const row = {
      id: "keep-1", ticker: "AAPL", memberName: "Jane Doe", chamber: "house", txType: "P",
      txDate: recent(3), cursorSeq: 77, confidence: 1, isOption: false, owner: "self"
    };
    let phase: "backfill" | "incremental" = "backfill";
    const fetchSpy = vi.fn(async (url: string) => {
      const u = String(url);
      if (phase === "backfill") {
        if (u.includes("since=")) {
          return new Response(JSON.stringify({ transactions: [], cursor: 77 }), { status: 200 });
        }
        expect(u).toContain("from=");
        return new Response(JSON.stringify({ transactions: [row], cursor: 77 }), { status: 200 });
      }
      expect(u).toContain("since=77");
      expect(u).not.toContain("from=");
      return new Response(JSON.stringify({ transactions: [], cursor: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const first = await refreshCongress(Date.now(), true);
    expect(first.ok).toBe(true);
    expect(getInternalSetting<number>(CONGRESS_CURSOR_SETTING_KEY)).toBe(77);
    expect(getCongressDataset()?.trades.some((t) => t.id === "keep-1")).toBe(true);
    const fetchedAt = getCongressDataset()?.fetchedAt;
    phase = "incremental";
    const second = await refreshCongress(Date.now() + 1000, true);
    expect(second.ok).toBe(true);
    expect(getCongressDataset()?.trades.some((t) => t.id === "keep-1")).toBe(true);
    expect(getCongressDataset()?.fetchedAt).not.toBe(fetchedAt);
  });

  it("does not store a cursor when the feed errors", async () => {
    deleteInternalSetting("webSource:congress:dataset");
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const result = await refreshCongress(Date.now(), true);
    expect(result.ok).toBe(false);
    expect(getInternalSetting(CONGRESS_CURSOR_SETTING_KEY)).toBeUndefined();
  });
});

function sign(secret: string, bodyText: string) {
  return createHmac("sha256", secret).update(bodyText).digest("hex");
}

describe("webhook endpoint (POST)", () => {
  it("retains idempotency from DB even after memory cache reset (simulating restart/HMR)", () => {
    const id = `evt-${randomUUID()}`;
    const ev = { type: "ref.upsert", id, data: {} };
    expect(applyCongressEvent(ev).duplicate).toBeFalsy();
    resetCongressEventDedupe();
    expect(applyCongressEvent(ev)).toMatchObject({ duplicate: true, applied: 0 });
  });

  it("returns 429 after the per-IP rate limit is exceeded", async () => {
    const secret = useCongressWebhookSecret();
    const body = "{}";
    const headers = {
      "x-signature": sign(secret, body),
      "cf-connecting-ip": "203.0.113.99"
    };
    const { limit } = RATE_LIMITS.congressWebhook;
    for (let i = 0; i < limit; i++) {
      const res = await postCongressWebhook(
        new Request("https://b.example/api/webhooks/congress", { method: "POST", headers, body })
      );
      expect(res.status).not.toBe(429);
    }
    const blocked = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", { method: "POST", headers, body })
    );
    expect(blocked.status).toBe(429);
  });

  it("rejects unauthorized and oversized requests early", async () => {
    const secret = useCongressWebhookSecret();
    const resNoAuth = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", { method: "POST" })
    );
    expect(resNoAuth.status).toBe(401);

    const reqOversized = new Request("https://b.example/api/webhooks/congress", {
      method: "POST",
      headers: {
        "x-signature": sign(secret, "{}"),
        "content-length": String(10 * 1024 * 1024)
      }
    });
    const resOversized = await postCongressWebhook(reqOversized);
    expect(resOversized.status).toBe(413);
  });

  // ITEM 13 (bounded body): the pre-fix code trusted the declared content-length ALONE — a
  // missing/understated header (chunked transfer, or a lying client) sailed straight through to
  // an unbounded req.text() read. readBodyWithLimit aborts mid-stream on the ACTUAL byte count
  // regardless of any header, so this must still 413 even with no content-length header at all.
  it("rejects an actually-oversized body via the streaming cap even with NO content-length header", async () => {
    const secret = useCongressWebhookSecret();
    const bigBody = JSON.stringify({ padding: "a".repeat(6 * 1024 * 1024) });
    const req = new Request("https://b.example/api/webhooks/congress", {
      method: "POST",
      headers: { "x-signature": sign(secret, bigBody) },
      body: bigBody
    });
    expect(req.headers.get("content-length")).toBeNull(); // proves this exercises the stream path, not the header fast-path
    const res = await postCongressWebhook(req);
    expect(res.status).toBe(413);
  });

  it("accepts shared-package HMAC signatures with supported prefix forms", async () => {
    const secret = useCongressWebhookSecret();
    // An authenticated but invalid event returns 400; an auth failure returns 401. Using an
    // invalid event keeps this auth-only regression from writing a successful provider-health row.
    const body = `{"foo":"bar"}`;
    const signature = sign(secret, body);

    for (const signatureHeader of [signature, `sha256=${signature}`, `SHA256=${signature}`]) {
      const response = await postCongressWebhook(
        new Request("https://b.example/api/webhooks/congress", {
          method: "POST",
          headers: { "x-signature": signatureHeader, "content-type": "application/json" },
          body,
        })
      );
      expect(response.status).toBe(400);
    }
  });

  it("retains constant-time legacy bearer authentication and rejects a bad token", async () => {
    const secret = useCongressWebhookSecret();
    const body = `{"foo":"bar"}`;

    const accepted = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body,
      })
    );
    expect(accepted.status).toBe(400);

    const rejected = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body,
      })
    );
    expect(rejected.status).toBe(401);
  });

  it("rejects a mismatched shared-package HMAC signature", async () => {
    useCongressWebhookSecret();
    const body = JSON.stringify({ type: "ref.upsert", id: `evt-${randomUUID()}`, data: {} });
    const signature = sign("different-secret", body);
    const response = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", {
        method: "POST",
        headers: { "x-signature": `sha256=${signature}`, "content-type": "application/json" },
        body,
      })
    );
    expect(response.status).toBe(401);
  });

  it("records webhook health from the ingest result, not just successful authentication", async () => {
    const secret = useCongressWebhookSecret();
    const body = `{"foo":"bar"}`;
    const sig = sign(secret, body);

    const res = await postCongressWebhook(
      new Request("https://b.example/api/webhooks/congress", {
        method: "POST",
        headers: { "x-signature": sig, "content-type": "application/json" },
        body: body,
      })
    );

    expect(res.status).toBe(400);
    const summary = getServiceHealthSummaries().find((item) => item.service === "congress.trade:webhook");
    expect(summary?.lastFailureError).toBe("invalid-event");
    expect(summary?.lastSuccessTs).toBeNull();
  });
});
