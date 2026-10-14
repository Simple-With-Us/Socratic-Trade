import { describe, expect, it } from "vitest";
import { NasdaqScreenerPayloadSchema, parseNasdaqScreenerPayload } from "../src/lib/nasdaq-screener-schema";

describe("NasdaqScreenerPayloadSchema", () => {
  it("parses a screener envelope and strips provider keys that the scan does not read", () => {
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
    expect(parsed.data.table.rows).toEqual([{
      symbol: "AAPL",
      name: "Apple Inc.",
      lastsale: "$200",
      netchange: "1.2",
      pctchange: "1%",
      volume: "1000000",
      marketCap: "3000000000000",
      sector: "Technology",
      industry: "Consumer Electronics"
    }]);
    expect(Object.keys(parsed)).toEqual(["data"]);
    expect("headers" in parsed.data).toBe(false);
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
