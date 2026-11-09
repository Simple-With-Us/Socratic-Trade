import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invalidSymbolMessage,
  newlyAddedInvalidSymbols,
  normalizePolicySymbolList,
  sanitizePolicySymbolList,
  validateNewCustomPolicySymbols
} from "../src/lib/policy-symbol-validation";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("policy custom symbols", () => {
  it("accepts a custom Additional Watchlist ticker when a live quote is available", async () => {
    stubYahooChart("SPCX", 161.84);

    const next = sanitizePolicySymbolList(normalizePolicySymbolList(["SPCX"], []));
    const error = await validateNewCustomPolicySymbols(next, []);

    expect(error).toBeUndefined();
    expect(next).toEqual(["SPCX"]);
  });

  it("explains why a new custom ticker cannot be added when no quote is available", async () => {
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));

    const next = sanitizePolicySymbolList(normalizePolicySymbolList(["DSADLAS"], []));
    const error = await validateNewCustomPolicySymbols(next, []);

    expect(error).toContain("DSADLAS");
    expect(error).toMatch(/no current U\.S\. equity\/ETF quote/i);
  });

  it("returns a specific message for malformed newly added symbols", () => {
    const invalid = newlyAddedInvalidSymbols(normalizePolicySymbolList(["@@@"], []), []);

    expect(invalid).toEqual(["@@@"]);
    expect(invalidSymbolMessage(invalid)).toContain("1-10 letters, numbers, or dots");
  });
});

function stubYahooChart(symbol: string, price: number): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes(`finance/chart/${symbol}`)) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: {
                  regularMarketPrice: price,
                  chartPreviousClose: price - 2,
                  regularMarketVolume: 1234567
                },
                indicators: { quote: [{ volume: [1234567] }] }
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}
