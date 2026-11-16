import { describe, expect, it } from "vitest";

import {
  closingOrderPnl,
  deriveOpenOrders,
  effectiveOrderPrice,
  fmtAge,
  matchPosition,
  storedPriceFor
} from "../app/console/orders/lib";
import type { EquityOrder, EquityPosition, TradingPolicy } from "../src/lib/types";

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "o1",
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    state: "new",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-07-15T14:00:00.000Z",
    ...overrides
  };
}

describe("matchPosition — held position for an order's symbol, normalized", () => {
  const positions: EquityPosition[] = [
    { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 },
    { symbol: "TSLA", quantity: -5, averageCost: 200, marketValue: -900 }
  ];

  it("finds the position by exact symbol", () => {
    expect(matchPosition(positions, "AAPL")?.symbol).toBe("AAPL");
  });

  it("matches case-insensitively and trims whitespace (normalizeSymbol)", () => {
    expect(matchPosition(positions, " aapl ")?.symbol).toBe("AAPL");
  });

  it("returns undefined when nothing is held in that symbol", () => {
    expect(matchPosition(positions, "MSFT")).toBeUndefined();
  });

  it("returns undefined for an empty/undefined position list", () => {
    expect(matchPosition(undefined, "AAPL")).toBeUndefined();
    expect(matchPosition([], "AAPL")).toBeUndefined();
  });
});

describe("effectiveOrderPrice — held position's own mark beats the market-scan cache (except when the mark equals cost — broker fallback)", () => {
  const heldLong: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_250 };
  const scan = { price: 118, asOf: "2026-07-15T13:50:00.000Z", provider: "yahoo-finance" };

  it("prefers the position's own mark when the symbol is held, even with a scan price available", () => {
    expect(effectiveOrderPrice(heldLong, scan)).toEqual({ price: 125, source: "position" });
  });

  it("prefers the scan price when the position's mark equals its average cost (broker fallback)", () => {
    const costFallback: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_000 };
    expect(effectiveOrderPrice(costFallback, scan)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });

  it("falls back to the scan price when the symbol isn't held", () => {
    expect(effectiveOrderPrice(undefined, scan)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });

  it("returns null when neither a held position nor a scan price is available", () => {
    expect(effectiveOrderPrice(undefined, null)).toBeNull();
  });

  it("falls back to the durable stored price (age-tagged) when neither held nor scanned", () => {
    const stored = { price: 378.1, asOf: "2026-07-14T15:00:00.000Z", source: "yahoo-finance" };
    expect(effectiveOrderPrice(undefined, null, stored)).toEqual({
      price: 378.1,
      source: "store",
      asOf: stored.asOf,
      provider: stored.source
    });
  });

  it("never lets the stored price beat a held mark or a scan quote", () => {
    const stored = { price: 1, asOf: "2026-07-14T15:00:00.000Z", source: "yahoo-finance" };
    expect(effectiveOrderPrice(heldLong, scan, stored)).toEqual({ price: 125, source: "position" });
    expect(effectiveOrderPrice(undefined, scan, stored)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });

  it("returns null when only an invalid stored price exists (never invent)", () => {
    expect(effectiveOrderPrice(undefined, null, null)).toBeNull();
  });

  it("falls back to the scan when the position is flat (nothing to mark)", () => {
    const flat: EquityPosition = { symbol: "AAPL", quantity: 0, averageCost: 100, marketValue: 0 };
    expect(effectiveOrderPrice(flat, scan)).toEqual({
      price: 118,
      source: "scan",
      asOf: scan.asOf,
      provider: scan.provider
    });
  });
});

describe("storedPriceFor — durable-store fallback lookup from the snapshot map", () => {
  const fallbacks = {
    MSFT: { price: 378.1, asOf: "2026-07-14T15:00:00.000Z", source: "yahoo-finance" }
  };

  it("finds the stored price by normalized symbol", () => {
    expect(storedPriceFor(fallbacks, " msft ")?.price).toBe(378.1);
  });

  it("returns null for symbols the store doesn't cover, or no map at all", () => {
    expect(storedPriceFor(fallbacks, "AAPL")).toBeNull();
    expect(storedPriceFor(undefined, "MSFT")).toBeNull();
  });

  it("rejects non-positive / non-finite stored prices", () => {
    expect(storedPriceFor({ MSFT: { price: 0, asOf: "2026-07-14T15:00:00.000Z" } }, "MSFT")).toBeNull();
    expect(storedPriceFor({ MSFT: { price: Number.NaN, asOf: "2026-07-14T15:00:00.000Z" } }, "MSFT")).toBeNull();
  });
});

describe("fmtAge — coarse age tags for stored prices", () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");

  it("renders minutes, hours, and days coarsely", () => {
    expect(fmtAge("2026-08-08T11:48:00.000Z", now)).toBe("12m");
    expect(fmtAge("2026-08-07T13:00:00.000Z", now)).toBe("23h");
    expect(fmtAge("2026-08-05T11:00:00.000Z", now)).toBe("3d");
  });

  it("returns null for missing/unparseable timestamps (no tag, never invented)", () => {
    expect(fmtAge(undefined, now)).toBeNull();
    expect(fmtAge("not-a-date", now)).toBeNull();
  });
});

