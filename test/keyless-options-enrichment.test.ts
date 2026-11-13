import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlpacaOptionsEnrichmentProvider,
  AlpacaStockSnapshotSchema,
  CboeOptionsEnrichmentProvider,
  CboeOptionsResponseSchema,
  TradierOptionsEnrichmentProvider,
  clearKeylessOptionsCache,
  keylessOptionsEnrichmentEnabled,
  metricsFromChainPayload,
  parseAlpacaOptionsSnapshots,
  parseCboeOptionsPayload,
  parseTradierOptionsChains,
  readAlpacaStockSnapshotPrice
} from "../src/lib/keyless-options-enrichment";

describe("keyless options parsers", () => {
  it("parses Cboe delayed options JSON into deriveOptionMetrics rows", () => {
    const json = {
      data: {
        current_price: 100,
        options: [
          { option: "AAPL261114C00100000", iv: 0.32, open_interest: 200, volume: 10 },
          { option: "AAPL261114P00100000", iv: 0.35, open_interest: 300, volume: 5 },
          { option: "AAPL261114C00200000", iv: 0.9, open_interest: 1, volume: 0 }
        ]
      }
    };
    const payload = parseCboeOptionsPayload(json);
    expect(payload.underlyingPrice).toBe(100);
    const metrics = metricsFromChainPayload(payload);
    expect(metrics.nearTheMoneyIv).toBe(32);
    expect(metrics.putCallRatio).toBe(1.5);
  });

  it("parses Alpaca indicative snapshots", () => {
    const json = {
      snapshots: {
        AAPL261114C00100000: {
          greeks: { implied_volatility: 0.28 },
          open_interest: 150,
          volume: 20
        },
        AAPL261114P00100000: {
          greeks: { implied_volatility: 0.3 },
          open_interest: 75,
          volume: 10
        }
      }
    };
    const metrics = metricsFromChainPayload(parseAlpacaOptionsSnapshots(json, 100));
    expect(metrics.nearTheMoneyIv).toBe(28);
    expect(metrics.putCallRatio).toBe(0.5);
  });

  it("reads Alpaca root impliedVolatility, dailyBar volume, and embedded underlying price", () => {
    const json = {
      underlyingAssetPrice: 100,
      snapshots: {
        AAPL261114C00090000: { impliedVolatility: 0.5, dailyBar: { v: 10 } },
        AAPL261114C00100000: { impliedVolatility: 0.22, dailyBar: { v: 100 } },
        AAPL261114P00100000: { impliedVolatility: 0.24, dailyBar: { v: 40 } },
        AAPL261114C00200000: { impliedVolatility: 0.9, dailyBar: { v: 5 } }
      }
    };
    const payload = parseAlpacaOptionsSnapshots(json);
    expect(payload.underlyingPrice).toBe(100);
    const metrics = metricsFromChainPayload(payload);
    // ATM strike 100 (IV 0.22), not the median of 0.22/0.24/0.5/0.9.
    expect(metrics.nearTheMoneyIv).toBe(22);
    // ±20% of 100 keeps strikes 90 and 100.  Put volume 40 / call volume 110.
    expect(metrics.putCallRatio).toBe(0.36);
  });

  it("parses Tradier option chains with greeks", () => {
    const json = {
      options: {
        option: [
          {
            strike: 100,
            option_type: "call",
            open_interest: 400,
            volume: 50,
            greeks: { mid_iv: 0.31 }
          },
          {
            strike: 100,
            option_type: "put",
            open_interest: 200,
            volume: 30,
            greeks: { mid_iv: 0.33 }
          }
        ]
      }
    };
    const metrics = metricsFromChainPayload(parseTradierOptionsChains(json, 100));
    expect(metrics.nearTheMoneyIv).toBe(31);
    expect(metrics.putCallRatio).toBe(0.5);
  });

  it("reads Tradier underlying_price and ignores an underlying ticker string", () => {
    const chain = {
      options: {
        option: {
          strike: 100,
          option_type: "call",
          open_interest: 10,
          volume: 4,
          greeks: { mid_iv: 0.2 },
          underlying: "AAPL"
        }
      },
      underlying: "AAPL"
    };
    expect(parseTradierOptionsChains(chain).underlyingPrice).toBeUndefined();
    expect(parseTradierOptionsChains({ ...chain, underlying_price: 100 }).underlyingPrice).toBe(100);
    const atm = metricsFromChainPayload(parseTradierOptionsChains({ ...chain, underlying_price: 100 }));
    expect(atm.nearTheMoneyIv).toBe(20);
  });

  it("keeps extra Cboe envelope keys and still reads current_price", () => {
    const json = {
      timestamp: "2026-10-14",
      data: {
        symbol: "AAPL",
        current_price: 100,
        options: [{ option: "AAPL261114C00100000", iv: 0.22, extra: 1 }]
      }
    };
    expect(CboeOptionsResponseSchema.safeParse(json).success).toBe(true);
    const payload = parseCboeOptionsPayload(json);
    expect(payload.underlyingPrice).toBe(100);
    expect(metricsFromChainPayload(payload).nearTheMoneyIv).toBe(22);
  });

  it("reads Alpaca IEX price from a partial snapshot with extra keys", () => {
    const json = {
      latestQuote: { ap: 101, bp: 99 },
      minuteBar: { c: 100.5 },
      dailyBar: { t: "2026-10-14", o: 99, h: 102, l: 98, c: 100, v: 1_000 }
    };
    expect(AlpacaStockSnapshotSchema.safeParse(json).success).toBe(true);
    expect(readAlpacaStockSnapshotPrice(json)).toBe(100);
    expect(readAlpacaStockSnapshotPrice({ latestTrade: { p: 101, s: 10 } })).toBe(101);
    expect(readAlpacaStockSnapshotPrice({ latestTrade: { p: 101, s: 10 } })).not.toBe(10);
    expect(readAlpacaStockSnapshotPrice({ prevDailyBar: { c: 99 } })).toBeUndefined();
    expect(readAlpacaStockSnapshotPrice({ dailyBar: { c: 100 }, latestQuote: { bp: 99 } })).toBeUndefined();
  });
});

