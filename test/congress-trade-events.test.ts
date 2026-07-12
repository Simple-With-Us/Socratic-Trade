import { randomUUID, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyCongressEvent,
  applyCongressEvents,
  resetCongressEventDedupe
} from "../src/lib/congress-trade-events";
import { verifyCongressWebhookSignature } from "../src/lib/congress-webhook-auth";
import { getServiceHealthSummaries } from "../src/lib/db-health";
import { coerceCongressTrade, fetchAppACongressTrades } from "../src/lib/web-sources/congress";
import { getCongressDataset, getInsiderSignals, getSymbolWebSignals } from "../src/lib/web-sources";
import { POST as postCongressWebhook } from "../app/api/webhooks/congress/route";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-congress-events-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetCongressEventDedupe();
  delete process.env.CONGRESS_WEBHOOK_SECRET;
});

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

  it("rejects non-P/S txTypes and unparseable dates at ingestion", () => {
    expect(coerceCongressTrade({ ticker: "T", txType: "E", txDate: "2026-06-01" })).toBeNull(); // exchange code ignored
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "not-a-date" })).toBeNull();
    expect(coerceCongressTrade({ ticker: "T", txType: "P", txDate: "2026-13-45" })).toBeNull();
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
            { ticker: "AAPL", memberName: "Jane Doe", chamber: "house", txType: "P", txDate: recent(3), amountMin: 1, amountMax: 2 }
          ],
          cursor: 1
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);
    const trades = await fetchAppACongressTrades(Date.now());
    expect(trades.length).toBeGreaterThanOrEqual(1);
    expect(trades[0]).toMatchObject({ symbol: "AAPL", side: "buy", member: "Jane Doe", chamber: "house" });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("from="); // rolling-window bound is sent
  });
});

function sign(secret: string, bodyText: string) {
  return createHmac("sha256", secret).update(bodyText).digest("hex");
}

describe("verifyCongressWebhookSignature", () => {
  const reqWith = (sig?: string) => new Request("https://b.example/api/webhooks/congress", sig ? { headers: { "x-signature": sig } } : undefined);

  it("rejects when no secret is configured", () => {
    expect(verifyCongressWebhookSignature(reqWith("anything"), "{}")).toBe(false);
  });

  it("accepts the correct signature and rejects others", () => {
    process.env.CONGRESS_WEBHOOK_SECRET = "s3cr3t";
    const body = `{"foo":"bar"}`;
    const sig = sign("s3cr3t", body);

    expect(verifyCongressWebhookSignature(reqWith(sig), body)).toBe(true);
    expect(verifyCongressWebhookSignature(reqWith("wrong"), body)).toBe(false);
    expect(verifyCongressWebhookSignature(reqWith(undefined), body)).toBe(false);
    expect(verifyCongressWebhookSignature(reqWith(sig), "{}")).toBe(false);
  });

  it("records webhook health from the ingest result, not just successful authentication", async () => {
    process.env.CONGRESS_WEBHOOK_SECRET = "s3cr3t";
    const body = `{"foo":"bar"}`;
    const sig = sign("s3cr3t", body);

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
