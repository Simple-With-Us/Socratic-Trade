// Per-symbol coverage-narrowing for quota-scarce enrichment providers.
//
// The cascade dispatches every registered provider concurrently against the FULL symbol batch;
// registration order only decides which value wins the first-wins merge, not whether a later
// provider's network call happens at all. That is fine for free/cheap providers but self-defeating
// for the RapidAPI failover tier, where YH Finance 15's real cap is 100 requests per MONTH.
//
// These tests pin the wave-two gate: a provider that declares `quotaScarce` + `suppliesFields` runs
// only after wave one settles, only over the symbols still missing one of its declared fields, and
// reserves no quota at all when it is skipped.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CascadingEnrichmentProvider,
  SteadyApiEnrichmentProvider,
  clearEnrichmentCache,
  scarceEnrichmentGateEnabled,
  type MarketEnrichmentProvider,
  type SymbolEnrichment
} from "../src/lib/data-providers";
import { __resetRapidApiQuotaForTests, tryReserveRapidApiCalls } from "../src/lib/rapidapi-quota";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scarce-gate-${randomUUID()}.db`)}`;
  process.env.API_CIRCUIT_BREAKER_DISABLED = "1";
  process.env.PROVIDER_RATE_LIMIT_DISABLED = "1";
});

beforeEach(() => {
  __resetRapidApiQuotaForTests();
  clearEnrichmentCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED;
  delete process.env.PROVIDER_QUOTA_MBOUM_PER_DAY;
  delete process.env.PROVIDER_QUOTA_RAPIDAPI_COMBINED_PER_DAY;
});

/** A free wave-one provider that returns canned data. */
function freeStub(name: string, data: Record<string, SymbolEnrichment>): MarketEnrichmentProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    calls,
    async enrich(symbols: string[]) {
      calls.push([...symbols]);
      return data;
    }
  };
}

/** A wave-one provider that always throws (timeout/500/parse blowup). */
function throwingStub(name: string): MarketEnrichmentProvider {
  return {
    name,
    configured: true,
    async enrich(): Promise<Record<string, SymbolEnrichment>> {
      throw new Error("upstream exploded");
    }
  };
}

/** A quota-scarce provider that records exactly which symbols it was dispatched against. */
function scarceStub(
  name: string,
  suppliesFields: readonly (keyof SymbolEnrichment)[],
  data: Record<string, SymbolEnrichment> = {}
): MarketEnrichmentProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name,
    configured: true,
    quotaScarce: true,
    suppliesFields,
    calls,
    async enrich(symbols: string[]) {
      calls.push([...symbols]);
      return data;
    }
  };
}

describe("scarceEnrichmentGateEnabled", () => {
  it("defaults ON when the env var is unset or blank", () => {
    delete process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED;
    expect(scarceEnrichmentGateEnabled()).toBe(true);
    process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED = "   ";
    expect(scarceEnrichmentGateEnabled()).toBe(true);
  });

  it("can be turned off explicitly", () => {
    process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED = "0";
    expect(scarceEnrichmentGateEnabled()).toBe(false);
  });
});

