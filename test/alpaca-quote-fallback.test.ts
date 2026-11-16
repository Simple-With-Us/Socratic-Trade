/**
 * fillMissingQuotesWithClose — keyless market-data fallback for symbols the broker didn't price.
 * Pure helper (no Alpaca client / DB), so it runs offline with a stubbed close fetcher.
 */
import { describe, expect, it } from "vitest";
import { fillMissingQuotesWithClose } from "../src/lib/alpaca";
import type { BrokerQuote } from "../src/lib/types";

describe("fillMissingQuotesWithClose", () => {
  it("fills only symbols the broker left unpriced (missing or <=0), tagged as session close", async () => {
    const quotes: Record<string, BrokerQuote> = {
      AAPL: { symbol: "AAPL", price: 200, provider: "alpaca" },
      XOM: { symbol: "XOM", price: 0, provider: "alpaca" } // 0 = unpriced (closed market / IEX)
      // LYB intentionally missing entirely
    };
    const fetched: string[] = [];
    await fillMissingQuotesWithClose(quotes, ["AAPL", "XOM", "LYB"], async (s) => {
      fetched.push(s);
      return { price: s === "XOM" ? 110.5 : 95.25, asOf: "2026-06-24" };
    });
    expect(fetched.sort()).toEqual(["LYB", "XOM"]); // AAPL already priced → never fetched
    expect(quotes.AAPL.price).toBe(200); // untouched
    expect(quotes.XOM).toMatchObject({
      price: 110.5,
      provider: "session-close",
      asOf: "2026-06-24"
    });
    expect(quotes.XOM.delayedFallback).toBeUndefined();
    expect(quotes.LYB).toMatchObject({ price: 95.25, provider: "session-close" });
    expect(quotes.LYB.delayedFallback).toBeUndefined();
    expect(quotes.XOM.fetchedAt).toBeTruthy();
  });

  it("leaves a symbol unpriced when the fallback returns nothing or a non-positive price", async () => {
    const quotes: Record<string, BrokerQuote> = {};
    await fillMissingQuotesWithClose(quotes, ["NONE", "BAD"], async (s) => (s === "BAD" ? { price: 0 } : undefined));
    expect(quotes.NONE).toBeUndefined();
    expect(quotes.BAD).toBeUndefined();
  });

  it("swallows fallback errors (best-effort; never throws)", async () => {
    const quotes: Record<string, BrokerQuote> = {};
    await fillMissingQuotesWithClose(quotes, ["ERR"], async () => {
      throw new Error("boom");
    });
    expect(quotes.ERR).toBeUndefined();
  });
});
