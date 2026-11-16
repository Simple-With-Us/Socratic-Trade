import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appAClosesToBars,
  congressReadsEnabled,
  congressFundamentalsEnabled,
  congressAsCongressSourceEnabled,
  congressAnalyticsEnabled,
  getCongressTradeClient,
  resetCongressTradeClientForTests,
} from "../src/lib/api-clients/congress";
import * as dbHealth from "../src/lib/db-health";
import { PEER_LANE_CONGRESS_TRADE, recordPeerLaneSample, resetPeerLaneBackoffForTests } from "../src/lib/peer-lane-backoff";

beforeEach(() => {
  delete process.env.CONGRESS_TRADE_READS_ENABLED;
  delete process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED;
  delete process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE;
  delete process.env.CONGRESS_ANALYTICS_ENABLED;
  delete process.env.CONGRESS_TRADE_READ_TOKEN;
  delete process.env.CONGRESS_TRADE_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetCongressTradeClientForTests();
  resetPeerLaneBackoffForTests();
});

describe("api-clients/congress gating flags", () => {
  it("defaults: fundamentals off (multi-source cascade); congress-source/analytics on", () => {
    expect(congressReadsEnabled()).toBe(false);
    expect(congressFundamentalsEnabled()).toBe(false);
    expect(congressAsCongressSourceEnabled()).toBe(true);
    expect(congressAnalyticsEnabled()).toBe(true);
  });

  it("parses true/1/on", () => {
    process.env.CONGRESS_TRADE_READS_ENABLED = "1";
    process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED = "true";
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    process.env.CONGRESS_ANALYTICS_ENABLED = "yes";

    expect(congressReadsEnabled()).toBe(true);
    expect(congressFundamentalsEnabled()).toBe(true);
    expect(congressAsCongressSourceEnabled()).toBe(true);
    expect(congressAnalyticsEnabled()).toBe(true);
  });

  it("explicit off disables default-on flags", () => {
    process.env.CONGRESS_TRADE_FUNDAMENTALS_ENABLED = "off";
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "0";
    process.env.CONGRESS_ANALYTICS_ENABLED = "false";
    expect(congressFundamentalsEnabled()).toBe(false);
    expect(congressAsCongressSourceEnabled()).toBe(false);
    expect(congressAnalyticsEnabled()).toBe(false);
  });
});

describe("getCongressTradeClient wrapper", () => {
  beforeEach(() => {
    process.env.CONGRESS_TRADE_BASE_URL = "https://congress.trade/";
  });

  it("injects auth token and delegates to shared client", async () => {
    process.env.CONGRESS_TRADE_READ_TOKEN = "read-tok";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ closes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = getCongressTradeClient();
    // Use an endpoint that requires fetch
    await client.getSpx();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer read-tok" });
  });

  it("logs api health on success", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ closes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const logSpy = vi.spyOn(dbHealth, "logApiHealth").mockImplementation(() => {});

    const client = getCongressTradeClient();
    await client.getSpx();

    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      service: "congress.trade",
      ok: true,
      errorText: undefined
    }));
  });

  it("throws on 502 so gather can fail-open the rest of the batch", async () => {
    const fetchSpy = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = getCongressTradeClient();
    await expect(client.getSpx()).rejects.toThrow(/HTTP 502/);
  });

  it("does not rewrite a 404 into a latching 5xx", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ closes: [] }), { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = getCongressTradeClient();
    try {
      await client.getSpx();
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).not.toMatch(/HTTP 429|HTTP 50[0-9]/);
    }
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("logs api health and throws on non-2xx", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("Internal Server Error", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const logSpy = vi.spyOn(dbHealth, "logApiHealth").mockImplementation(() => {});

    const client = getCongressTradeClient();
    await expect(client.getSpx()).rejects.toThrow();

    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      service: "congress.trade",
      ok: false,
      errorText: "HTTP 500"
    }));
  });

  it("logs api health and throws on transport failure", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => { throw new Error("Network down"); });
    vi.stubGlobal("fetch", fetchSpy);
    const logSpy = vi.spyOn(dbHealth, "logApiHealth").mockImplementation(() => {});

    const client = getCongressTradeClient();
    await expect(client.getSpx()).rejects.toThrow();

    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      service: "congress.trade",
      ok: false,
      errorText: "Network down",
      soft: true,
    }));
  });

  it("fails fast without a network call when the congress.trade p50 is already slow (#2550)", async () => {
    recordPeerLaneSample(PEER_LANE_CONGRESS_TRADE, 11000);
    recordPeerLaneSample(PEER_LANE_CONGRESS_TRADE, 12000);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ closes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const client = getCongressTradeClient();
    await expect(client.getSpx()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("appAClosesToBars", () => {
  it("maps to close-only bars, drops invalid, sorts ascending", () => {
    expect(
      appAClosesToBars([
        { date: "2026-06-16", close: 101 },
        { date: "2026-06-15", close: 100 },
        { date: "2026-06-17", close: NaN }
      ])
    ).toEqual([
      { time: "2026-06-15", close: 100 },
      { time: "2026-06-16", close: 101 }
    ]);
    expect(appAClosesToBars(null)).toEqual([]);
  });

  it("carries volume into bars when App A provides it", () => {
    expect(appAClosesToBars([{ date: "2026-06-15", close: 100, volume: 5000 }])).toEqual([
      { time: "2026-06-15", close: 100, volume: 5000 }
    ]);
  });
});
