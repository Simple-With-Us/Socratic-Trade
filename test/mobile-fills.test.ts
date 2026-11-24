// ST-4640: the MOBILE-scoped fill bound.
//
// The console's fill ledger stays unbounded (FIFO lot replay needs every fill).  The mobile
// wire ships a bounded window plus an explicit `fillsTruncated` flag, and the parallel iOS
// lane must work whether or not those fields exist.
import { describe, expect, it } from "vitest";

import { MOBILE_FILL_LIMIT, boundMobileFills, withMobileFillsBound } from "../src/lib/mobile-fills";
import type { FillEvent } from "../src/lib/types";

function fill(i: number): FillEvent {
  return {
    id: `fill-${i}`,
    symbol: "AAPL",
    side: "buy",
    quantity: 1,
    price: 100 + i,
    filledAt: new Date(Date.parse("2026-11-23T10:00:00.000Z") + i * 1000).toISOString(),
    source: "live",
    accountNumber: "ACC"
  } as unknown as FillEvent;
}

describe("mobile fill bound (ST-4640)", () => {
  it("keeps the whole ledger when it is shorter than the cap", () => {
    const fills = [fill(1), fill(2), fill(3)];
    const bounded = boundMobileFills(fills);
    expect(bounded.fills).toHaveLength(3);
    expect(bounded.fillsTruncated).toBe(false);
  });

  it("keeps the NEWEST fills and flags the truncation", () => {
    const fills = Array.from({ length: MOBILE_FILL_LIMIT + 25 }, (_, i) => fill(i));
    const bounded = boundMobileFills(fills);
    expect(bounded.fills).toHaveLength(MOBILE_FILL_LIMIT);
    expect(bounded.fillsTruncated).toBe(true);
    // The newest fill survives; the oldest is dropped.
    expect(bounded.fills[bounded.fills.length - 1]?.id).toBe(`fill-${MOBILE_FILL_LIMIT + 24}`);
    expect(bounded.fills.some((f) => f.id === "fill-0")).toBe(false);
  });

  it("is a no-op on an empty ledger", () => {
    expect(boundMobileFills(undefined)).toEqual({ fills: [], fillsTruncated: false });
    expect(boundMobileFills(null)).toEqual({ fills: [], fillsTruncated: false });
  });

  it("bounds the performance summary's display fills without touching the console path", () => {
    const fills = Array.from({ length: 120 }, (_, i) => fill(i));
    const performance = { fills, liveRealizedPnl: 10 };
    const bounded = withMobileFillsBound(performance);
    expect(bounded.fills).toHaveLength(MOBILE_FILL_LIMIT);
    expect(bounded.liveRealizedPnl).toBe(10);
    // The input object is untouched — the console payload is unaffected.
    expect(performance.fills).toHaveLength(120);
  });
});
