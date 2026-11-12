import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateCongressSignals,
  parseAmountRange,
  parseApifyCongress,
  parseCapitolTradesBff,
  parseEfdReportRows,
  parsePtrTransactions,
  refreshCongress
} from "../src/lib/web-sources/congress";
import { getSymbolWebSignals } from "../src/lib/web-sources";
import type { CongressTrade } from "../src/lib/web-sources/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-websrc-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  deleteInternalSetting("webSource:congress:dataset");
  deleteInternalSetting("webSource:congress:lastAttempt");
  delete process.env.WEB_SOURCE_CONGRESS;
  delete process.env.WEB_SOURCE_CONGRESS_TTL_MS;
  delete process.env.WEB_SOURCE_RETRY_BACKOFF_MS;
  // Scraper-path tests need App A default-OFF so senate-efd / Apify mocks run.
  process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "off";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("congress pure parsers", () => {
  it("parses disclosed dollar ranges", () => {
    expect(parseAmountRange("$1,001 - $15,000")).toEqual({ amountLow: 1001, amountHigh: 15000 });
    expect(parseAmountRange("$50,000")).toEqual({ amountLow: 50000, amountHigh: 50000 });
    expect(parseAmountRange("--")).toEqual({});
  });

  it("parses eFD report rows and flags PTR vs paper filings", () => {
    const json = {
      data: [
        ["John", "Boozman", "Boozman, John (Senator)", '<a href="/search/view/ptr/abc-1/" target="_blank">PTR for 06/16/2026</a>', "06/16/2026"],
        ["Jane", "Doe", "Doe, Jane (Senator)", '<a href="/search/view/paper/xyz-2/">PTR</a>', "06/10/2026"]
      ]
    };
    const filings = parseEfdReportRows(json);
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({ member: "John Boozman", isPtr: true, filedAt: "2026-06-16" });
    expect(filings[0].viewUrl).toBe("https://efdsearch.senate.gov/search/view/ptr/abc-1/");
    expect(filings[1].isPtr).toBe(false); // paper filings are PDFs, not parseable
  });

  it("parses a PTR transaction table, classifying cells by content", () => {
    const html = `<table><tbody>
      <tr><td>1</td><td>05/27/2026</td><td>Joint</td><td>NVDA</td><td>NVIDIA Corp</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
      <tr><td>2</td><td>05/26/2026</td><td>Self</td><td>AAPL</td><td>Apple Inc</td><td>Stock</td><td>Sale (Full)</td><td>$15,001 - $50,000</td><td>--</td></tr>
      <tr><td>3</td><td>05/25/2026</td><td>Self</td><td>--</td><td>Muni Bond</td><td>Other</td><td>Exchange</td><td>$1,001 - $15,000</td><td>--</td></tr>
    </tbody></table>`;
    const trades = parsePtrTransactions(html, { member: "John Boozman", filedAt: "2026-06-16" });
    expect(trades).toHaveLength(2); // exchange + non-ticker row skipped
    expect(trades[0]).toMatchObject({ symbol: "NVDA", side: "buy", amountLow: 1001, amountHigh: 15000, tradedAt: "2026-05-27", chamber: "senate" });
    expect(trades[1]).toMatchObject({ symbol: "AAPL", side: "sell", tradedAt: "2026-05-26" });
  });

  it("skips a row whose ticker column is '--' even if a later cell looks like a ticker", () => {
    // Regression: a row-wide search used to grab the all-caps asset-name token ("GOLD")
    // as the ticker when the real ticker cell is "--", fabricating a trade.
    const html = `<table><tbody>
      <tr><td>1</td><td>05/27/2026</td><td>Self</td><td>--</td><td>GOLD</td><td>Other Securities</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
    </tbody></table>`;
    expect(parsePtrTransactions(html, { member: "X", filedAt: "2026-06-16" })).toEqual([]);
  });

  it("falls back to the filing date when a transaction date is out of range", () => {
    const html = `<table><tbody>
      <tr><td>1</td><td>13/45/2026</td><td>Self</td><td>NVDA</td><td>NVIDIA</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr>
    </tbody></table>`;
    const trades = parsePtrTransactions(html, { member: "X", filedAt: "2026-06-16" });
    expect(trades).toHaveLength(1);
    expect(trades[0].tradedAt).toBe("2026-06-16"); // invalid 13/45/2026 -> fallback, not "2026-13-45"
  });

  it("parses Capitol Trades BFF JSON defensively across field-name variants", () => {
    const json = {
      data: [
        { txType: "buy", txDate: "2026-06-10", pubDate: "2026-06-12", value: 50000, asset: { assetTicker: "TSLA" }, politician: { firstName: "Nancy", lastName: "P", chamber: "house" } },
        { type: "sold", transactionDate: "2026-06-09", ticker: "MSFT", value: 15000, politician: { firstName: "A", lastName: "B", chamber: "senate" } }
      ]
    };
    const trades = parseCapitolTradesBff(json);
    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ symbol: "TSLA", side: "buy", chamber: "house" });
    expect(trades[1]).toMatchObject({ symbol: "MSFT", side: "sell", chamber: "senate" });
  });
});

