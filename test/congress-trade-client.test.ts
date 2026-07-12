import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appAClosesToBars,
  getAppABundle,
  getAppAPrices,
  getAppARef,
  getAppARefs,
  getAppASpx,
  getAppATransactions
} from "../src/lib/congress-trade-client";

beforeEach(() => {
  delete process.env.CONGRESS_TRADE_READS_ENABLED;
  delete process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE;
  delete process.env.CONGRESS_TRADE_READ_TOKEN;
  delete process.env.CONGRESS_TRADE_BASE_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("congress-trade-client gating (default OFF)", () => {
  it("does not call fetch and returns empty when reads are disabled", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await getAppABundle("AAPL")).toBeNull();
    expect(await getAppARef("AAPL")).toBeNull();
    expect(await getAppAPrices("AAPL")).toBeNull();
    expect(await getAppARefs(["AAPL"])).toEqual([]);
    expect(await getAppASpx()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gates /api/transactions on the congress-source flag, independent of reads", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.CONGRESS_TRADE_READS_ENABLED = "on"; // market reads on, but...
    expect(await getAppATransactions()).toBeNull(); // ...transactions still gated off
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("congress-trade-client reads (enabled)", () => {
  beforeEach(() => {
    process.env.CONGRESS_TRADE_READS_ENABLED = "on";
    process.env.CONGRESS_TRADE_BASE_URL = "https://congress.trade/";
  });

  it("fetches a bundle and normalizes the URL + shape", async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ref: { ticker: "AAPL", sector: "Tech" }, prices: { ticker: "AAPL", closes: [{ date: "2026-06-15", close: 210 }] }, spx: [{ date: "2026-06-15", close: 5400 }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const bundle = await getAppABundle("aapl");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://congress.trade/api/market/bundle/AAPL");
    expect(bundle?.ref?.ticker).toBe("AAPL");
    expect(bundle?.prices?.closes).toHaveLength(1);
    expect(bundle?.spx).toHaveLength(1);
  });

  it("sends a bearer read token when configured", async () => {
    process.env.CONGRESS_TRADE_READ_TOKEN = "read-tok";
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ closes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await getAppASpx();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: "Bearer read-tok" });
  });

  it("returns null on a non-2xx without throwing (falls through)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    expect(await getAppAPrices("AAPL")).toBeNull();
  });

  it("returns null on a transport error without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await getAppARef("AAPL")).toBeNull();
  });

  it("caps the refs request to 500 tickers", async () => {
    const fetchSpy = vi.fn(async (_url: string) => new Response(JSON.stringify({ refs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const many = Array.from({ length: 600 }, (_, i) => `T${i}`);
    await getAppARefs(many);
    const url = fetchSpy.mock.calls[0][0] as string;
    const tickers = decodeURIComponent(url.split("tickers=")[1]).split(",");
    expect(tickers).toHaveLength(500);
  });

  it("pulls the public transactions feed without leaking the push/ingest token", async () => {
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    process.env.CONGRESS_TRADE_TOKEN = "push-tok"; // write token must NOT ride along on the public read
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ transactions: [{ ticker: "AAPL" }], cursor: "c2" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const page = await getAppATransactions({ limit: 5 });
    expect(page?.transactions).toHaveLength(1);
    expect(page?.cursor).toBe("c2");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty("authorization");
    delete process.env.CONGRESS_TRADE_TOKEN;
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
