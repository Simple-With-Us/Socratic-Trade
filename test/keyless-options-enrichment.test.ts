import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CboeOptionsEnrichmentProvider,
  clearKeylessOptionsCache,
  keylessOptionsEnrichmentEnabled,
  metricsFromChainPayload,
  parseAlpacaOptionsSnapshots,
  parseCboeOptionsPayload,
  parseTradierOptionsChains
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