describe("parseApifyCongress", () => {
  const now = Date.parse("2026-06-19T00:00:00Z");
  // Real shape from the johnvc actor, incl. a partial-sale variant, a Senate row,
  // a garbage future date (2036), and a non-stock/no-ticker row.
  const items = [
    { Ticker: "TFC", Transaction_Type: "S", Date: "2026-04-17", Notification_Date: "2026-04-23", Amount_Range: "$1,001 - $15,000", First_Name: "Lloyd K.", Last_Name: "Smucker", House: "House", Owner: "SP", Asset_Type_Code: "ST" },
    { Ticker: "MMM", Transaction_Type: "P", Date: "2026-05-17", Notification_Date: "2026-05-20", Amount_Range: "$1,001 - $15,000", First_Name: "Julia", Last_Name: "Letlow", House: "House", Owner: "SE", Asset_Type_Code: "ST" },
    { Ticker: "FULT", Transaction_Type: "S (partial)", Date: "2026-04-17", Notification_Date: "2026-04-20", Amount_Range: "$100,001 - $250,000", First_Name: "Lloyd K.", Last_Name: "Smucker", House: "House", Asset_Type_Code: "ST" },
    { Ticker: "NVDA", Transaction_Type: "P", Date: "2026-06-10", Notification_Date: "2026-06-12", Amount_Range: "$1,001 - $15,000", First_Name: "Jane", Last_Name: "Doe", House: "Senate", Asset_Type_Code: "ST" },
    { Ticker: "BADYR", Transaction_Type: "P", Date: "2036-04-22", Notification_Date: "2036-04-25", Amount_Range: "$1,001 - $15,000", First_Name: "Future", Last_Name: "Person", House: "House", Asset_Type_Code: "ST" },
    { Ticker: "", Transaction_Type: "P", Date: "2026-05-01", Notification_Date: "2026-05-03", Amount_Range: "$1 - $2", First_Name: "No", Last_Name: "Ticker", House: "House", Asset_Type_Code: "OP" },
    { Ticker: "AAPL", Transaction_Type: "E", Date: "2026-05-02", Notification_Date: "2026-05-04", Amount_Range: "$1,001 - $15,000", First_Name: "Ex", Last_Name: "Change", House: "House", Asset_Type_Code: "ST" }
  ];

  it("parses House+Senate rows, maps P/S (incl. partial), and drops garbage", () => {
    const trades = parseApifyCongress(items, now);
    // TFC(sell), MMM(buy), FULT(sell partial), NVDA(senate buy) — 4 valid;
    // 2036 future date, empty ticker, and exchange ("E") are all dropped.
    expect(trades).toHaveLength(4);
    expect(trades[0]).toMatchObject({ symbol: "TFC", side: "sell", chamber: "house", member: "Lloyd K. Smucker", owner: "Spouse", source: "apify-congress", tradedAt: "2026-04-17", disclosedAt: "2026-04-23" });
    expect(trades[1]).toMatchObject({ symbol: "MMM", side: "buy", amountLow: 1001, amountHigh: 15000 });
    expect(trades[2]).toMatchObject({ symbol: "FULT", side: "sell" });
    expect(trades[3]).toMatchObject({ symbol: "NVDA", side: "buy", chamber: "senate" });
    expect(trades.some((t) => t.symbol === "BADYR")).toBe(false);
    expect(trades.some((t) => t.symbol === "AAPL")).toBe(false);
  });

  it("returns [] for non-array input", () => {
    expect(parseApifyCongress(null)).toEqual([]);
    expect(parseApifyCongress({ data: [] })).toEqual([]);
  });
});

