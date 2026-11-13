import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/usage-monitor-push", () => ({
  recordProviderCall: vi.fn()
}));

vi.mock("../src/lib/web-sources/http", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/web-sources/http")>("../src/lib/web-sources/http");
  return { ...actual, politeFetch: vi.fn() };
});

import {
  AlpacaOptionsEnrichmentProvider,
  TradierOptionsEnrichmentProvider,
  clearKeylessOptionsCache
} from "../src/lib/keyless-options-enrichment";
import { recordProviderCall } from "../src/lib/usage-monitor-push";
import { politeFetch } from "../src/lib/web-sources/http";

const record = vi.mocked(recordProviderCall);
const fetchMock = vi.mocked(politeFetch);

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe("keyed options vendor fetches", () => {
  beforeEach(() => {
    clearKeylessOptionsCache();
    record.mockClear();
    fetchMock.mockReset();
    process.env.KEYLESS_OPTIONS_PACE_MS = "0";
  });

  it("labels a Tradier chain throw as options-chains", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ expirations: { date: ["2099-01-16"] } }))
      .mockRejectedValueOnce(new Error("chain timeout"));
    const out = await new TradierOptionsEnrichmentProvider("token", "https://sandbox.tradier.com").enrich(["AAPL"]);
    expect(out.AAPL).toEqual({});
    expect(record).toHaveBeenCalledWith(
      "tradier-options",
      expect.objectContaining({ service: "options-chains", ok: false })
    );
    expect(record).not.toHaveBeenCalledWith(
      "tradier-options",
      expect.objectContaining({ service: "options-expirations", ok: false })
    );
  });

  it("labels a Tradier expirations throw as options-expirations", async () => {
    fetchMock.mockRejectedValueOnce(new Error("exp timeout"));
    const out = await new TradierOptionsEnrichmentProvider("token", "https://sandbox.tradier.com").enrich(["AAPL"]);
    expect(out.AAPL).toEqual({});
    expect(record).toHaveBeenCalledWith(
      "tradier-options",
      expect.objectContaining({ service: "options-expirations", ok: false })
    );
  });

  it("uses a Tradier quote when the chain underlying field is only a ticker", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ expirations: { date: ["2099-01-16"] } }))
      .mockResolvedValueOnce(
        jsonResponse({
          underlying: "AAPL",
          options: {
            option: [
              { strike: 90, option_type: "call", volume: 10, greeks: { mid_iv: 0.5 } },
              { strike: 100, option_type: "call", volume: 20, greeks: { mid_iv: 0.22 } },
              { strike: 100, option_type: "put", volume: 10, greeks: { mid_iv: 0.24 } }
            ]
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ quotes: { quote: { last: 100 } } }));
    const out = await new TradierOptionsEnrichmentProvider("token", "https://sandbox.tradier.com").enrich(["AAPL"]);
    expect(out.AAPL?.nearTheMoneyIv).toBe(22);
    expect(record).toHaveBeenCalledWith("tradier-options", expect.objectContaining({ service: "quotes", ok: true }));
  });

  it("uses an Alpaca IEX snapshot when the options payload has no underlying price", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          snapshots: {
            AAPL261114C00090000: { impliedVolatility: 0.5, dailyBar: { v: 10 } },
            AAPL261114C00100000: { impliedVolatility: 0.22, dailyBar: { v: 100 } },
            AAPL261114P00100000: { impliedVolatility: 0.24, dailyBar: { v: 40 } }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ latestTrade: { p: 100 } }));
    const out = await new AlpacaOptionsEnrichmentProvider("key", "secret").enrich(["AAPL"]);
    expect(out.AAPL?.nearTheMoneyIv).toBe(22);
    expect(out.AAPL?.putCallRatio).toBe(0.36);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/v2/stocks/AAPL/snapshot");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("feed=iex");
  });

  it("uses the Alpaca last print for the underlying and ignores a daily bar close", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          snapshots: {
            AAPL261114C00100000: { impliedVolatility: 0.22, dailyBar: { v: 100 } },
            AAPL261114P00100000: { impliedVolatility: 0.24, dailyBar: { v: 40 } }
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          latestTrade: { p: 100, s: 12 },
          latestQuote: { ap: 101 },
          dailyBar: { c: 50, v: 12_000, o: 99 },
          prevDailyBar: { c: 40 }
        })
      );
    const out = await new AlpacaOptionsEnrichmentProvider("key", "secret").enrich(["AAPL"]);
    expect(out.AAPL?.nearTheMoneyIv).toBe(22);
    expect(out.AAPL?.putCallRatio).toBe(0.4);
  });
});