describe("closingOrderPnl — estimated P/L for open orders that would close/reduce a position", () => {
  const heldLong: EquityPosition = { symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1_200 };
  const heldShort: EquityPosition = { symbol: "TSLA", quantity: -10, averageCost: 200, marketValue: -1_600 };

  it("estimates P/L for a sell-of-long using the order's unfilled remainder", () => {
    const sell = order({ symbol: "AAPL", side: "sell", quantity: 10, filledQuantity: 4 });
    const remaining = 6; // mirrors remainingQuantity(sell)
    const price = { price: 130, source: "position" as const };
    expect(closingOrderPnl(sell, remaining, heldLong, price)).toEqual({
      pnl: 180, // (130 - 100) * 6
      pnlPct: 30,
      basisPrice: 100,
      currentPrice: 130,
      shares: 6
    });
  });

  it("estimates P/L for a cover-of-short (buy reported by Alpaca), sign-flipped vs. a long", () => {
    const cover = order({ symbol: "TSLA", side: "buy", quantity: 10, filledQuantity: 0 });
    const price = { price: 160, source: "position" as const };
    expect(closingOrderPnl(cover, 10, heldShort, price)).toEqual({
      pnl: 400, // (200 - 160) * 10
      pnlPct: 20,
      basisPrice: 200,
      currentPrice: 160,
      shares: 10
    });
  });

  it("is null for an opening order (buy against a long, or sell against a short)", () => {
    const openingBuy = order({ symbol: "AAPL", side: "buy" });
    expect(closingOrderPnl(openingBuy, 10, heldLong, { price: 130, source: "position" })).toBeNull();
    const openingShort = order({ symbol: "TSLA", side: "short" });
    expect(closingOrderPnl(openingShort, 10, heldShort, { price: 160, source: "position" })).toBeNull();
  });

  it("is null when there's no matching held position", () => {
    const sell = order({ symbol: "MSFT", side: "sell" });
    expect(closingOrderPnl(sell, 10, undefined, { price: 300, source: "scan" })).toBeNull();
  });

  it("is null when no price is available", () => {
    const sell = order({ symbol: "AAPL", side: "sell" });
    expect(closingOrderPnl(sell, 10, heldLong, null)).toBeNull();
  });

  it("is null when the order's unfilled remainder is zero (fully filled)", () => {
    const filled = order({ symbol: "AAPL", side: "sell" });
    expect(closingOrderPnl(filled, 0, heldLong, { price: 130, source: "position" })).toBeNull();
  });

  it("caps the share count to the current position when the order's remainder exceeds the position size", () => {
    const reducedPosition: EquityPosition = { symbol: "AAPL", quantity: 5, averageCost: 100, marketValue: 600 };
    const orderForMore = order({ symbol: "AAPL", side: "sell", quantity: 10, filledQuantity: 0 });
    // remaining = 10, but position is only 5 — caps to 5
    expect(closingOrderPnl(orderForMore, 10, reducedPosition, { price: 130, source: "position" })).toEqual({
      pnl: 150, // (130 - 100) * 5
      pnlPct: 30,
      basisPrice: 100,
      currentPrice: 130,
      shares: 5
    });
  });
});

describe("deriveOpenOrders — does not inflate with historical done_for_day", () => {
  const policy = { staleLimitOrderMinutes: 15 } as Pick<TradingPolicy, "staleLimitOrderMinutes">;

  it("includes live new/held orders and excludes done_for_day history", () => {
    const rows = deriveOpenOrders(
      [
        order({ id: "live", state: "new", createdAt: "2026-07-27T14:00:00.000Z" }),
        order({ id: "held-leg", state: "held", createdAt: "2026-07-27T14:00:00.000Z" }),
        order({ id: "hist-1", state: "done_for_day", createdAt: "2026-06-01T14:00:00.000Z" }),
        order({ id: "hist-2", state: "done_for_day", createdAt: "2026-05-01T14:00:00.000Z" }),
        order({ id: "filled", state: "filled", createdAt: "2026-07-20T14:00:00.000Z" })
      ],
      policy,
      new Date("2026-07-27T15:00:00.000Z")
    );
    expect(rows.map((r) => r.order.id).sort()).toEqual(["held-leg", "live"]);
  });
});