describe("aggregateCongressSignals", () => {
  const now = Date.parse("2026-06-16T00:00:00Z");
  const trades: CongressTrade[] = [
    { symbol: "NVDA", member: "John Boozman", chamber: "senate", side: "buy", tradedAt: "2026-06-10", source: "senate-efd" },
    { symbol: "NVDA", member: "Jane Doe", chamber: "senate", side: "buy", tradedAt: "2026-06-09", source: "senate-efd" },
    { symbol: "NVDA", member: "John Boozman", chamber: "senate", side: "buy", tradedAt: "2026-06-08", source: "senate-efd" }, // same member again
    { symbol: "AAPL", member: "Sam Roe", chamber: "senate", side: "sell", tradedAt: "2026-06-05", source: "senate-efd" },
    { symbol: "OLD", member: "Stale", chamber: "senate", side: "buy", tradedAt: "2026-01-01", source: "senate-efd" } // outside 60d
  ];

  it("nets distinct members and respects the recency window", () => {
    const signals = aggregateCongressSignals(trades, ["NVDA", "AAPL", "OLD", "TSLA"], now, 60);
    expect(signals.NVDA.netSignal).toBe(2); // 2 distinct buy members
    expect(signals.NVDA.buyCount).toBe(3); // 3 disclosures
    expect(signals.NVDA.buyMembers).toEqual(["John Boozman", "Jane Doe"]);
    expect(signals.NVDA.bulletin).toContain("BUYS of NVDA");
    expect(signals.AAPL.netSignal).toBe(-1);
    expect(signals.OLD).toBeUndefined(); // outside window
    expect(signals.TSLA).toBeUndefined(); // no trades
  });

  it("uses disclosedAt as the primary recency anchor when present", () => {
    // Trade happened 90 days ago (outside the 60d window) but was only disclosed 5 days ago.
    // The signal should be INCLUDED because the market couldn't act until disclosedAt.
    const recentDisclosure: CongressTrade = {
      symbol: "META",
      member: "Alice Senator",
      chamber: "senate",
      side: "buy",
      tradedAt: new Date(now - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10), // 90d ago
      disclosedAt: new Date(now - 5 * 24 * 60 * 60_000).toISOString().slice(0, 10), // 5d ago
      source: "senate-efd"
    };
    const signals = aggregateCongressSignals([recentDisclosure], ["META"], now, 60);
    expect(signals.META).toBeDefined();
    expect(signals.META.netSignal).toBe(1);
    expect(signals.META.lastDisclosedAt).toBe(recentDisclosure.disclosedAt);
  });

  it("excludes a trade whose disclosedAt is outside the window, even if tradedAt is recent", () => {
    // Disclosed 90 days ago but the trade itself happened recently.
    // The signal is stale from the market's perspective — should be EXCLUDED.
    const staleDisclosure: CongressTrade = {
      symbol: "AMZN",
      member: "Bob Rep",
      chamber: "house",
      side: "buy",
      tradedAt: new Date(now - 5 * 24 * 60 * 60_000).toISOString().slice(0, 10), // 5d ago
      disclosedAt: new Date(now - 90 * 24 * 60 * 60_000).toISOString().slice(0, 10), // 90d ago
      source: "apify"
    };
    const signals = aggregateCongressSignals([staleDisclosure], ["AMZN"], now, 60);
    expect(signals.AMZN).toBeUndefined();
  });
});

