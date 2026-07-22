import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.FINNHUB_API_KEY;
  delete process.env.FMP_API_KEY;
  delete process.env.ALPHAVANTAGE_API_KEY;
  delete process.env.ALPACA_DATA_API_KEY;
  delete process.env.ALPACA_DATA_SECRET_KEY;
});

describe("market scan dynamic universes", () => {
  it("adds Nasdaq exchange-filtered rows for the NYSE Composite universe", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com") && url.includes("exchange=nyse")) {
        return nasdaqRows([
          { symbol: "IBM", name: "International Business Machines", lastsale: "$255.10", netchange: "1.20", pctchange: "0.472%", marketCap: "235000000000" }
        ]);
      }
      if (url.includes("api.nasdaq.com")) return nasdaqRows([]);
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket([], [], undefined, undefined, ["nyseComposite"]);

    expect(scan.returnedQuotes).toBe(1);
    expect(scan.quotesBySymbol.IBM?.price).toBe(255.1);
    expect(scan.source).toContain("nyseComposite-universe");
  });

  it("strips an unfilled '(Representing - )' ADR placeholder from the raw screener name, keeping a real one", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com") && url.includes("exchange=nyse")) {
        return nasdaqRows([
          { symbol: "SHEL", name: "Shell Plc ADR (Representing - )", lastsale: "$72.10", netchange: "0.5", pctchange: "0.7%", marketCap: "210000000000" },
          { symbol: "TM", name: "Toyota Motor Corp ADR (Representing 2 Ordinary Shares)", lastsale: "$210.00", netchange: "1.1", pctchange: "0.5%", marketCap: "260000000000" }
        ]);
      }
      if (url.includes("api.nasdaq.com")) return nasdaqRows([]);
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket([], [], undefined, undefined, ["nyseComposite"]);

    // The unfilled placeholder is a screener data-quality artifact — dropped.
    expect(scan.quotesBySymbol.SHEL?.companyName).toBe("Shell Plc ADR");
    // A genuinely populated annotation is real information — left alone.
    expect(scan.quotesBySymbol.TM?.companyName).toBe("Toyota Motor Corp ADR (Representing 2 Ordinary Shares)");
  });

  it("filters BlackRock holdings through the screener without quote-fetching every missing holding", async () => {
    const fetchedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url.includes("api.nasdaq.com")) {
        return nasdaqRows([
          { symbol: "AAPL", name: "Apple Inc.", lastsale: "$297.01", netchange: "2.01", pctchange: "0.681%", marketCap: "4400000000000" }
        ]);
      }
      if (url.includes("blackrock.com")) return new Response(holdingsWorkbook(["AAPL", "MISSING"]), { status: 200, headers: { "content-type": "application/vnd.ms-excel" } });
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const scan = await scanMarket([], [], undefined, undefined, ["sp100"]);

    expect(scan.returnedQuotes).toBe(1);
    expect(scan.quotesBySymbol.AAPL?.price).toBe(297.01);
    expect(scan.source).toContain("blackrock-oef-holdings");
    expect(fetchedUrls.some((url) => url.includes("finance/chart/MISSING"))).toBe(false);
  });

  it("propagates the interactive deadline signal into BlackRock holdings discovery", async () => {
    let started!: () => void;
    const blackRockStarted = new Promise<void>((resolve) => { started = resolve; });
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.nasdaq.com")) {
        return nasdaqRows([
          { symbol: "AAPL", name: "Apple Inc.", lastsale: "$297.01", netchange: "2.01", pctchange: "0.681%", marketCap: "4400000000000" }
        ]);
      }
      if (url.includes("blackrock.com")) {
        requestSignal = init?.signal ?? undefined;
        started();
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return new Response("not found", { status: 404 });
    });

    const { clearMarketCache, scanMarket } = await import("../src/lib/market");
    clearMarketCache();
    const controller = new AbortController();
    const pending = scanMarket([], [], undefined, undefined, ["sp100"], { signal: controller.signal });
    await blackRockStarted;
    controller.abort();
    const scan = await pending;

    expect(requestSignal?.aborted).toBe(true);
    expect(scan.warnings.join(" ")).toContain("holdings failed");
  });
});

function nasdaqRows(rows: unknown[]): Response {
  return new Response(
    JSON.stringify({
      data: {
        asof: "2026-06-23",
        table: { rows }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function holdingsWorkbook(symbols: string[]): string {
  const rows = [
    ["Ticker", "Name", "Sector", "Asset Class", "Currency"],
    ...symbols.map((symbol) => [symbol, `${symbol} CORP`, "Technology", "Equity", "USD"])
  ];
  return [
    '<?xml version="1.0"?>',
    '<ss:Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
    "<ss:Worksheet><ss:Table>",
    ...rows.map((row) => `<ss:Row>${row.map((cell) => `<ss:Cell><ss:Data ss:Type="String">${cell}</ss:Data></ss:Cell>`).join("")}</ss:Row>`),
    "</ss:Table></ss:Worksheet></ss:Workbook>"
  ].join("");
}