describe("cascade wave-two gate for quota-scarce providers", () => {
  // (a) fully covered → never called at all.
  it("does NOT call a scarce provider when wave one covered every field for every symbol", async () => {
    const yahoo = freeStub("yahoo-finance", {
      AAPL: { sector: "Technology", industry: "Consumer Electronics", price: 200 },
      MSFT: { sector: "Technology", industry: "Software", price: 400 }
    });
    const scarce = scarceStub("yahoo-finance15", ["sector", "industry", "price"], {
      AAPL: { sector: "Wrong" },
      MSFT: { sector: "Wrong" }
    });
    const cascade = new CascadingEnrichmentProvider([yahoo, scarce]);
    const result = await cascade.enrich(["AAPL", "MSFT"]);

    expect(scarce.calls).toEqual([]);
    expect(result.AAPL?.sector).toBe("Technology");
    expect(cascade.activeSources).toEqual(["yahoo-finance"]);
  });

  // (b) partial gaps → called with EXACTLY the uncovered subset.
  it("calls a scarce provider with exactly the symbols that still have a gap", async () => {
    const yahoo = freeStub("yahoo-finance", {
      AAPL: { sector: "Technology", industry: "Consumer Electronics", price: 200 },
      // MSFT is missing `industry`; NVDA is absent from wave one entirely.
      MSFT: { sector: "Technology", price: 400 }
    });
    const scarce = scarceStub("yahoo-finance15", ["sector", "industry", "price"], {
      MSFT: { industry: "Software-Infrastructure" },
      NVDA: { sector: "Technology", industry: "Semiconductors", price: 900 }
    });
    const cascade = new CascadingEnrichmentProvider([yahoo, scarce]);
    const result = await cascade.enrich(["AAPL", "MSFT", "NVDA"]);

    expect(scarce.calls).toHaveLength(1);
    expect(scarce.calls[0]).toEqual(["MSFT", "NVDA"]);
    // Wave one still saw the full batch — no latency/coverage regression for free providers.
    expect(yahoo.calls[0]).toEqual(["AAPL", "MSFT", "NVDA"]);
    // The gap is filled, and the free source's overlapping values are untouched.
    expect(result.MSFT?.industry).toBe("Software-Infrastructure");
    expect(result.MSFT?.sector).toBe("Technology");
    expect(result.NVDA?.industry).toBe("Semiconductors");
    expect(result.AAPL?.sector).toBe("Technology");
  });

  it("treats an empty array (e.g. headlines: []) as NOT covered", async () => {
    const yahoo = freeStub("yahoo-finance", { AAPL: { headlines: [] } });
    const scarce = scarceStub("mboum-finance", ["headlines"], { AAPL: { headlines: ["real news"] } });
    const cascade = new CascadingEnrichmentProvider([yahoo, scarce]);
    const result = await cascade.enrich(["AAPL"]);

    expect(scarce.calls[0]).toEqual(["AAPL"]);
    expect(result.AAPL?.headlines).toEqual(["real news"]);
  });

  // (c) a wave-one failure must not suppress the failover tier.
  it("still runs the scarce tier when a wave-one provider throws", async () => {
    const broken = throwingStub("finnhub");
    const scarce = scarceStub("mboum-finance", ["sector", "price"], { AAPL: { sector: "Technology", price: 200 } });
    const cascade = new CascadingEnrichmentProvider([broken, scarce]);
    const result = await cascade.enrich(["AAPL"]);

    expect(scarce.calls[0]).toEqual(["AAPL"]);
    expect(result.AAPL?.sector).toBe("Technology");
    expect(result.AAPL?.price).toBe(200);
  });

  it("does not let a LATER-throwing wave-one provider mask a gap it never filled", async () => {
    // Wave one: one provider fills `sector`, another (which would have filled `price`) throws.
    // `price` must still read as uncovered so the scarce tier is dispatched for it.
    const ok = freeStub("yahoo-finance", { AAPL: { sector: "Technology" } });
    const broken = throwingStub("alpaca-snapshot");
    const scarce = scarceStub("mboum-finance", ["sector", "price"], { AAPL: { price: 200 } });
    const cascade = new CascadingEnrichmentProvider([ok, broken, scarce]);
    const result = await cascade.enrich(["AAPL"]);

    expect(scarce.calls[0]).toEqual(["AAPL"]);
    expect(result.AAPL?.price).toBe(200);
    expect(result.AAPL?.sector).toBe("Technology");
  });

  it("keeps registration-order first-wins precedence for a scarce provider that DOES run", async () => {
    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology" } });
    const scarce = scarceStub("mboum-finance", ["sector", "price"], { AAPL: { sector: "Wrong", price: 200 } });
    const cascade = new CascadingEnrichmentProvider([yahoo, scarce]);
    const result = await cascade.enrich(["AAPL"]);

    expect(result.AAPL?.sector).toBe("Technology");
    expect(result.AAPL?.price).toBe(200);
    expect(cascade.activeSources).toEqual(["yahoo-finance", "mboum-finance"]);
  });

  it("passes the wave-one coverage set to the scarce provider as an EnrichmentContext hint", async () => {
    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology" } });
    let seen: ReadonlySet<string> | undefined;
    const scarce: MarketEnrichmentProvider = {
      name: "mboum-finance",
      configured: true,
      quotaScarce: true,
      suppliesFields: ["sector", "price"],
      async enrich(symbols, context) {
        seen = context?.coveredFields?.[symbols[0]];
        return {};
      }
    };
    await new CascadingEnrichmentProvider([yahoo, scarce]).enrich(["AAPL"]);
    expect(seen?.has("sector")).toBe(true);
    expect(seen?.has("price")).toBe(false);
  });

  it("leaves a scarce provider ungated (wave one, full batch) when it declares no suppliesFields", async () => {
    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology" }, MSFT: { sector: "Technology" } });
    const scarce: MarketEnrichmentProvider & { calls: string[][] } = {
      name: "mystery",
      configured: true,
      quotaScarce: true,
      calls: [],
      async enrich(symbols: string[]) {
        (this as { calls: string[][] }).calls.push([...symbols]);
        return {};
      }
    };
    await new CascadingEnrichmentProvider([yahoo, scarce]).enrich(["AAPL", "MSFT"]);
    // Fails OPEN: an under-declared provider still runs rather than silently never running.
    expect(scarce.calls[0]).toEqual(["AAPL", "MSFT"]);
  });

  it("restores the old single-wave behavior when the gate is switched off", async () => {
    process.env.ENRICHMENT_SCARCE_TIER_GATE_ENABLED = "0";
    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology" }, MSFT: { sector: "Technology" } });
    const scarce = scarceStub("yahoo-finance15", ["sector"], {});
    await new CascadingEnrichmentProvider([yahoo, scarce]).enrich(["AAPL", "MSFT"]);
    expect(scarce.calls[0]).toEqual(["AAPL", "MSFT"]);
  });
});