describe("getSymbolWebSignals (persisted overlay)", () => {
  it("reads the cached dataset and builds per-symbol overlay + bulletins", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:congress:dataset", {
      trades: [{ symbol: "NVDA", member: "John Boozman", chamber: "senate", side: "buy", tradedAt: new Date().toISOString().slice(0, 10), source: "senate-efd" }],
      fetchedAt: new Date().toISOString(),
      sources: ["senate-efd"],
      recordCount: 1
    });
    const overlay = getSymbolWebSignals(["NVDA", "AAPL"]);
    expect(overlay.NVDA?.congress?.netSignal).toBe(1);
    expect(overlay.NVDA?.bulletins[0]).toContain("NVDA");
    expect(overlay.AAPL).toBeUndefined();
  });

  it("returns nothing when the connector is disabled", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:congress:dataset", {
      trades: [{ symbol: "NVDA", member: "X", chamber: "senate", side: "buy", tradedAt: new Date().toISOString().slice(0, 10), source: "senate-efd" }],
      fetchedAt: new Date().toISOString(),
      sources: ["senate-efd"],
      recordCount: 1
    });
    process.env.WEB_SOURCE_CONGRESS = "off";
    expect(getSymbolWebSignals(["NVDA"])).toEqual({});
  });
});

describe("refreshCongress (live flow, mocked fetch)", () => {
  function recentMdY(daysAgo: number): string {
    const d = new Date(Date.now() - daysAgo * 24 * 60 * 60_000);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getUTCFullYear()}`;
  }

  function stubEfdSuccess() {
    // Keep these inside the 60-day default congress window. Hardcoded 2026-06-16
    // aged out on 2026-08-15 UTC and failed CI on main after #2720.
    const filed = recentMdY(3);
    const traded = recentMdY(7);
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/search/") && method === "GET") {
        return new Response('<form><input name="csrfmiddlewaretoken" value="tok1"></form>', {
          status: 200,
          headers: { "set-cookie": "csrftoken=tok1; Path=/" }
        });
      }
      if (u.endsWith("/search/home/") && method === "POST") {
        return new Response("", { status: 302, headers: { "set-cookie": "csrftoken=tok2; Path=/" } });
      }
      if (u.endsWith("/search/report/data/") && method === "POST") {
        return new Response(
          JSON.stringify({ data: [["John", "Boozman", "Boozman, John (Senator)", `<a href="/search/view/ptr/abc-1/">PTR for ${filed}</a>`, filed]] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.includes("/search/view/ptr/")) {
        return new Response(
          `<tbody><tr><td>1</td><td>${traded}</td><td>Joint</td><td>NVDA</td><td>NVIDIA</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr></tbody>`,
          { status: 200 }
        );
      }
      // Capitol Trades (and anything else) fails — eFD alone must suffice.
      return new Response("unavailable", { status: 503 });
    });
  }

  it("scrapes, persists, and exposes a usable signal", async () => {
    stubEfdSuccess();
    const result = await refreshCongress(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.sources).toContain("senate-efd");
    expect(result.recordCount).toBeGreaterThanOrEqual(1);
    const overlay = getSymbolWebSignals(["NVDA"]);
    expect(overlay.NVDA?.congress?.buyCount).toBe(1);
  });

  it("backs off after an attempt so a failed scrape doesn't re-fire every tick", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    const { isCongressRefreshDue } = await import("../src/lib/web-sources/congress");
    const now = Date.now();
    setInternalSetting("webSource:congress:lastAttempt", new Date(now).toISOString());
    expect(isCongressRefreshDue(now)).toBe(false); // just attempted -> backed off
    expect(isCongressRefreshDue(now + 25 * 60 * 60_000)).toBe(true); // past backoff + TTL -> due again
  });

  it("does not overwrite a good prior dataset when every source fails", async () => {
    const { setInternalSetting, getInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:congress:dataset", {
      trades: [{ symbol: "MSFT", member: "Prior", chamber: "senate", side: "buy", tradedAt: "2026-06-01", source: "senate-efd" }],
      fetchedAt: "2026-06-15T00:00:00.000Z",
      sources: ["senate-efd"],
      recordCount: 1
    });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    const result = await refreshCongress(Date.now(), true);
    expect(result.ok).toBe(false);
    // Prior dataset must still be intact (never wiped to empty on a transient outage).
    const ds = getInternalSetting<{ recordCount: number }>("webSource:congress:dataset");
    expect(ds?.recordCount).toBe(1);
  });

  it("falls back to Senate eFD when Congress.Trade fails, including the agreement cookie", async () => {
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    const { deleteInternalSetting } = await import("../src/lib/db");
    deleteInternalSetting("webSource:congress:cursor");
    const filed = recentMdY(3);
    const traded = recentMdY(7);
    const bodies: string[] = [];
    const cookies: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("congress.trade")) return new Response("down", { status: 503 });
      if (u.endsWith("/search/") && method === "GET") {
        return new Response('<form><input name="csrfmiddlewaretoken" value="tok1"></form>', {
          status: 200,
          headers: { "set-cookie": "csrftoken=tok1; Path=/" }
        });
      }
      if (u.endsWith("/search/home/") && method === "POST") {
        bodies.push(String(init?.body ?? ""));
        return new Response("", { status: 302, headers: { "set-cookie": "csrftoken=tok2; Path=/" } });
      }
      if (u.endsWith("/search/report/data/") && method === "POST") {
        cookies.push(String((init?.headers as Record<string, string> | undefined)?.cookie ?? ""));
        return new Response(
          JSON.stringify({ data: [["John", "Boozman", "Boozman, John (Senator)", `<a href="/search/view/ptr/abc-1/">PTR for ${filed}</a>`, filed]] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.includes("/search/view/ptr/")) {
        return new Response(
          `<tbody><tr><td>1</td><td>${traded}</td><td>Joint</td><td>NVDA</td><td>NVIDIA</td><td>Stock</td><td>Purchase</td><td>$1,001 - $15,000</td><td>--</td></tr></tbody>`,
          { status: 200 }
        );
      }
      return new Response("unavailable", { status: 503 });
    });

    const result = await refreshCongress(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.sources).toContain("senate-efd");
    expect(result.sources).not.toContain("congress-trade");
    expect(bodies.some((body) => body.includes("prohibition_agreement=1"))).toBe(true);
    expect(cookies.some((cookie) => cookie.includes("csrftoken=tok2"))).toBe(true);
    const overlay = getSymbolWebSignals(["NVDA"]);
    expect(overlay.NVDA?.congress?.buyCount).toBe(1);
  });

  it("does not scrape Senate eFD when Congress.Trade already returned trades", async () => {
    process.env.CONGRESS_TRADE_AS_CONGRESS_SOURCE = "on";
    const { deleteInternalSetting } = await import("../src/lib/db");
    deleteInternalSetting("webSource:congress:cursor");
    const traded = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("congress.trade")) {
        return new Response(
          JSON.stringify({
            cursor: 4,
            transactions: [{ symbol: "AAPL", side: "buy", tradedAt: traded, member: "Pat", chamber: "senate", cursorSeq: 4 }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (u.includes("efdsearch.senate.gov")) return new Response("should not run", { status: 500 });
      return new Response("nope", { status: 404 });
    });
    const result = await refreshCongress(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.sources).toContain("congress-trade");
    expect(result.sources).not.toContain("senate-efd");
  });
});
