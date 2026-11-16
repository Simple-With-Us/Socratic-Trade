import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { calculatePnl } from "../src/lib/performance";
import type { FillEvent, OrderSide } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `short-pnl-sign-${randomUUID()}.db`)}`;
});

/**
 * Focused unit tests for short P&L sign correctness.
 * Verifies that:
 * - SHORT positions profit when price falls (cover < short price)
 * - SHORT positions lose when price rises (cover > short price)
 * - LONG positions maintain correct sign convention as control
 */
describe("short-P&L sign correctness", () => {
  /**
   * Test 1: SHORT at 100, COVER at 90 (price fell) → should realize +10 profit.
   * Formula: matched * (lot.price - fill.price) = 1 * (100 - 90) = +10 ✓
   */
  it("short at 100, cover at 90 (price fell): realizes +10 profit (positive P&L)", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-1",
        side: "short",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "cover-1",
        side: "cover",
        quantity: 1,
        price: 90,
        notional: 90,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills);

    // Positive P&L: the short thesis worked (price fell as expected)
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].pnl).toBeCloseTo(10);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(10);
    expect(pnl.closedLots[0].side).toBe("short");
  });

  /**
   * Test 2: SHORT at 100, COVER at 110 (price rose) → should realize -10 loss.
   * Formula: matched * (lot.price - fill.price) = 1 * (100 - 110) = -10 ✓
   */
  it("short at 100, cover at 110 (price rose): realizes -10 loss (negative P&L)", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-2",
        side: "short",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "cover-2",
        side: "cover",
        quantity: 1,
        price: 110,
        notional: 110,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills);

    // Negative P&L: the short thesis failed (price rose contrary to expectations)
    expect(pnl.realized).toBeCloseTo(-10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].pnl).toBeCloseTo(-10);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(-10);
    expect(pnl.closedLots[0].side).toBe("short");
  });

  /**
   * Test 3: SHORT with larger notional movement.
   * SHORT 2 @ 100, COVER 2 @ 85 → realized = 2 * (100 - 85) = +30 profit.
   */
  it("short 2 @ 100, cover 2 @ 85: realizes +30 profit on larger position", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-3",
        side: "short",
        quantity: 2,
        price: 100,
        notional: 200,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "cover-3",
        side: "cover",
        quantity: 2,
        price: 85,
        notional: 170,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills);

    expect(pnl.realized).toBeCloseTo(30);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].pnl).toBeCloseTo(30);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(15); // (100-85)/100*100 = 15%
  });

  /**
   * Test 4: LONG at 100, SELL at 110 (price rose) → should realize +10 profit.
   * Formula: matched * (fill.price - lot.price) = 1 * (110 - 100) = +10 ✓
   * Control test: verifies long P&L sign convention for comparison.
   */
  it("CONTROL: long at 100, sell at 110 (price rose): realizes +10 profit", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "buy-1",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "sell-1",
        side: "sell",
        quantity: 1,
        price: 110,
        notional: 110,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills);

    // Positive P&L: the long thesis worked (price rose as expected)
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].pnl).toBeCloseTo(10);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(10);
    expect(pnl.closedLots[0].side).toBe("long");
  });

  /**
   * Test 5: LONG at 100, SELL at 90 (price fell) → should realize -10 loss.
   * Formula: matched * (fill.price - lot.price) = 1 * (90 - 100) = -10 ✓
   * Control test: long loss case.
   */
  it("CONTROL: long at 100, sell at 90 (price fell): realizes -10 loss", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "buy-2",
        side: "buy",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "sell-2",
        side: "sell",
        quantity: 1,
        price: 90,
        notional: 90,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills);

    // Negative P&L: the long thesis failed (price fell contrary to expectations)
    expect(pnl.realized).toBeCloseTo(-10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].pnl).toBeCloseTo(-10);
    expect(pnl.closedLots[0].returnPct).toBeCloseTo(-10);
    expect(pnl.closedLots[0].side).toBe("long");
  });

  /**
   * Test 6: Unrealized short P&L marked to market.
   * SHORT 1 @ 120, current price 100 → unrealized profit = 1 * (120 - 100) = +20.
   */
  it("open short at 120, market price 100: marks to market with +20 unrealized profit", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-4",
        side: "short",
        quantity: 1,
        price: 120,
        notional: 120,
        filledAt: "2026-06-15T10:00:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills, { AAPL: 100 });

    expect(pnl.unrealized).toBeCloseTo(20);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeCloseTo(-1); // signed negative for short
  });

  /**
   * Test 7: Unrealized short P&L loss when price rises.
   * SHORT 1 @ 100, current price 120 → unrealized loss = 1 * (100 - 120) = -20.
   */
  it("open short at 100, market price 120: marks to market with -20 unrealized loss", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-5",
        side: "short",
        quantity: 1,
        price: 100,
        notional: 100,
        filledAt: "2026-06-15T10:00:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills, { AAPL: 120 });

    expect(pnl.unrealized).toBeCloseTo(-20);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].side).toBe("short");
    expect(pnl.openLots[0].quantity).toBeCloseTo(-1);
  });

  /**
   * Test 8: Partial cover of short position.
   * SHORT 3 @ 100, COVER 1 @ 90 → realized = 1 * (100 - 90) = +10 profit.
   * Residual short 2 @ 100, current price 110 → unrealized = 2 * (100 - 110) = -20.
   */
  it("short 3 @ 100, cover 1 @ 90: realizes +10 on matched, leaves -20 unrealized on residual", () => {
    const fills: FillEvent[] = [
      fillEvent({
        id: "short-6",
        side: "short",
        quantity: 3,
        price: 100,
        notional: 300,
        filledAt: "2026-06-15T10:00:00.000Z"
      }),
      fillEvent({
        id: "cover-6",
        side: "cover",
        quantity: 1,
        price: 90,
        notional: 90,
        filledAt: "2026-06-15T10:01:00.000Z"
      })
    ];

    const pnl = calculatePnl(fills, { AAPL: 110 });

    // Realized P&L on the 1-share covered lot
    expect(pnl.realized).toBeCloseTo(10);
    expect(pnl.closedLots).toHaveLength(1);
    expect(pnl.closedLots[0].side).toBe("short");

    // Unrealized P&L on the 2-share residual short
    expect(pnl.unrealized).toBeCloseTo(-20);
    expect(pnl.openLots).toHaveLength(1);
    expect(pnl.openLots[0].quantity).toBeCloseTo(-2); // signed: residual short is negative
    expect(pnl.openLots[0].side).toBe("short");
  });
});

/** Helper: create a FillEvent with required fields */
function fillEvent(
  input: Partial<FillEvent> & {
    id: string;
    side: OrderSide;
    quantity: number;
    price: number;
    notional: number;
    filledAt?: string;
  }
): FillEvent {
  return {
    proposalId: "p-test",
    runId: "r-test",
    accountNumber: "ACCOUNT-TEST",
    source: "paper",
    symbol: "AAPL",
    status: "filled",
    brokerOrderId: undefined,
    raw: undefined,
    filledAt: input.filledAt || "2026-06-15T10:00:00.000Z",
    ...input
  };
}