// (d) The real provider: a skipped call must cost ZERO persisted quota.
describe("wave-two gate against the real SteadyApiEnrichmentProvider", () => {
  const buildMboum = () =>
    new SteadyApiEnrichmentProvider("mboum-finance", "mboum-finance.p.rapidapi.com", "", "symbol", "symbol", false, "test-key", "env");

  it("issues no request and reserves no quota when wave one covered every field", async () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "5";
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const yahoo = freeStub("yahoo-finance", {
      AAPL: {
        price: 200,
        intradayChangePct: 1.1,
        volume: 1_000_000,
        companyName: "Apple Inc.",
        fiftyTwoWeekHigh: 260,
        fiftyTwoWeekLow: 160,
        sector: "Technology",
        industry: "Consumer Electronics"
      }
    });
    await new CascadingEnrichmentProvider([yahoo, buildMboum()]).enrich(["AAPL"]);

    expect(fetchCount).toBe(0);
    // The full daily allowance is still available — nothing was reserved (and therefore nothing
    // needed refunding, so no double-count either).
    expect(tryReserveRapidApiCalls("mboum-finance", 5)).toBe(5);
  });

  it("does spend quota when there IS a gap", async () => {
    process.env.PROVIDER_QUOTA_MBOUM_PER_DAY = "5";
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount++;
      return new Response(
        JSON.stringify({ body: { symbol: "AAPL", companyName: "Apple Inc.", primaryData: { lastSalePrice: "$200.00" } } }),
        { status: 200 }
      );
    });

    const yahoo = freeStub("yahoo-finance", { AAPL: { sector: "Technology", industry: "Consumer Electronics" } });
    const result = await new CascadingEnrichmentProvider([yahoo, buildMboum()]).enrich(["AAPL"]);

    expect(fetchCount).toBeGreaterThan(0);
    expect(result.AAPL?.price).toBe(200);
    // Some of the 5-call allowance is now spent.
    expect(tryReserveRapidApiCalls("mboum-finance", 5)).toBeLessThan(5);
  });
});
