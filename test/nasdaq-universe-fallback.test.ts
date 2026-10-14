import { describe, expect, it, vi, afterEach } from "vitest";
import {
  fetchFallbackUniverseRows,
  NASDAQ_LISTED_URL,
  SEC_COMPANY_TICKERS_EXCHANGE_URL
} from "../src/lib/nasdaq-universe-fallback";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchFallbackUniverseRows", () => {
  it("merges Nasdaq Trader pipe files with SEC titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SEC_COMPANY_TICKERS_EXCHANGE_URL) {
          return {
            ok: true,
            text: async () =>
              JSON.stringify({
                fields: ["ticker", "title"],
                data: [["aapl", "Apple Inc."]]
              })
          };
        }
        if (url === NASDAQ_LISTED_URL) {
          return {
            ok: true,
            text: async () => "Symbol|Security Name|Market Category|Test Issue|Financial Status\nAAPL|Apple Inc.|Q|N|N\n"
          };
        }
        return {
          ok: true,
          text: async () => "Symbol|Security Name|Exchange|Test Issue|Round Lot Size\nZZZZ|Zeta Corp|N|N|100\n"
        };
      })
    );

    const rows = await fetchFallbackUniverseRows();
    const aapl = rows.find((r) => r.symbol === "AAPL");
    expect(aapl?.name).toBe("Apple Inc.");
    expect(rows.some((r) => r.symbol === "ZZZZ")).toBe(true);
  });
});
