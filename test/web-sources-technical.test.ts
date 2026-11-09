import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTechnicalSignals,
  parseStooqCsv,
  recordTradingViewSignal,
  refreshTechnical,
  setTechnicalWatchlist,
  verifyWebhookSecret
} from "../src/lib/web-sources/technical";
import { getSymbolWebSignals } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-technical-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  deleteInternalSetting("webSource:technical:dataset");
  deleteInternalSetting("webSource:technical:watchlist");
  deleteInternalSetting("webSource:technical:lastAttempt");
  delete process.env.WEB_SOURCE_TECHNICAL;
  delete process.env.TECHNICAL_SOURCE;
  delete process.env.WEB_SOURCE_TECHNICAL_TTL_MS;
  delete process.env.TRADINGVIEW_WEBHOOK_SECRET;
  // The computed producer pulls via fetchDailyOHLC; clear keyed sources so the mocked
  // free path (Yahoo) is exercised deterministically.
  delete process.env.TRADIER_API_KEY;
  delete process.env.MARKETSTACK_API_KEY;
  const { clearHistoryCache } = await import("../src/lib/history");
  clearHistoryCache();
});

afterEach(() => vi.unstubAllGlobals());

const TTL_MS = 36 * 60 * 60_000;

describe("verifyWebhookSecret", () => {
  it("rejects everything when no secret is configured (fails closed)", () => {
    expect(verifyWebhookSecret("anything")).toBe(false);
  });

  it("accepts only the exact configured secret", () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET = "s3cr3t-long-value";
    expect(verifyWebhookSecret("s3cr3t-long-value")).toBe(true);
    expect(verifyWebhookSecret("wrong")).toBe(false);
    expect(verifyWebhookSecret(undefined)).toBe(false);
  });
});

describe("recordTradingViewSignal (push producer)", () => {
  it("ingests a payload, surfaces it via the overlay, and dedups identical retries", () => {
    const now = Date.UTC(2026, 5, 18, 14, 0, 0);
    const payload = { symbol: "aapl", action: "bullish", signal: "sma50_200_golden_cross", price: 210.5, rsi: 58, tf: "1d", bar_time: now };
    const first = recordTradingViewSignal(payload, now);
    expect(first).toMatchObject({ ok: true, symbol: "AAPL" });
    expect(first.deduped).toBeFalsy();

    const sig = getTechnicalSignals(["AAPL"], now + 1000).AAPL;
    expect(sig).toMatchObject({ direction: "bullish", score: 70, source: "tradingview" });
    expect(sig.signals).toEqual(["sma50_200_golden_cross"]);

    // Overlay carries the technical read + a bulletin into the prompt path.
    const overlay = getSymbolWebSignals(["AAPL"], now + 1000).AAPL;
    expect(overlay?.technical?.direction).toBe("bullish");
    expect(overlay?.bulletins.some((b) => b.includes("Technical"))).toBe(true);

    // Identical retry is ignored.
    expect(recordTradingViewSignal(payload, now + 5000).deduped).toBe(true);
  });

  it("honors an explicit precomputed score and maps sell→bearish", () => {
    const now = Date.UTC(2026, 5, 18, 15, 0, 0);
    recordTradingViewSignal({ symbol: "tsla", action: "sell", signal: "macd_bear_cross", score: 22, bar_time: now }, now);
    const sig = getTechnicalSignals(["TSLA"], now + 1000).TSLA;
    expect(sig).toMatchObject({ direction: "bearish", score: 22 });
  });

  it("expires a signal past its TTL", () => {
    const now = Date.UTC(2026, 5, 18, 16, 0, 0);
    recordTradingViewSignal({ symbol: "nvda", action: "bullish", bar_time: now }, now);
    expect(getTechnicalSignals(["NVDA"], now + 1000).NVDA).toBeDefined();
    expect(getTechnicalSignals(["NVDA"], now + TTL_MS + 1).NVDA).toBeUndefined();
  });

  it("rejects a payload with no symbol", () => {
    expect(recordTradingViewSignal({ action: "bullish" }, Date.now())).toMatchObject({ ok: false });
  });
});

describe("refreshTechnical (computed producer)", () => {
  it("is a skipped no-op in tradingview push mode", async () => {
    process.env.TECHNICAL_SOURCE = "tradingview";
    const result = await refreshTechnical(Date.now(), { force: true });
    expect(result.skipped).toBe(true);
  });

  it("pulls OHLC, computes technicals, and persists in computed mode", async () => {
    process.env.TECHNICAL_SOURCE = "computed";
    const closes = Array.from({ length: 220 }, (_, i) => 100 + i * 0.5); // clean uptrend
    const ts = closes.map((_, i) => Math.floor(Date.UTC(2025, 0, 1) / 1000) + i * 86_400);
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("query1.finance.yahoo.com")) {
        return new Response(
          JSON.stringify({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: closes }] } }] } }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    });

    setTechnicalWatchlist(["AAA"]);
    const result = await refreshTechnical(Date.now(), { force: true });
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    expect(result.sources).toContain("computed");

    const sig = getTechnicalSignals(["AAA"]).AAA;
    expect(sig).toMatchObject({ direction: "bullish", source: "computed" });
    expect(sig.score).toBeGreaterThanOrEqual(60);
  });

  it("degrades to no records when the fetch yields nothing (never fabricates)", async () => {
    process.env.TECHNICAL_SOURCE = "computed";
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const result = await refreshTechnical(Date.now(), { symbols: ["BBB"], force: true });
    expect(result.ok).toBe(false);
    expect(getTechnicalSignals(["BBB"]).BBB).toBeUndefined();
  });
});

describe("parseStooqCsv", () => {
  it("parses daily rows and skips the header", () => {
    const csv = `Date,Open,High,Low,Close,Volume
2026-06-16,10,11,9,10.5,1000
2026-06-17,10.5,12,10,11.8,2000
bad,row,here`;
    const out = parseStooqCsv(csv);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ close: 10.5, time: "2026-06-16" });
    expect(out[1].close).toBe(11.8);
  });
});