describe("CboeOptionsEnrichmentProvider", () => {
  beforeEach(() => {
    clearKeylessOptionsCache();
    delete process.env.KEYLESS_OPTIONS_ENRICHMENT_ENABLED;
    delete process.env.KEYLESS_OPTIONS_PACE_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearKeylessOptionsCache();
  });

  it("is enabled by default", () => {
    expect(keylessOptionsEnrichmentEnabled()).toBe(true);
  });

  it("joins the enrichment cascade by default", async () => {
    const provider = (await import("../src/lib/data-providers")).getEnrichmentProvider();
    expect(provider.name).toContain("cboe-options");
  });

  it("keeps Cboe free and seats Alpaca and Tradier as keyed Wave B fallbacks", () => {
    expect(new CboeOptionsEnrichmentProvider().costTier).toBe("free");
    expect(new AlpacaOptionsEnrichmentProvider("k", "s").costTier).toBe("paid");
    expect(new TradierOptionsEnrichmentProvider("t", "https://sandbox.tradier.com").costTier).toBe("paid");
  });

  it("fetches and caches per symbol", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            current_price: 50,
            options: [
              { option: "XYZ261114C00050000", iv: 0.4, open_interest: 10, volume: 1 },
              { option: "XYZ261114P00050000", iv: 0.42, open_interest: 20, volume: 2 }
            ]
          }
        })
      }))
    );
    process.env.KEYLESS_OPTIONS_PACE_MS = "0";
    const out = await new CboeOptionsEnrichmentProvider().enrich(["XYZ"]);
    expect(out.XYZ.nearTheMoneyIv).toBe(40);
    expect(out.XYZ.putCallRatio).toBe(2);
    const cached = await new CboeOptionsEnrichmentProvider().enrich(["XYZ"]);
    expect(cached.XYZ.nearTheMoneyIv).toBe(40);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("negative-caches an empty chain so the next enrich does not refetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { current_price: 50, options: [] } })
      }))
    );
    process.env.KEYLESS_OPTIONS_PACE_MS = "0";
    const first = await new CboeOptionsEnrichmentProvider().enrich(["XYZ"]);
    expect(first.XYZ).toEqual({});
    const second = await new CboeOptionsEnrichmentProvider().enrich(["XYZ"]);
    expect(second.XYZ).toEqual({});
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe("source capability matrix options lanes", () => {
  it("lists Cboe before Alpaca and Tradier for nearTheMoneyIv", async () => {
    const { sourcesFor } = await import("../src/lib/source-capability-matrix");
    const ids = sourcesFor("nearTheMoneyIv").map((r) => r.sourceId);
    expect(ids[0]).toBe("cboe-options");
    expect(ids).toContain("alpaca-options");
    expect(ids).toContain("tradier-options");
  });
});

describe("enrichment coverage options fields", () => {
  it("tracks options metrics as specialty coverage fields", async () => {
    const { COVERAGE_OPTIONS_METRICS_FIELDS, COVERAGE_TRACKED_FIELDS } = await import(
      "../src/lib/enrichment-coverage"
    );
    expect(COVERAGE_OPTIONS_METRICS_FIELDS).toEqual(["nearTheMoneyIv", "putCallRatio"]);
    for (const field of COVERAGE_OPTIONS_METRICS_FIELDS) {
      expect(COVERAGE_TRACKED_FIELDS).toContain(field);
    }
  });
});
