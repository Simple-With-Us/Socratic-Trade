/**
 * Dashboard price-fill fallback.
 *
 * A realtime venue keeps the historical behaviour (a derived cost basis is
 * better than a blank cell).  A VENUE-DELAYED tape must NOT invent a price:
 * when the paper broker did not price a symbol, `marketValue / quantity` is a
 * derived cost basis, and showing it as a current price would let the console
 * display a stale number as if it were the venue's live tape.
 */
import { describe, expect, it } from "vitest";
import { applyPositionPriceFallback } from "../src/lib/dashboard-price-fallback";
import type { EquityPosition } from "../src/lib/types";

function position(overrides: Partial<EquityPosition> = {}): EquityPosition {
  return {
    symbol: "AAPL",
    quantity: 10,
    marketValue: 2000,
    ...overrides
  } as EquityPosition;
}

describe("applyPositionPriceFallback", () => {
  it("leaves a missing symbol ABSENT on a venue-delayed tape (no derived cost basis)", () => {
    const result = applyPositionPriceFallback({}, [position()], "venue_delayed");
    expect(result.AAPL).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("keeps the realtime marketValue/quantity fill", () => {
    const result = applyPositionPriceFallback({}, [position()], "realtime");
    expect(result.AAPL).toBe(200);
  });

  it("keeps the marketValue fill for a venue-locked tape (Tradier live is not the delayed paper tape)", () => {
    const result = applyPositionPriceFallback({}, [position()], "venue_locked");
    expect(result.AAPL).toBe(200);
  });

  it("never overwrites a price the venue DID provide", () => {
    const result = applyPositionPriceFallback({ AAPL: 195 }, [position()], "realtime");
    expect(result.AAPL).toBe(195);
  });

  it("skips zero-quantity positions", () => {
    const result = applyPositionPriceFallback({}, [position({ quantity: 0 })], "realtime");
    expect(result.AAPL).toBeUndefined();
  });

  it("normalizes the symbol before filling", () => {
    const result = applyPositionPriceFallback({}, [position({ symbol: "aapl" })], "realtime");
    expect(result.AAPL).toBe(200);
  });
});
