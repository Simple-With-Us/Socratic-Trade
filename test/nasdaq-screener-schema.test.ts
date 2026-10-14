import { describe, expect, it } from "vitest";
import { NasdaqScreenerPayloadSchema, parseNasdaqScreenerPayload } from "../src/lib/nasdaq-screener-schema";

describe("NasdaqScreenerPayloadSchema", () => {
  it("keeps declared provider keys and rejects a key the schema does not name", () => {
    const parsed = parseNasdaqScreenerPayload({
      status: { rCode: 200 },
      data: {
        asof: "2026-08-18",
        headers: { symbol: "Symbol" },
        table: {
          headers: ["symbol"],
          rows: [{
            symbol: "AAPL",
            name: "Apple Inc.",
            lastsale: "$200",
            netchange: "1.2",
            pctchange: "1%",
            volume: "1000000",
            marketCap: "3000000000000",
            sector: "Technology",
            industry: "Consumer Electronics",
            url: "/market-activity/stocks/aapl",
            country: "United States"
          }]
        }
      }
    });
    expect(parsed.data.asof).toBe("2026-08-18");
    expect(parsed.status?.rCode).toBe(200);
    expect(parsed.data.headers).toEqual({ symbol: "Symbol" });
    expect(parsed.data.table.rows).toEqual([{
      symbol: "AAPL",
      name: "Apple Inc.",
      lastsale: "$200",
      netchange: "1.2",
      pctchange: "1%",
      volume: "1000000",
      marketCap: "3000000000000",
      sector: "Technology",
      industry: "Consumer Electronics",
      url: "/market-activity/stocks/aapl",
      country: "United States"
    }]);
    expect(() => parseNasdaqScreenerPayload({
      data: { table: { rows: [{ symbol: "AAPL", lastsale: "$1", injected: true }] } }
    })).toThrow();
    expect(() => parseNasdaqScreenerPayload({
      unexpected: true,
      data: { table: { rows: [{ symbol: "AAPL", lastsale: "$1" }] } }
    })).toThrow();
  });

  it("accepts the live tableonly envelope, including url and a null status field", () => {
    const parsed = parseNasdaqScreenerPayload({
      data: {
        asof: "Last price as of Oct 12, 2026",
        filters: null,
        totalrecords: 7017,
        table: {
          asOf: null,
          headers: { symbol: "Symbol", url: "URL" },
          rows: [{
            symbol: "NVDA",
            name: "NVIDIA Corporation Common Stock",
            lastsale: "$226.32",
            netchange: "-2.96",
            pctchange: "-1.291%",
            marketCap: "5,454,312,000,000",
            url: "/market-activity/stocks/nvda"
          }]
        }
      },
      message: null,
      status: { rCode: 200, bCodeMessage: null, developerMessage: null }
    });
    expect(parsed.data.table.rows[0]?.url).toBe("/market-activity/stocks/nvda");
    expect(parsed.data.totalrecords).toBe(7017);
  });

  it("accepts nullish text fields and numeric quote cells", () => {
    const parsed = NasdaqScreenerPayloadSchema.parse({
      data: {
        asof: null,
        table: {
          rows: [{ symbol: "MSFT", lastsale: 400, volume: 10, sector: null }]
        }
      }
    });
    expect(parsed.data.asof).toBeNull();
    expect(parsed.data.table.rows[0]).toMatchObject({ symbol: "MSFT", lastsale: 400, volume: 10, sector: null });
  });

  it("rejects an envelope that has no table rows", () => {
    expect(() => parseNasdaqScreenerPayload({ unexpected: true })).toThrow();
    expect(() => parseNasdaqScreenerPayload({ data: { table: {} } })).toThrow();
    expect(() => parseNasdaqScreenerPayload(null)).toThrow();
  });
});
