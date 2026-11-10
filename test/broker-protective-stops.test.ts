import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import {
  brokerProtectiveStopsEnabled,
  brokerStopsForShortsEnabled,
  brokerTrailingStopsEnabled,
  cancelBrokerProtectiveStop,
  desiredBrokerStopKind,
  reconcileBrokerProtectiveStops
} from "../src/lib/broker-protective-stops";
import { getDb, listBrokerProtectiveStops, listFillEvents, upsertBrokerProtectiveStop } from "../src/lib/db";
import type { BrokerGateway, EquityOrder, EquityPosition, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-protstops-${randomUUID()}.db`)}`;
});

interface PlacedOrder { symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; trailPercent?: number; timeInForce: string }

function fakeGateway(): BrokerGateway & { placed: PlacedOrder[]; cancelled: string[]; orders: EquityOrder[]; nextOrderId: string; placeState: string; failCancel: boolean } {
  const g = {
    placed: [] as PlacedOrder[],
    cancelled: [] as string[],
    orders: [] as EquityOrder[], // returned by getEquityOrders (marker-ref reconciliation reads this)
    nextOrderId: "ord-1",
    placeState: "submitted", // set to "rejected" to simulate a non-throwing synchronous broker decline
    failCancel: false, // flip to simulate a broker cancel that fails (drives the pending_cancel retry)
    async placeEquityOrder(order: any) {
      g.placed.push({ symbol: order.symbol, side: order.side, type: order.type, quantity: order.quantity, stopPrice: order.stopPrice, trailPercent: order.trailPercent, timeInForce: order.timeInForce });
      return { orderId: g.nextOrderId, refId: order.refId, state: g.placeState, raw: {} };
    },
    async cancelEquityOrder(_accountNumber: string, orderId: string) {
      if (g.failCancel) throw new Error("simulated broker cancel failure");
      g.cancelled.push(orderId);
      return { orderId, refId: "x", state: "cancel_requested", raw: {} };
    },
    async getEquityOrders() {
      return g.orders;
    }
  };
  return g as unknown as BrokerGateway & { placed: PlacedOrder[]; cancelled: string[]; orders: EquityOrder[]; nextOrderId: string; placeState: string; failCancel: boolean };
}

function rhPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    activeBroker: "robinhood",
    robinhoodBrokerStops: true,
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8 },
    ...over
  };
}

const longPos = (symbol: string, quantity: number, averageCost: number): EquityPosition => ({
  symbol, quantity, averageCost, marketValue: quantity * averageCost
});

describe("brokerProtectiveStopsEnabled", () => {
  it("requires the flag, live RH, and a stop-loss %", () => {
    expect(brokerProtectiveStopsEnabled(rhPolicy("A"), "broker/live")).toBe(true);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A"), "broker/paper")).toBe(false);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(false);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { activeBroker: "alpaca" }), "broker/live")).toBe(true);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { activeBroker: "alpaca" }), "broker/paper")).toBe(true);
    expect(brokerProtectiveStopsEnabled(rhPolicy("A", { riskRules: { stopLossPct: 0 } }), "broker/live")).toBe(false);
  });
});

describe("reconcileBrokerProtectiveStops", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("places a resting GTC stop-market SELL at stopLossPct below entry for an open long", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-1"), accountNumber: "PS-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(r.placed).toBe(1);
    expect(r.placedStopSymbols).toEqual(["AAPL"]); // callers use this to defer same-tick synthetic registration
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", type: "stop_market", quantity: 10, stopPrice: 92, timeInForce: "gtc" });
  });

  it("is idempotent — does not double-place for a position that already has a resting stop", async () => {
    const args = { userId: "local", policy: rhPolicy("PS-2"), accountNumber: "PS-2", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true };
    await reconcileBrokerProtectiveStops(args);
    const second = await reconcileBrokerProtectiveStops(args);
    expect(second.placed).toBe(0);
    expect(gw.placed).toHaveLength(1);
  });

  it("cancels + forgets the resting stop when the position has closed", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Position gone → cancel.
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(r.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // A subsequent reconcile has nothing left to cancel.
    const r2 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-3"), accountNumber: "PS-3", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(r2.cancelled).toBe(0);
  });

  it("cancels on close even when not running, but never places while stopped", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-4"), accountNumber: "PS-4", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    gw.placed = [];
    // Not running: a new open long does NOT get a stop placed...
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-4"), accountNumber: "PS-4", gateway: gw, positions: [], executionMode: "broker/live", running: false });
    expect(gw.placed).toHaveLength(0);
    // ...but the closed AAPL position's resting stop is still cancelled.
    expect(r.cancelled).toBe(1);
  });

  it("no-ops entirely when disabled (paper mode / flag off / wrong broker)", async () => {
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-5"), accountNumber: "PS-5", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true });
    expect(r).toEqual({ placed: 0, cancelled: 0, cancelledOrderIds: [], placedStopSymbols: [], partiallyPlacedStopSymbols: [], partiallyPlacedStopQuantities: {}, filledRecoverySymbols: [] });
    expect(gw.placed).toHaveLength(0);
  });

  it("tears down (cancels + forgets) resting stops when the feature is DISABLED — no orphan", async () => {
    // Place a resting stop while enabled...
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-OFF"), accountNumber: "PS-OFF", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // ...now the owner turns the flag OFF while the position is STILL OPEN. Disabling gates only
    // placement, so the previously-placed broker stop must be cancelled (not stranded resting forever).
    const off = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-OFF", { robinhoodBrokerStops: false }), accountNumber: "PS-OFF",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(off.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // The row is gone — a second disabled reconcile has nothing left to cancel (no double-cancel).
    const again = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-OFF", { robinhoodBrokerStops: false }), accountNumber: "PS-OFF",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(again.cancelled).toBe(0);
  });

  it("retries a failed cancel on disable (pending_cancel) on the next tick — never orphans", async () => {
    // Place a resting stop while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-RETRY"), accountNumber: "PS-RETRY", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Disable, but the broker cancel FAILS this tick → the row is kept as pending_cancel (not deleted,
    // not orphaned) so it can be retried.
    gw.failCancel = true;
    const failed = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-RETRY", { robinhoodBrokerStops: false }), accountNumber: "PS-RETRY",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(failed.cancelled).toBe(0);
    expect(gw.cancelled).toEqual([]); // nothing actually cancelled yet
    // Next tick the broker cancel succeeds → the pending_cancel row is retried and cleared.
    gw.failCancel = false;
    const retried = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-RETRY", { robinhoodBrokerStops: false }), accountNumber: "PS-RETRY",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(retried.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
  });

  it("a pending_cancel row BLOCKS re-placement — the old still-live stop is never orphaned by an upsert overwrite", async () => {
    // Place while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Disable while the broker cancel FAILS → the row survives as pending_cancel, its order still
    // resting live at the broker.
    gw.failCancel = true;
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-BLOCK", { robinhoodBrokerStops: false }), accountNumber: "PS-BLOCK",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    // Re-enable with the cancel STILL failing. Placement must be BLOCKED: placing would upsert a
    // new broker_order_id over the pending_cancel row (UNIQUE user/account/symbol), leaving the old
    // still-live full-size GTC stop resting at the broker with no tracking and no cancel retry.
    gw.nextOrderId = "ord-2";
    const reEnabled = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(reEnabled.placed).toBe(0);
    expect(gw.placed).toHaveLength(1); // no second placement while the first stop's fate is unresolved
    let rows = listBrokerProtectiveStops("PS-BLOCK", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" }); // original id preserved
    // Once the cancel finally lands, the retry pass clears the row and placement resumes next pass.
    gw.failCancel = false;
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-BLOCK"), accountNumber: "PS-BLOCK", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(recovered.cancelledOrderIds).toEqual(["ord-1"]);
    expect(recovered.placed).toBe(1);
    expect(gw.placed).toHaveLength(2);
    rows = listBrokerProtectiveStops("PS-BLOCK", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-2", status: "resting" });
  });

  it("recovers a stuck pending_cancel row once the caller's order list shows it done resting — re-placement resumes the same tick", async () => {
    // Place a resting stop while enabled.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // A quantity mismatch triggers cancel-then-replace, but the cancel FAILS every tick (e.g.
    // "order not found" after an earlier cancel attempt actually landed broker-side) — the row is
    // stuck as pending_cancel.
    gw.failCancel = true;
    const stuck = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(stuck.cancelled).toBe(0);
    let rows = listBrokerProtectiveStops("PS-DEAD", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" });
    // Without evidence the order is dead, a bare retry (no `orders` passed) keeps it stuck AND
    // keeps blocking re-placement for the now-mismatched position.
    const stillStuck = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(stillStuck.cancelled).toBe(0);
    expect(stillStuck.placed).toBe(0);
    expect(listBrokerProtectiveStops("PS-DEAD", "local")).toHaveLength(1);
    expect(gw.placed).toHaveLength(1); // still no second (orphaning) placement
    // Now the caller (the synthetic-stop monitor) passes its freshly fetched order list, and
    // ord-1 shows up there already terminal ("canceled") — the earlier cancel actually landed,
    // the broker's "not found" response was just stale. Section 1 clears the row from that
    // evidence (the cancel call itself still throws), which unblocks section 4 in the SAME
    // reconcile pass — re-placement resumes immediately, not on some later tick.
    gw.nextOrderId = "ord-2";
    const orders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "canceled", createdAt: new Date().toISOString() }];
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-DEAD"), accountNumber: "PS-DEAD", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders });
    expect(recovered.cancelled).toBe(0); // recovered via the order list, not an actual successful cancel
    expect(recovered.placed).toBe(1); // section 4 immediately re-places once the block clears
    rows = listBrokerProtectiveStops("PS-DEAD", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-2", status: "resting", quantity: 12 });
  });

  it("also recovers when the caller's order list shows the stop already FILLED (cancel-of-a-fill always fails), but DEFERS re-placement to the next call — a fill actually moves the position, and `positions` was fetched by the caller before `orders`, so this call's `positions` may still be the stale pre-fill snapshot", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    gw.failCancel = true;
    // Position closed (the stop itself filled and sold the shares) → section-2 cancel-on-close
    // attempts to cancel a now-filled order, which always fails, landing it as pending_cancel.
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("PS-FILLED", "local")).toHaveLength(1);
    expect(gw.cancelled).toEqual([]); // the cancel call never actually succeeded
    // AAPL is re-bought later in the session — a fresh stop is needed, but the dead row still
    // blocks section 4 without evidence.
    const blocked = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true });
    expect(blocked.placed).toBe(0);
    // The caller's order list shows ord-1 already FILLED (a filled order can never be cancelled —
    // it's just as terminal as a rejection for this purpose). Section 1 clears the row THIS call,
    // but section 4 must NOT re-place in the same call: the `positions` array this call was handed
    // (still [longPos("AAPL", 5, 110)], simulating the caller's pre-orders-fetch snapshot) cannot be
    // trusted to already reflect a fill that section 1 only just learned about from `orders`.
    gw.nextOrderId = "ord-3";
    const orders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled", createdAt: new Date().toISOString() }];
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true, orders });
    expect(recovered.placed).toBe(0); // deferred — no same-call replacement off a possibly-stale snapshot
    expect(listBrokerProtectiveStops("PS-FILLED", "local")).toHaveLength(0); // row gone, nothing resting yet
    expect(gw.placed).toHaveLength(1); // still just the original placement — no premature second one
    // The NEXT call brings a fresh position read (no filled-order evidence needed this time — the
    // row is already gone): placement resumes normally, sized off the current quantity.
    const resumed = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-FILLED"), accountNumber: "PS-FILLED", gateway: gw, positions: [longPos("AAPL", 5, 110)], executionMode: "broker/live", running: true });
    expect(resumed.placed).toBe(1);
    const rows = listBrokerProtectiveStops("PS-FILLED", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-3", status: "resting", quantity: 5 });
  });

  it("stays conservative — never deletes a pending_cancel row when the order is ABSENT from the caller's list or still LIVE", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    gw.failCancel = true;
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("PS-LIVE", "local")).toHaveLength(1);
    // Order list fetched but doesn't contain ord-1 at all (e.g. broker excludes very old orders
    // from the default query window) — absence is NOT positive evidence of death.
    const r1 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders: [] });
    expect(r1.cancelled).toBe(0);
    expect(listBrokerProtectiveStops("PS-LIVE", "local")).toHaveLength(1);
    // Order list contains ord-1 but it's still LIVE (e.g. "confirmed") — the cancel request may
    // simply not have been processed by the broker yet. Must not delete a row for a still-live
    // order — that would orphan it (two resting sell stops, one untracked, once section 4 places
    // a replacement).
    const liveOrders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "confirmed", createdAt: new Date().toISOString() }];
    const r2 = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-LIVE"), accountNumber: "PS-LIVE", gateway: gw, positions: [longPos("AAPL", 12, 100)], executionMode: "broker/live", running: true, orders: liveOrders });
    expect(r2.cancelled).toBe(0);
    const rows = listBrokerProtectiveStops("PS-LIVE", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-1", status: "pending_cancel" });
    expect(gw.placed).toHaveLength(1); // still no second (orphaning) placement
  });

  it("ignores a synchronously REJECTED placement — no row, no placed count, symbol not advertised", async () => {
    // placeEquityOrder can resolve (not throw) with a terminal state AND an order id. Recording that
    // as a 'resting' row would (1) advertise the symbol via placedStopSymbols and suppress this
    // tick's synthetic registration for protection that doesn't exist, and (2) leave a zombie row
    // that blocks section-4 re-placement on every later tick (section 3 sees no qty/price mismatch
    // on a dead order, so nothing ever clears it until the position closes).
    gw.placeState = "rejected";
    const args = { userId: "local", policy: rhPolicy("PS-REJ"), accountNumber: "PS-REJ", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true };
    const r = await reconcileBrokerProtectiveStops(args);
    expect(gw.placed).toHaveLength(1); // the placement WAS attempted…
    expect(r.placed).toBe(0); // …but a declined stop is not a placed stop
    expect(r.placedStopSymbols).toEqual([]); // synthetic registration must not be suppressed
    expect(listBrokerProtectiveStops("PS-REJ", "local")).toHaveLength(0); // no zombie 'resting' row
    const receipts = (getDb().prepare("SELECT payload FROM audit_events WHERE kind = 'broker_protective_stop_error'").all() as Array<{ payload: string }>)
      .map((row) => JSON.parse(row.payload) as Record<string, unknown>)
      .filter((p) => p.symbol === "AAPL" && String(p.error).includes("declined the protective stop (state: rejected)"));
    expect(receipts).toHaveLength(1);
    // Recovery: nothing blocks the retry — the next tick's reconcile simply places again.
    gw.placeState = "submitted";
    const r2 = await reconcileBrokerProtectiveStops(args);
    expect(r2.placed).toBe(1);
    expect(r2.placedStopSymbols).toEqual(["AAPL"]);
    expect(listBrokerProtectiveStops("PS-REJ", "local")).toHaveLength(1);
  });

  it("cancelBrokerProtectiveStop removes a symbol's resting stop on demand", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-6"), accountNumber: "PS-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    await cancelBrokerProtectiveStop("local", "PS-6", "AAPL", gw);
    expect(gw.cancelled).toEqual(["ord-1"]);
    // It's forgotten — a reconcile with the still-open position re-places a fresh one.
    gw.nextOrderId = "ord-2";
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("PS-6"), accountNumber: "PS-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(r.placed).toBe(1);
  });

  // Codex review, PR #1738 (round 10, F#1): a pending_replace marker can now carry the REAL client ref
  // of an uncertain halted placement (the broker may have accepted it). cancelBrokerProtectiveStop must
  // reconcile that ref — cancel the accepted order by its real id — not blindly drop the marker (which
  // would leave the accepted stop live to double-sell after a synthetic exit).
  it("cancelBrokerProtectiveStop cancels the accepted order behind a real-ref pending_replace marker", async () => {
    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-REFCANCEL-AAPL", userId: "local", accountNumber: "PS-REFCANCEL",
      symbol: "AAPL", brokerOrderId: "cli-ref-1", quantity: 40, stopPrice: 92, status: "pending_replace",
      kind: "fixed"
    });
    // The broker's order list now shows the accepted order carrying that client ref.
    gw.orders = [{ id: "real-accepted", symbol: "AAPL", side: "sell", type: "stop_market", state: "queued", quantity: 40, clientOrderId: "cli-ref-1" } as EquityOrder];
    await cancelBrokerProtectiveStop("local", "PS-REFCANCEL", "AAPL", gw);
    expect(gw.cancelled).toContain("real-accepted"); // cancelled the REAL order id, not the fake ref
    expect(listBrokerProtectiveStops("PS-REFCANCEL", "local")).toHaveLength(0); // marker cleared
  });

  it("cancelBrokerProtectiveStop KEEPS a real-ref marker whose accepted order is not yet visible", async () => {
    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-REFKEEP-AAPL", userId: "local", accountNumber: "PS-REFKEEP",
      symbol: "AAPL", brokerOrderId: "cli-ref-2", quantity: 40, stopPrice: 92, status: "pending_replace",
      kind: "fixed"
    });
    gw.orders = []; // the accepted order is not (yet) visible in the list
    await cancelBrokerProtectiveStop("local", "PS-REFKEEP", "AAPL", gw);
    expect(gw.cancelled).toHaveLength(0); // never cancels the synthetic ref
    // Marker kept so the reconcile loop can cancel the accepted order once it appears (don't lose the handle).
    const rows = listBrokerProtectiveStops("PS-REFKEEP", "local");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending_replace");
  });

  // Codex review, PR #1738 (round 10, F#3): a halted quantity-shrink right-size must not LOOSEN the
  // trigger. If stopLossPct was widened, section 4 would place the right-sized replacement at the lower
  // (looser) current-policy price; the floor clamp keeps it at least as tight as the cancelled stop.
  it("halted fixed right-size clamps the replacement to the cancelled stop's tighter trigger (no loosening)", async () => {
    // Existing oversized resting fixed stop: 100 shares @ 92 (from stopLossPct 8, entry 100).
    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-FLOOR-AAPL", userId: "local", accountNumber: "PS-FLOOR",
      symbol: "AAPL", brokerOrderId: "old-fixed", quantity: 100, stopPrice: 92, status: "resting",
      kind: "fixed"
    });
    // Position shrank to 40; policy stopLossPct widened to 15 → naive replacement price would be 85 (looser).
    const haltedWidened = rhPolicy("PS-FLOOR", {
      systemState: "halted",
      riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 15, protectWhileHalted: true }
    });
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: haltedWidened, accountNumber: "PS-FLOOR", gateway: gw,
      positions: [longPos("AAPL", 40, 100)], executionMode: "broker/live", running: true,
      haltedProtectOnly: true
    });
    expect(gw.cancelled).toContain("old-fixed"); // oversized stop cancelled
    expect(r.placed).toBe(1);
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 40 });
    expect(gw.placed[0].stopPrice).toBe(92); // clamped to the tighter floor, NOT the looser 85
  });

  // Codex review, PR #1738 (round 10, F#4): when a real-ref marker's accepted order shows up already
  // FILLED/terminal, section 1 must BOOK the fill (so it reaches fill_events / P&L / learning) and drop
  // the marker — not ignore the terminal order and retry the ref forever.
  it("books the fill when a real-ref marker's accepted order is already filled, then drops the marker", async () => {
    upsertBrokerProtectiveStop({
      id: "protstop-local-PS-REFFILL-AAPL", userId: "local", accountNumber: "PS-REFFILL",
      symbol: "AAPL", brokerOrderId: "cli-ref-3", quantity: 40, stopPrice: 92, status: "pending_replace",
      kind: "fixed"
    });
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("PS-REFFILL"), accountNumber: "PS-REFFILL", gateway: gw,
      positions: [longPos("AAPL", 40, 100)], executionMode: "broker/live", running: true,
      orders: [{ id: "real-filled", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled", quantity: 40, filledQuantity: 40, averagePrice: 91.5, clientOrderId: "cli-ref-3" } as EquityOrder]
    });
    // The stop's exit was booked to fill_events (P&L/learning see it) ...
    const fills = listFillEvents("PS-REFFILL", "live", 10, "local");
    expect(fills.some((f) => f.symbol === "AAPL" && f.status === "filled")).toBe(true);
    // ... and the marker is gone (not retried).
    expect(listBrokerProtectiveStops("PS-REFFILL", "local").some((x) => x.status === "pending_replace")).toBe(false);
    expect(r.filledRecoverySymbols).toContain("AAPL");
  });
});

// ── Broker-held TRAILING stops ────────────────────────────────────────────────

function alpacaTrailPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    activeBroker: "alpaca",
    riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 },
    ...over
  };
}

function rhTrailPolicy(account: string, over: Partial<TradingPolicy> = {}): TradingPolicy {
  return rhPolicy(account, {
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 5 },
    ...over
  });
}

/** A position whose current mark can differ from entry (marketValue = qty × mark). */
const markedPos = (symbol: string, quantity: number, averageCost: number, mark: number): EquityPosition => ({
  symbol, quantity, averageCost, marketValue: quantity * mark
});

const liveSellOrder = (symbol: string, quantity: number): EquityOrder => ({
  id: `cov-${symbol}`, symbol, side: "sell", type: "stop_market", state: "new",
  quantity, timeInForce: "gtc", createdAt: new Date().toISOString(), placedAgent: "alpaca"
});

describe("brokerTrailingStopsEnabled / desiredBrokerStopKind", () => {
  it("requires a trailing %, honors the off-switch, and knows each broker's lane", () => {
    // Alpaca: native trailing in both environments.
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A"), "broker/paper")).toBe(true);
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A"), "broker/live")).toBe(true);
    // No trailing % configured → inert (the DEFAULT_POLICY case).
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A", { riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 0 } }), "broker/paper")).toBe(false);
    // The owner's off-switch.
    expect(brokerTrailingStopsEnabled(alpacaTrailPolicy("A", { brokerTrailingStops: false }), "broker/paper")).toBe(false);
    // Robinhood: live only, and only under the robinhoodBrokerStops opt-in.
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A"), "broker/live")).toBe(true);
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A"), "broker/paper")).toBe(false);
    expect(brokerTrailingStopsEnabled(rhTrailPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(false);
  });

  it("trailing takes precedence over the RH fixed lane; neither → null", () => {
    expect(desiredBrokerStopKind(rhTrailPolicy("A"), "broker/live")).toBe("trailing");
    expect(desiredBrokerStopKind(rhPolicy("A"), "broker/live")).toBe("fixed");
    expect(desiredBrokerStopKind(rhPolicy("A", { robinhoodBrokerStops: false }), "broker/live")).toBe(null);
    expect(desiredBrokerStopKind(DEFAULT_POLICY, "broker/paper")).toBe(null);
  });
});

describe("reconcileBrokerProtectiveStops — trailing lane", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("places a NATIVE trailing stop on Alpaca (trailPercent, no stopPrice) and records a trailing row", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-1"), accountNumber: "TR-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10, trailPercent: 5, timeInForce: "gtc" });
    expect(gw.placed[0].stopPrice).toBeUndefined(); // the broker computes/moves the trigger itself
    const rows = listBrokerProtectiveStops("TR-1", "local");
    expect(rows[0]).toMatchObject({ kind: "trailing", trailPercent: 5, quantity: 10 });
  });

  it("floors Alpaca native trailing stops to whole shares and skips sub-share positions", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-2"), accountNumber: "TR-2", gateway: gw,
      positions: [longPos("MSFT", 10.6, 100), longPos("NVDA", 0.4, 500)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "MSFT", quantity: 10 }); // 10.6 → 10; the synthetic monitor covers the 0.6
    // A floored (partial) placement must NOT suppress synthetic REGISTRATION — the 0.6-share
    // remainder still needs app-side protection this tick. It is advertised separately so the
    // caller only defers the FIRE path. NVDA (0.4 sh) is left entirely to the synthetic monitor.
    expect(r.placedStopSymbols).toEqual([]);
    expect(r.partiallyPlacedStopSymbols).toEqual(["MSFT"]);
  });

  it("does NOT reprice a native Alpaca trailing stop as the mark moves (the broker trails it)", async () => {
    const args = (mark: number) => ({
      userId: "local", policy: alpacaTrailPolicy("TR-3"), accountNumber: "TR-3", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, mark)], executionMode: "broker/paper" as const, running: true
    });
    await reconcileBrokerProtectiveStops(args(100));
    const r = await reconcileBrokerProtectiveStops(args(140)); // big rally — still no cancel-replace
    expect(r.cancelled).toBe(0);
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(1);
  });

  it("places a RATCHETED stop-market on live Robinhood at trail% below max(mark, entry)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("TR-4"), accountNumber: "TR-4", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/live", running: true
    });
    expect(r.placed).toBe(1);
    // 5% below the 120 mark (the observable high-water), NOT 8% below the 100 entry.
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", side: "sell", type: "stop_market", quantity: 10, stopPrice: 114, timeInForce: "gtc" });
    expect(gw.placed[0].trailPercent).toBeUndefined(); // RH MCP has no verified native trailing param
    expect(listBrokerProtectiveStops("TR-4", "local")[0]).toMatchObject({ kind: "trailing", trailPercent: 5, stopPrice: 114 });
  });

  it("ratchets the Robinhood trailing stop UP as the mark rises, and never back down", async () => {
    const args = (mark: number) => ({
      userId: "local", policy: rhTrailPolicy("TR-5"), accountNumber: "TR-5", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, mark)], executionMode: "broker/live" as const, running: true
    });
    await reconcileBrokerProtectiveStops(args(100)); // initial: trigger 95
    expect(listBrokerProtectiveStops("TR-5", "local")[0].stopPrice).toBe(95);
    // Mark rises to 120 → cancel-replace at 114.
    gw.nextOrderId = "ord-2";
    const up = await reconcileBrokerProtectiveStops(args(120));
    expect(up.cancelled).toBe(1);
    expect(up.placed).toBe(1);
    expect(listBrokerProtectiveStops("TR-5", "local")[0]).toMatchObject({ brokerOrderId: "ord-2", stopPrice: 114 });
    // Mark falls back to 105 → the 114 trigger HOLDS (ratchet, not a re-anchor).
    const down = await reconcileBrokerProtectiveStops(args(105));
    expect(down.cancelled).toBe(0);
    expect(down.placed).toBe(0);
    expect(listBrokerProtectiveStops("TR-5", "local")[0].stopPrice).toBe(114);
  });

  it("replaces a FIXED row with a TRAILING one when the trailing lane turns on (kind mismatch)", async () => {
    // Fixed stop first (trailing % not yet configured).
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("TR-6"), accountNumber: "TR-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(listBrokerProtectiveStops("TR-6", "local")[0]).toMatchObject({ kind: "fixed", stopPrice: 92 });
    // Owner sets a trailing % → same tick: cancel the fixed stop, place the trailing one.
    gw.nextOrderId = "ord-2";
    const r = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhTrailPolicy("TR-6"), accountNumber: "TR-6", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(r.cancelled).toBe(1);
    expect(r.placed).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("TR-6", "local")[0]).toMatchObject({ kind: "trailing", brokerOrderId: "ord-2", stopPrice: 95 });
  });

  it("skips placement when another live exit order already covers the position (bracket leg / manual sell)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-7"), accountNumber: "TR-7", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
      orders: [liveSellOrder("AAPL", 10)]
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    // A PARTIAL cover: the broker stop is sized to the UNCOVERED remainder only (never stacking
    // more exit quantity than the account holds), and advertised as a partial placement.
    const partial = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-7"), accountNumber: "TR-7", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
      orders: [liveSellOrder("AAPL", 3)]
    });
    expect(partial.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", quantity: 7 });
    expect(partial.placedStopSymbols).toEqual([]);
    expect(partial.partiallyPlacedStopSymbols).toEqual(["AAPL"]);
  });

  it("does NOT arm a broker trail that is already breached — the synthetic monitor owns the exit", async () => {
    // avg 100, mark 90, trail 5% → entry-seeded trigger 95 is already breached. A native trailing
    // order would restart the trail from 90 (deferring the exit by another 5%), and a ratcheted
    // stop would rest with its trigger above the market — so placement is skipped and the symbol
    // is NOT advertised, letting the synthetic monitor register and fire the app-defined exit.
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-9"), accountNumber: "TR-9", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 90)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(r.placedStopSymbols).toEqual([]);
    expect(r.partiallyPlacedStopSymbols).toEqual([]);
  });

  it("does NOT arm a NATIVE trail while the mark sits below entry (looser-than-app trigger), but the ratcheted lane still rests at the entry-seeded trigger", async () => {
    // avg 100, mark 96, trail 5%: the app's entry-seeded trigger is 95 (not yet breached), but a
    // native Alpaca trail would seed from 96 → trigger ~91.2, LOOSER than the app's. Skip native
    // placement (synthetic keeps the 95 trail) until the mark recovers to entry.
    const native = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-11"), accountNumber: "TR-11", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 96)], executionMode: "broker/paper", running: true
    });
    expect(native.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    // The ratcheted lane (live Robinhood) has no such looseness — its explicit trigger IS the
    // entry-seeded 95, still below the 96 mark, so it rests normally.
    const ratcheted = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("TR-12"), accountNumber: "TR-12", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 96)], executionMode: "broker/live", running: true
    });
    expect(ratcheted.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", type: "stop_market", stopPrice: 95 });
  });

  it("alpaca-mcp accounts take the RATCHETED lane (stop_market via their MCP transport), not REST-native trailing", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-10", { activeBroker: "alpaca-mcp" }), accountNumber: "TR-10", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/paper", running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", type: "stop_market", quantity: 10, stopPrice: 114 });
    expect(gw.placed[0].trailPercent).toBeUndefined(); // never sends the REST-only native param
  });

  it("tears trailing stops down when the owner opts out (brokerTrailingStops: false, no trailing %→fixed either)", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: alpacaTrailPolicy("TR-8"), accountNumber: "TR-8", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true });
    expect(gw.placed).toHaveLength(1);
    const off = await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("TR-8", { brokerTrailingStops: false, riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0 } }), accountNumber: "TR-8",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true
    });
    expect(off.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("TR-8", "local")).toHaveLength(0);
  });

  describe("ordersListed: false — a failed order-list fetch must never be mistaken for confirmed-empty coverage", () => {
    it("skips NEW placement entirely (never assumes coverage-free) when the caller's fetch failed", async () => {
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-13"), accountNumber: "TR-13", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: false
      });
      expect(r.placed).toBe(0);
      expect(gw.placed).toHaveLength(0);
      expect(r.placedStopSymbols).toEqual([]);
      expect(r.partiallyPlacedStopSymbols).toEqual([]);
      // Recovery: the NEXT tick's successful fetch (even an honestly-empty one) places normally.
      const recovered = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-13"), accountNumber: "TR-13", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: true
      });
      expect(recovered.placed).toBe(1);
    });

    it("leaves an EXISTING resting stop untouched (no spurious mismatch-cancel) when the caller's fetch failed", async () => {
      // Place normally first (a genuinely successful, empty fetch).
      await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-14"), accountNumber: "TR-14", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: true
      });
      expect(gw.placed).toHaveLength(1);
      // Next tick: the fetch THROWS (caller passes ordersListed: false). Without the fix, an
      // unknown-coverage read collapses to "fully uncovered", the existing 10-sh stop looks
      // undersized against a phantom "other order" story, and section 3 cancels it — then section 4
      // ALSO can't verify coverage and skips replacing it, leaving the position with NO broker-held
      // stop at all this tick.
      const failed = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-14"), accountNumber: "TR-14", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/paper", running: true,
        orders: [], ordersListed: false
      });
      expect(failed.cancelled).toBe(0);
      expect(gw.cancelled).toEqual([]);
      const stops = listBrokerProtectiveStops("TR-14", "local");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ brokerOrderId: "ord-1", status: "resting", quantity: 10 });
    });

    it("omitting ordersListed (default true) preserves the original protection-over-dedup behavior", async () => {
      // No `orders` param at all, matching every pre-existing caller/test — must place at full size
      // exactly as before this fix (ordersListed defaults to true, so an empty `orders` still reads
      // as "confirmed no coverage", never as "unknown").
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: rhPolicy("TR-15"), accountNumber: "TR-15", gateway: gw,
        positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
      });
      expect(r.placed).toBe(1);
      expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", quantity: 10 });
    });
  });

  describe("extremePriceBySymbol — never arm a broker trail looser than the app's own already-tracked high-water mark", () => {
    it("uses the synthetic monitor's tracked extreme (not just current mark) to seed the ratcheted trigger", async () => {
      // avg 100, synthetic-tracked extreme 130, mark 125 (pulled back from the peak but still above
      // the real trigger — not yet breached), trail 5%: the app's real trigger is 130*0.95=123.50.
      // Recomputing from max(mark=125, entry=100) alone would produce 118.75 — looser.
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: rhTrailPolicy("TR-16"), accountNumber: "TR-16", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 125)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(1);
      expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", stopPrice: 123.5 });
    });

    it("refuses a NATIVE trail while the mark sits below the tracked extreme, even if mark is above entry", async () => {
      // avg 100, tracked extreme 130, mark 120 (above entry, but a pullback from the real high). A
      // native Alpaca trail seeded from the current 120 mark would trail from 120, not 130 — looser
      // than the app's own trail. Must be refused; the synthetic monitor keeps covering.
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-17"), accountNumber: "TR-17", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 120)], executionMode: "broker/paper", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(0);
      expect(gw.placed).toHaveLength(0);
    });

    it("places a native trail once the mark recovers to at/above the tracked extreme", async () => {
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: alpacaTrailPolicy("TR-17b"), accountNumber: "TR-17b", gateway: gw,
        positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/paper", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.placed).toBe(1);
    });

    it("does NOT cancel an existing mismatched trail if the replacement would be refused (mark below the tracked extreme) — keeps the old stop rather than stranding the position", async () => {
      // Seed a resting trailing stop at the CORRECT (tracked-extreme-based) trigger 123.5 for a 10%
      // trail config that's about to change to 5% (forcing a "trail %" mismatch)... simpler: seed a
      // resting stop with a stale trail% so section 3 detects a mismatch, while the mark has pulled
      // back below the tracked extreme so a replacement would be refused.
      const gw2 = fakeGateway();
      const policy = rhTrailPolicy("TR-18");
      // Establish the resting stop while mark == tracked extreme (recovers, places fine).
      await reconcileBrokerProtectiveStops({
        userId: "local", policy, accountNumber: "TR-18", gateway: gw2,
        positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(gw2.placed).toHaveLength(1);
      expect(gw2.placed[0].stopPrice).toBeCloseTo(123.5);
      // Now the trail % changes (10% instead of 5%) — a genuine mismatch — but the mark has since
      // pulled back to 115, below the tracked extreme of 130. A replacement seeded from 130 at 10%
      // would be FINE (130*0.9=117, still below tracked extreme check just cares about mark vs
      // extreme for NATIVE; this is the ratcheted RH lane, whose guard is "already breached", i.e.
      // stopPrice >= mark). New trigger at 10% off 130 = 117, mark = 115 -> 117 >= 115: breached,
      // so the replacement WOULD be refused. The old (123.5) stop must be kept, not cancelled.
      const changedPolicy = rhTrailPolicy("TR-18", { riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 10 } });
      const r = await reconcileBrokerProtectiveStops({
        userId: "local", policy: changedPolicy, accountNumber: "TR-18", gateway: gw2,
        positions: [markedPos("AAPL", 10, 100, 115)], executionMode: "broker/live", running: true,
        extremePriceBySymbol: { AAPL: 130 }
      });
      expect(r.cancelled).toBe(0);
      expect(gw2.cancelled).toEqual([]);
      const stops = listBrokerProtectiveStops("TR-18", "local");
      expect(stops).toHaveLength(1);
      expect(stops[0]).toMatchObject({ stopPrice: 123.5, trailPercent: 5 }); // unchanged — old stop kept
    });
  });
});

// ── Round-5 Codex findings: stale rows, oversized-unknown-coverage, and quantity-shrink cancels ──

describe("reconcileBrokerProtectiveStops — round-5 mismatch/staleness fixes (Codex review, PR #1331)", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("clears a stale 'resting' row whose tracked order already went FILLED without going through cancel-recovery, deferring re-placement to the next call", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-1"), accountNumber: "R5-1", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // The resting stop filled naturally (no app-issued cancel ever ran) — the DB row is still
    // "resting", but the caller's freshly fetched order list shows ord-1 already FILLED. Without
    // checking the tracked order's terminal state, section 3 would only look for a numeric
    // mismatch (which may not exist) and never notice the row is a ghost.
    const orders: EquityOrder[] = [{ id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled", createdAt: new Date().toISOString() }];
    gw.nextOrderId = "ord-2";
    const recovered = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-1"), accountNumber: "R5-1", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true, orders });
    expect(recovered.cancelled).toBe(0); // no cancel call — the order already finished on its own
    expect(recovered.placed).toBe(0); // deferred: `positions` may still be the stale pre-fill snapshot
    expect(listBrokerProtectiveStops("R5-1", "local")).toHaveLength(0); // stale row is gone, not left resting
    // Next call resumes placement normally once a fresh position read is in hand.
    const resumed = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-1"), accountNumber: "R5-1", gateway: gw, positions: [longPos("AAPL", 6, 100)], executionMode: "broker/live", running: true });
    expect(resumed.placed).toBe(1);
    expect(listBrokerProtectiveStops("R5-1", "local")[0]).toMatchObject({ brokerOrderId: "ord-2", quantity: 6 });
  });

  it("resizes (cancels) an oversized existing stop when the position has shrunk, even though other-order coverage is unknown this tick", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-2"), accountNumber: "R5-2", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    expect(listBrokerProtectiveStops("R5-2", "local")[0]).toMatchObject({ quantity: 10 });
    // The position has shrunk to 4 shares (some other exit filled elsewhere), but THIS tick's order
    // list fetch failed (`ordersListed: false`) — other-order coverage is unknown. The existing
    // 10-share stop now exceeds the 4-share position: if it ever fires it could sell more shares
    // than the account holds. That is knowable from `positions` alone and must not wait for a
    // successful order-list fetch to be corrected.
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R5-2"), accountNumber: "R5-2", gateway: gw,
      positions: [longPos("AAPL", 4, 100)], executionMode: "broker/live", running: true,
      orders: [], ordersListed: false
    });
    expect(r.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("R5-2", "local")).toHaveLength(0);
    expect(r.placed).toBe(0); // still no same-tick replacement — other coverage stays unknown
    // Next tick, once the order list can be read again, a correctly-sized stop is placed.
    gw.nextOrderId = "ord-2";
    const resumed = await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-2"), accountNumber: "R5-2", gateway: gw, positions: [longPos("AAPL", 4, 100)], executionMode: "broker/live", running: true });
    expect(resumed.placed).toBe(1);
    expect(listBrokerProtectiveStops("R5-2", "local")[0]).toMatchObject({ brokerOrderId: "ord-2", quantity: 4 });
  });

  it("leaves an existing stop untouched on unknown coverage when it is NOT oversized for the current position", async () => {
    await reconcileBrokerProtectiveStops({ userId: "local", policy: rhPolicy("R5-3"), accountNumber: "R5-3", gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true });
    expect(gw.placed).toHaveLength(1);
    // Position UNCHANGED, order-list fetch failed — the row is not oversized, so it must be left
    // exactly as-is (the pre-existing "unknown coverage" behavior for the common case).
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R5-3"), accountNumber: "R5-3", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      orders: [], ordersListed: false
    });
    expect(r.cancelled).toBe(0);
    expect(gw.cancelled).toEqual([]);
    expect(listBrokerProtectiveStops("R5-3", "local")[0]).toMatchObject({ brokerOrderId: "ord-1", quantity: 10 });
  });

  it("cancels a trailing stop on a KNOWN quantity SHRINK even though a replacement would be refused this tick (does not leave it stacked on top of other known coverage)", async () => {
    // Ratcheted (Robinhood) trailing lane: avg 100, mark 100 → trigger 95, arms fine at 10 shares.
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("R5-4"), accountNumber: "R5-4", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]).toMatchObject({ stopPrice: 95, quantity: 10 });
    // Next tick: another live exit order (a separate manual 4-share limit sell, unrelated to our
    // resting stop) now covers part of the position, so only 6 shares are actually uncovered — a
    // genuine quantity-drift mismatch. The mark has also fallen to 90, below the 95 trigger, so a
    // replacement trail would be REFUSED (already breached) — but the old 10-share stop still stacks
    // on top of the other 4-share order if both can fill, so it must be cancelled regardless.
    const otherOrder: EquityOrder = {
      id: "manual-tp-1", symbol: "AAPL", side: "sell", type: "limit", quantity: 4,
      state: "new", createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("R5-4"), accountNumber: "R5-4", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 90)], executionMode: "broker/live", running: true,
      orders: [otherOrder]
    });
    expect(r.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("R5-4", "local")).toHaveLength(0);
    expect(r.placed).toBe(0); // a fresh replacement is STILL refused this tick (already breached) — the
    // synthetic monitor covers the gap until the mark recovers or the next tick re-evaluates
  });
});

describe("reconcileBrokerProtectiveStops — per-position stop plans (never invent, only narrow)", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("a 'none' plan never places a broker-held stop for that symbol, even with a lane enabled account-wide", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-1"), accountNumber: "SP-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "none" }
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(listBrokerProtectiveStops("SP-1", "local")).toHaveLength(0);
  });

  it("a 'none' plan set AFTER a stop was already placed tears it down (never silently contradicts the owner/LLM choice)", async () => {
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-2"), accountNumber: "SP-2", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(gw.placed).toHaveLength(1);
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-2"), accountNumber: "SP-2", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "none" }
    });
    expect(r.cancelled).toBe(1);
    expect(gw.cancelled).toEqual(["ord-1"]);
    expect(listBrokerProtectiveStops("SP-2", "local")).toHaveLength(0);
  });

  it("a 'trailing' plan on an account whose only enabled lane is the RH fixed stop excludes that symbol entirely (never force-substitutes fixed)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-3"), accountNumber: "SP-3", gateway: gw, // fixed lane only — no trailing % configured
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "trailing" }
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(listBrokerProtectiveStops("SP-3", "local")).toHaveLength(0);
  });

  it("a 'fixed' plan on an account whose only TRULY enabled lane is trailing (no stop-loss % configured at all) excludes that symbol entirely (never force-substitutes trailing)", async () => {
    const trailOnly = rhPolicy("SP-4", { riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 0, trailingStopPct: 5 } });
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: trailOnly, accountNumber: "SP-4", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "fixed" }
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(listBrokerProtectiveStops("SP-4", "local")).toHaveLength(0);
  });

  it("a 'fixed' plan uses the fixed lane even on an account where trailing WINS the account-wide precedence, as long as the fixed lane is independently enabled too (kind===\"trailing\" must not be read as \"fixed is unavailable\" — Codex review, PR #1371)", async () => {
    // rhTrailPolicy has BOTH stopLossPct and trailingStopPct configured — desiredBrokerStopKind
    // resolves the ACCOUNT-WIDE kind to "trailing" (trailing wins precedence), but the fixed lane
    // (robinhoodBrokerStops + live + RH + stopLossPct>0) is independently, genuinely enabled.
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("SP-4B"), accountNumber: "SP-4B", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "fixed" }
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", stopPrice: 92, type: "stop_market" }); // 100 * (1 - 8/100), the flat lane's own pricing
    expect(listBrokerProtectiveStops("SP-4B", "local")).toHaveLength(1);
  });

  it("an 'atr' plan on an account whose only enabled lane is trailing also excludes that symbol (same narrowing as 'fixed')", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("SP-5"), accountNumber: "SP-5", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "atr" }
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
  });

  it("an 'atr' plan NEVER places a broker-held stop, even on an account whose own lane is fixed (this reconciler only knows the flat stopLossPct, not the pinned ATR distance — mispricing it would silently contradict the plan; the synthetic monitor prices it correctly instead)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-8"), accountNumber: "SP-8", gateway: gw, // fixed lane only
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "atr" }
    });
    expect(r.placed).toBe(0);
    expect(gw.placed).toHaveLength(0);
    expect(listBrokerProtectiveStops("SP-8", "local")).toHaveLength(0);
  });

  it("a 'trailing' plan on an account where trailing is ALREADY the enabled lane is a pure no-op (matches the account's own kind)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhTrailPolicy("SP-6"), accountNumber: "SP-6", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { AAPL: "trailing" }
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", stopPrice: 95 });
  });

  it("a plan on a DIFFERENT symbol does not affect this one, and 'default'/absent keeps the account's own precedence", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("SP-7"), accountNumber: "SP-7", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true,
      stopPlanBySymbol: { TSLA: "none" }
    });
    expect(r.placed).toBe(1);
    expect(gw.placed[0]).toMatchObject({ symbol: "AAPL", stopPrice: 92 });
  });
});

describe("reconcileBrokerProtectiveStops — round-7: never cancel an ACTIVELY EXECUTING order (Codex review, PR #1331)", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("leaves a 'partially_filled' tracked stop resting untouched even when the recomputed quantity would otherwise look like drift", async () => {
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R7-1"), accountNumber: "R7-1", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(gw.placed).toHaveLength(1);
    // The resting stop is actively executing (partial fill in progress) — the position hasn't yet
    // reflected the full effect, so the naive recompute below would look like a quantity mismatch,
    // but cancelling an order mid-execution risks aborting the rest of a working exit.
    const partiallyFilledOrder: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "partially_filled",
      quantity: 10, filledQuantity: 4, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R7-1"), accountNumber: "R7-1", gateway: gw,
      positions: [longPos("AAPL", 6, 100)], executionMode: "broker/live", running: true,
      orders: [partiallyFilledOrder]
    });
    expect(r.cancelled).toBe(0);
    expect(gw.cancelled).toEqual([]);
    expect(listBrokerProtectiveStops("R7-1", "local")[0]).toMatchObject({ brokerOrderId: "ord-1", quantity: 10 });
  });
});

describe("reconcileBrokerProtectiveStops — round-9 (Codex review, PR #1331)", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  it("recovers a FILLED broker-held stop during disabled teardown (kind === null) instead of retrying its cancel forever with the fill never booked", async () => {
    // Place while the fixed lane is enabled...
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R9-TEARDOWN"), accountNumber: "R9-TEARDOWN", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(listBrokerProtectiveStops("R9-TEARDOWN", "local")).toHaveLength(1);

    // ...then the feature is turned off (kind resolves to null) WHILE the stop already filled at the
    // broker. The cancel attempt fails (a filled order can't be cancelled), and the caller's order
    // list shows it as terminal-filled.
    gw.failCancel = true;
    const filledOrder: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled",
      filledQuantity: 10, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R9-TEARDOWN", { robinhoodBrokerStops: false }), accountNumber: "R9-TEARDOWN", gateway: gw,
      positions: [], executionMode: "broker/live", running: true, orders: [filledOrder]
    });
    expect(r.cancelled).toBe(0); // the cancel call itself still failed
    expect(listBrokerProtectiveStops("R9-TEARDOWN", "local")).toHaveLength(0); // but recovered, not left pending_cancel
    expect(listFillEvents("R9-TEARDOWN", "live")).toHaveLength(1); // the fill IS booked, not lost
    expect(listFillEvents("R9-TEARDOWN", "live")[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10, status: "filled" });
  });

  it("books a PARTIAL fill during stale-row cleanup even when the tracked order's overall terminal state is canceled/expired, not literally 'filled'", async () => {
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R9-PARTIAL"), accountNumber: "R9-PARTIAL", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(listBrokerProtectiveStops("R9-PARTIAL", "local")).toHaveLength(1);

    // The resting stop partially executed (3 of 10 shares) before the remainder was canceled —
    // overall state is "canceled", not "filled", but real shares DID trade.
    const partiallyExecutedThenCanceled: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "canceled",
      filledQuantity: 3, averagePrice: 92, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R9-PARTIAL"), accountNumber: "R9-PARTIAL", gateway: gw,
      positions: [longPos("AAPL", 7, 100)], executionMode: "broker/live", running: true,
      orders: [partiallyExecutedThenCanceled]
    });
    expect(listBrokerProtectiveStops("R9-PARTIAL", "local")).toHaveLength(0);
    expect(r.filledRecoverySymbols).toEqual(["AAPL"]); // deferred like a full fill — position moved
    const fills = listFillEvents("R9-PARTIAL", "live");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 3, price: 92, status: "filled" });
  });

  it("never reseeds a native trail's mismatch-driven REPLACEMENT looser than the broker's own (never independently registered) high-water mark", async () => {
    // Entry 100, rally to 130 — the native trail seeds at 130 * 0.95 = 123.50. Full native coverage
    // means the synthetic monitor never registers its own row for this symbol, so
    // extremePriceBySymbol has no entry for it at all.
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("R9-HWM"), accountNumber: "R9-HWM", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/paper", running: true
    });
    expect(listBrokerProtectiveStops("R9-HWM", "local")[0]).toMatchObject({ stopPrice: 123.5, trailPercent: 5 });

    // Price pulls back to 126 (still above entry, but below the true 130 peak) and the trail %
    // changes 5% -> 6%, forcing a mismatch check. A naive trackedExtreme=0 would compute
    // 126 * (1 - 0.06) = 118.44 and wrongly permit replacing the existing (tighter) 123.50 stop with
    // this looser one — reducing real protection on a live position.
    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaTrailPolicy("R9-HWM", { riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 6 } }),
      accountNumber: "R9-HWM", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 126)], executionMode: "broker/paper", running: true
    });
    expect(r.cancelled).toBe(0); // refused — the backfilled 130 peak means 126 is still a pullback
    expect(gw.cancelled).toEqual([]);
    expect(listBrokerProtectiveStops("R9-HWM", "local")[0]).toMatchObject({ stopPrice: 123.5, trailPercent: 5 }); // unchanged
  });

  it("still allows the mismatch-driven replacement once the mark genuinely reaches/exceeds the backfilled peak", async () => {
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("R9-HWM-2"), accountNumber: "R9-HWM-2", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 130)], executionMode: "broker/paper", running: true
    });
    expect(listBrokerProtectiveStops("R9-HWM-2", "local")[0]).toMatchObject({ stopPrice: 123.5, trailPercent: 5 });

    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaTrailPolicy("R9-HWM-2", { riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 6 } }),
      accountNumber: "R9-HWM-2", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 135)], executionMode: "broker/paper", running: true // above the 130 peak
    });
    expect(r.cancelled).toBe(1);
    expect(listBrokerProtectiveStops("R9-HWM-2", "local")[0]).toMatchObject({ trailPercent: 6, stopPrice: 126.9 }); // 135 * 0.94
  });

  it("backfills the broker's TRUE ratcheted peak from the LIVE order's reported stopPrice — a native trail placed at entry then rallied is not reseeded looser on a later mismatch", async () => {
    // Unlike the two tests above (which place the position ALREADY at its peak, so inverting the DB
    // row happens to recover the true peak), this places AT ENTRY (mark == avgCost == 100). The
    // native trail's DB row records stopPrice = 100 * 0.95 = 95 and is NEVER repriced as the position
    // rallies (the broker moves its own trigger; only a trail%/qty mismatch forces a replace). So
    // inverting ONLY the DB row reconstructs a peak of just 95 / 0.95 = 100 (≈ entry) — missing the
    // broker's true, silently-ratcheted high-water mark entirely.
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: alpacaTrailPolicy("R13-HWM"), accountNumber: "R13-HWM", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 100)], executionMode: "broker/paper", running: true
    });
    expect(listBrokerProtectiveStops("R13-HWM", "local")[0]).toMatchObject({ stopPrice: 95, trailPercent: 5 });

    // The position rallied to a peak of 150 — the broker's native trail silently ratcheted its
    // trigger to 150 * 0.95 = 142.5, reported on the still-resting order as `stopPrice` — then pulled
    // back to 140. A trail% change 5% -> 6% forces a mismatch check. Backfilling ONLY from the stale
    // DB row (95 -> peak 100) would let canArmTrailingNow see mark 140 >= max(100, 100) and PERMIT
    // replacing the broker's 142.5-equivalent trail with one seeded from 140 (real trigger 131.6) —
    // measurably LOOSER. The fix also inverts the live order's broker-reported 142.5 (-> peak 150),
    // takes the max, and thus refuses: 140 is a pullback from the true 150 peak.
    const restingNativeTrail: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "new",
      quantity: 10, stopPrice: 142.5, timeInForce: "gtc", createdAt: new Date().toISOString(), placedAgent: "alpaca"
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaTrailPolicy("R13-HWM", { riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 6 } }),
      accountNumber: "R13-HWM", gateway: gw,
      positions: [markedPos("AAPL", 10, 100, 140)], executionMode: "broker/paper", running: true,
      orders: [restingNativeTrail]
    });
    expect(r.cancelled).toBe(0); // refused — the live order's 142.5 trigger implies a 150 peak, and 140 is a pullback
    expect(gw.cancelled).toEqual([]);
    expect(listBrokerProtectiveStops("R13-HWM", "local")[0]).toMatchObject({ stopPrice: 95, trailPercent: 5 }); // unchanged
  });

  it("disabled-teardown FILLED recovery via the CATCH branch also reports filledRecoverySymbols so the caller defers off the stale position", async () => {
    // Place a fixed broker stop while enabled...
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R14-CATCH"), accountNumber: "R14-CATCH", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(listBrokerProtectiveStops("R14-CATCH", "local")).toHaveLength(1);

    // ...then the feature is turned off (kind === null) while the stop already FILLED. The cancel
    // call fails (a filled order can't be cancelled), so recovery comes from the order list. The
    // fix: besides booking the fill, the catch branch must PUSH filledRecoverySymbols so the caller
    // skips synthetic registration/fire off the stale (pre-fill) position snapshot this tick.
    gw.failCancel = true;
    const filledOrder: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled",
      filledQuantity: 10, averagePrice: 92, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R14-CATCH", { robinhoodBrokerStops: false }), accountNumber: "R14-CATCH", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true, orders: [filledOrder]
    });
    expect(r.cancelled).toBe(0); // the cancel call itself failed
    expect(r.filledRecoverySymbols).toEqual(["AAPL"]); // recovered AND reported to the caller
    expect(listBrokerProtectiveStops("R14-CATCH", "local")).toHaveLength(0); // recovered, not left pending_cancel
    expect(listFillEvents("R14-CATCH", "live")).toHaveLength(1); // the fill IS booked
  });

  it("disabled-teardown SUCCESS path books a PARTIAL fill and reports filledRecoverySymbols instead of silently dropping the executed shares", async () => {
    // Place a fixed broker stop while enabled...
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R17-SUCCESS"), accountNumber: "R17-SUCCESS", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(listBrokerProtectiveStops("R17-SUCCESS", "local")).toHaveLength(1);

    // ...then the feature is turned off (kind === null). The resting stop PARTIALLY executed (3 of 10
    // shares) and the broker accepts the cancel of the open remainder — so the cancel SUCCEEDS (this
    // is the realistic path for a partial, distinct from the catch branch which fires when a fully
    // filled order's cancel is rejected). The fix: the success path must consult the pre-fetched
    // order list, book the 3-share fill, and report the symbol — before the fix it deleted the row
    // with no lookup, dropping the real broker sell from fill_events / P&L / learning.
    const partiallyFilledThenCancelable: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "partially_filled",
      filledQuantity: 3, averagePrice: 92, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("R17-SUCCESS", { robinhoodBrokerStops: false }), accountNumber: "R17-SUCCESS", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true, orders: [partiallyFilledThenCancelable]
    });
    expect(r.cancelled).toBe(1); // the cancel of the open remainder succeeded
    expect(r.filledRecoverySymbols).toEqual(["AAPL"]); // caller told the position moved
    expect(listBrokerProtectiveStops("R17-SUCCESS", "local")).toHaveLength(0);
    const fills = listFillEvents("R17-SUCCESS", "live");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 3, price: 92, status: "filled" }); // the partial, not the full row qty
  });

  it("Item 5: does not double-place when the broker accepts an order but the reply is lost — adopts it on a later tick instead", async () => {
    // Simulate "the broker accepted the order, but our process crashed/timed out before the reply
    // came back" — placeEquityOrder captures the client ref it was given, then throws.
    let capturedRefId: string | undefined;
    let placeCallCount = 0;
    let throwOnPlace = true;
    (gw as unknown as { placeEquityOrder: (order: Record<string, unknown>) => Promise<unknown> }).placeEquityOrder = async (order: Record<string, unknown>) => {
      placeCallCount++;
      capturedRefId = order.refId as string;
      if (throwOnPlace) throw new Error("simulated network timeout after broker accept");
      return { orderId: gw.nextOrderId, refId: order.refId, state: gw.placeState, raw: {} };
    };

    const account = "PS-CRASH";
    const args = {
      userId: "local", policy: rhPolicy(account), accountNumber: account, gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true
    };

    // Tick 1: the broker call throws. No resting stop is recorded (never got that far), but a
    // durable "placing" intent MUST persist — that's the only trace a request was ever sent.
    const r1 = await reconcileBrokerProtectiveStops(args);
    expect(r1.placed).toBe(0);
    expect(listBrokerProtectiveStops(account, "local")).toHaveLength(0); // no zombie 'resting' row
    expect(placeCallCount).toBe(1);
    expect(capturedRefId).toBeTruthy();

    const { getBrokerStopPlacementIntent } = await import("../src/lib/db");
    const intent = getBrokerStopPlacementIntent(account, "AAPL", "local");
    expect(intent).toBeTruthy();
    expect(intent!.clientOrderId).toBe(capturedRefId);
    expect(intent!.quantity).toBe(10);

    // Tick 2: a naive retry with no memory of tick 1 would just place a SECOND full-size stop. The
    // caller's freshly fetched order list now shows the broker DID accept the earlier request (it
    // just never sent a reply) — reconcile must ADOPT that live order rather than duplicate it.
    throwOnPlace = false; // if this regressed to placing again, placeCallCount would tick to 2
    const liveAcceptedOrder: EquityOrder = {
      id: "ord-real-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "new",
      clientOrderId: capturedRefId, quantity: 10, stopPrice: 92, createdAt: new Date().toISOString()
    };
    const r2 = await reconcileBrokerProtectiveStops({ ...args, orders: [liveAcceptedOrder] });
    expect(r2.placed).toBe(1);
    expect(r2.placedStopSymbols).toEqual(["AAPL"]);
    // The broker was only ever actually called ONCE across both ticks — tick 2 adopted instead of
    // re-submitting.
    expect(placeCallCount).toBe(1);
    const rows = listBrokerProtectiveStops(account, "local");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brokerOrderId: "ord-real-1", status: "resting", quantity: 10 });
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeUndefined(); // intent cleared
  });

  it("Item 5: keeps an unresolved intent on non-authoritative absence instead of double-placing", async () => {
    let placeCallCount = 0;
    let throwOnPlace = true;
    (gw as unknown as { placeEquityOrder: (order: Record<string, unknown>) => Promise<unknown> }).placeEquityOrder = async (order: Record<string, unknown>) => {
      placeCallCount++;
      if (throwOnPlace) throw new Error("simulated network timeout after broker accept");
      return { orderId: gw.nextOrderId, refId: order.refId, state: gw.placeState, raw: {} };
    };
    const account = "PS-CRASH-NONAUTH";
    const args = {
      userId: "local", policy: rhPolicy(account), accountNumber: account, gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true
    };
    await reconcileBrokerProtectiveStops(args); // tick 1: throws, leaves an intent
    const { getBrokerStopPlacementIntent } = await import("../src/lib/db");
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeTruthy();

    // Tick 2: Robinhood-style/non-authoritative lists cannot prove that an absent client ref never
    // landed. The intent must stay in place and section 4 must not submit a second full-size stop.
    throwOnPlace = false;
    gw.nextOrderId = "ord-duplicate";
    const r2 = await reconcileBrokerProtectiveStops({ ...args, orders: [], ordersListed: true });
    expect(r2.placed).toBe(0);
    expect(placeCallCount).toBe(1);
    expect(listBrokerProtectiveStops(account, "local")).toHaveLength(0);
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeTruthy();
  });

  it("Item 5: clears a confirmed-dead intent and places fresh on authoritative absent evidence", async () => {
    let placeCallCount = 0;
    let throwOnPlace = true;
    (gw as unknown as { placeEquityOrder: (order: Record<string, unknown>) => Promise<unknown> }).placeEquityOrder = async (order: Record<string, unknown>) => {
      placeCallCount++;
      if (throwOnPlace) throw new Error("simulated network timeout after broker accept");
      return { orderId: gw.nextOrderId, refId: order.refId, state: gw.placeState, raw: {} };
    };
    const account = "PS-CRASH-DEAD";
    const args = {
      userId: "local", policy: rhPolicy(account), accountNumber: account, gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true
    };
    await reconcileBrokerProtectiveStops(args); // tick 1: throws, leaves an intent
    const { getBrokerStopPlacementIntent } = await import("../src/lib/db");
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeTruthy();

    // Tick 2: an AUTHORITATIVE fetch shows nothing matching the intent's client
    // ref at all — positive evidence the earlier submission never landed. The stale intent must be
    // cleared and a fresh placement attempted (not stuck waiting forever).
    throwOnPlace = false;
    Object.defineProperty(gw, "ordersListIncludesTerminal", { value: true });
    gw.nextOrderId = "ord-fresh";
    const r2 = await reconcileBrokerProtectiveStops({ ...args, orders: [] });
    expect(r2.placed).toBe(1);
    expect(placeCallCount).toBe(2); // tick 1's failed attempt + tick 2's fresh one — never stuck
    expect(listBrokerProtectiveStops(account, "local")[0]).toMatchObject({ brokerOrderId: "ord-fresh", status: "resting" });
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeUndefined();
  });

  it("Item 6: a recovered stop fill is booked exactly once even on a replayed recovery (transaction + unique-index idempotency)", async () => {
    // Place a fixed broker stop while enabled...
    await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("ITEM6-REPLAY"), accountNumber: "ITEM6-REPLAY", gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true
    });
    expect(listBrokerProtectiveStops("ITEM6-REPLAY", "local")).toHaveLength(1);

    // ...then the feature is disabled while the stop has already FILLED at the broker. Recovery
    // deletes the tracking row and books the fill together.
    const filledOrder: EquityOrder = {
      id: "ord-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled",
      filledQuantity: 10, averagePrice: 92, createdAt: new Date().toISOString()
    };
    const r = await reconcileBrokerProtectiveStops({
      userId: "local", policy: rhPolicy("ITEM6-REPLAY", { robinhoodBrokerStops: false }), accountNumber: "ITEM6-REPLAY",
      gateway: gw, positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live", running: true, orders: [filledOrder]
    });
    expect(r.filledRecoverySymbols).toEqual(["AAPL"]);
    expect(listBrokerProtectiveStops("ITEM6-REPLAY", "local")).toHaveLength(0); // tracking gone
    const firstFills = listFillEvents("ITEM6-REPLAY", "live");
    expect(firstFills).toHaveLength(1);

    // Replay: a crash right after this recovery committed (before the caller could act on the
    // result) would retry the SAME recovery against the SAME broker order. Since the tracking row
    // (delete) and the fill (insert) landed together in one transaction, there is nothing left to
    // re-delete — but if some other path ever attempts to book this exact fill again (the scenario
    // the broker-held-stop-recovery unique index exists for), it must be an idempotent no-op, not a duplicate.
    const { insertFillEvent } = await import("../src/lib/db");
    const replay = insertFillEvent({
      userId: "local", accountNumber: "ITEM6-REPLAY", source: "live", executionMode: "broker/live",
      symbol: "AAPL", side: "sell", quantity: 10, price: 92, notional: 920, status: "filled",
      brokerOrderId: "ord-1", raw: { brokerHeldProtectiveStop: true, kind: "fixed" }
    });
    expect(replay.id).toBe(firstFills[0].id); // idempotent no-op, returns the already-booked fill
    expect(listFillEvents("ITEM6-REPLAY", "live")).toHaveLength(1); // still exactly once, not twice
  });

  it("Item 5+6: intent reconciliation when the accepted order already FILLED before the next tick — books the fill, defers re-placement (2026-07-18 adversarial finding)", async () => {
    // Gap under attack: the intent lane handled adopt-if-LIVE and confirmed-dead-by-ABSENCE, but not
    // the third outcome — the accepted order is VISIBLE in the fetched list but already TERMINAL
    // with executed quantity (the stop was accepted after the crash and FILLED before the next tick;
    // entirely plausible for a stop placed into a falling market, which is exactly when stops fill).
    // Pre-fix: the intent fell into the confirm-dead lane, NO fill was booked, and section 4
    // immediately placed a fresh full-size stop sized off the stale pre-fill position snapshot
    // (fill lost + possible over-sell short).
    let capturedRefId: string | undefined;
    let throwOnPlace = true;
    (gw as unknown as { placeEquityOrder: (order: Record<string, unknown>) => Promise<unknown> }).placeEquityOrder = async (order: Record<string, unknown>) => {
      capturedRefId = order.refId as string;
      if (throwOnPlace) throw new Error("simulated network timeout after broker accept");
      gw.placed.push({ symbol: order.symbol as string, side: order.side as string, type: order.type as string, quantity: order.quantity as number, stopPrice: order.stopPrice as number, timeInForce: order.timeInForce as string });
      return { orderId: gw.nextOrderId, refId: order.refId, state: gw.placeState, raw: {} };
    };

    const account = "ADV-INTENT-FILLED";
    const args = {
      userId: "local", policy: rhPolicy(account), accountNumber: account, gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true
    };

    // Tick 1: placement throws after the broker (invisibly) accepted — durable intent persists.
    const r1 = await reconcileBrokerProtectiveStops(args);
    expect(r1.placed).toBe(0);
    const { getBrokerStopPlacementIntent } = await import("../src/lib/db");
    const intent = getBrokerStopPlacementIntent(account, "AAPL", "local");
    expect(intent).toBeTruthy();
    expect(intent!.clientOrderId).toBe(capturedRefId);

    // Between ticks: the accepted stop (10 sh @ trigger 92) FILLED — the position is really 0 now,
    // but this tick's `positions` snapshot (fetched before orders, per synthetic-stops.ts ordering)
    // still shows the pre-fill 10 shares. The freshly fetched order list shows the terminal order
    // carrying the intent's client ref (Alpaca getEquityOrders pages status:"all", so terminal
    // orders ARE visible).
    throwOnPlace = false;
    const filledAcceptedOrder: EquityOrder = {
      id: "ord-real-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "filled",
      clientOrderId: intent!.clientOrderId, quantity: 10, filledQuantity: 10, averagePrice: 92,
      createdAt: new Date().toISOString()
    };
    const r2 = await reconcileBrokerProtectiveStops({ ...args, orders: [filledAcceptedOrder] });

    // Intent must be resolved either way.
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeUndefined();

    // (b) The same tick must NOT place a fresh full-size stop sized off the stale 10-share
    // snapshot: those shares were just sold by the recovered fill. Defers via filledRecoverySymbols
    // for exactly this reason.
    expect(gw.placed).toHaveLength(0);
    expect(r2.filledRecoverySymbols).toEqual(["AAPL"]);
    expect(listBrokerProtectiveStops(account, "local")).toHaveLength(0);

    // (a) The executed 10-share sell MUST reach fill_events — this is real money that moved.
    const fills = listFillEvents(account, "live");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10, price: 92, status: "filled" });
  });

  it("Item 5+6: a visible-but-terminal intent order with ZERO executed quantity is confirmed dead — places fresh, books nothing", async () => {
    let throwOnPlace = true;
    (gw as unknown as { placeEquityOrder: (order: Record<string, unknown>) => Promise<unknown> }).placeEquityOrder = async (order: Record<string, unknown>) => {
      if (throwOnPlace) throw new Error("simulated network timeout after broker accept");
      gw.placed.push({ symbol: order.symbol as string, side: order.side as string, type: order.type as string, quantity: order.quantity as number, stopPrice: order.stopPrice as number, timeInForce: order.timeInForce as string });
      return { orderId: gw.nextOrderId, refId: order.refId, state: gw.placeState, raw: {} };
    };
    const account = "ADV-INTENT-DEADZERO";
    const args = {
      userId: "local", policy: rhPolicy(account), accountNumber: account, gateway: gw,
      positions: [longPos("AAPL", 10, 100)], executionMode: "broker/live" as const, running: true
    };
    await reconcileBrokerProtectiveStops(args); // tick 1: throws, leaves an intent
    const { getBrokerStopPlacementIntent } = await import("../src/lib/db");
    const intent = getBrokerStopPlacementIntent(account, "AAPL", "local");
    expect(intent).toBeTruthy();

    // Tick 2: the order IS visible but terminal with nothing executed (broker canceled it outright,
    // e.g. risk-check kill) — genuinely dead, position untouched. Fresh placement must proceed and
    // no phantom fill may be booked.
    throwOnPlace = false;
    gw.nextOrderId = "ord-fresh-2";
    const canceledZeroFill: EquityOrder = {
      id: "ord-dead-1", symbol: "AAPL", side: "sell", type: "stop_market", state: "canceled",
      clientOrderId: intent!.clientOrderId, quantity: 10, createdAt: new Date().toISOString()
    };
    const r2 = await reconcileBrokerProtectiveStops({ ...args, orders: [canceledZeroFill] });
    expect(r2.placed).toBe(1);
    expect(r2.filledRecoverySymbols).toEqual([]);
    expect(gw.placed).toHaveLength(1); // the fresh placement
    expect(listFillEvents(account, "live")).toHaveLength(0); // nothing executed, nothing booked
    expect(listBrokerProtectiveStops(account, "local")[0]).toMatchObject({ brokerOrderId: "ord-fresh-2", status: "resting" });
    expect(getBrokerStopPlacementIntent(account, "AAPL", "local")).toBeUndefined();
  });
});

describe("reconcilePendingBracketTeardowns", () => {
  function gatewayWithBracketCancel(impl?: (accountNumber: string, orderId: string) => Promise<{ cancelledOrderIds: string[] }>): BrokerGateway & { calls: Array<{ accountNumber: string; orderId: string }> } {
    const calls: Array<{ accountNumber: string; orderId: string }> = [];
    return {
      async getAccounts() { return []; },
      async getPortfolio() { return { accountNumber: "x", totalMarketValue: 0, buyingPower: 0, equityMarketValue: 0, optionMarketValue: 0, cash: 0 }; },
      async getEquityPositions() { return []; },
      async getEquityOrders() { return []; },
      async getEquityQuotes() { return {}; },
      async getEquityTradability() { return {}; },
      async reviewEquityOrder() { return { estimatedNotional: 0, alerts: [], raw: {} }; },
      async placeEquityOrder() { throw new Error("not used in this test"); },
      async cancelEquityOrder() { throw new Error("not used in this test"); },
      calls,
      cancelBracketSiblingLegs: impl
        ? async (accountNumber: string, orderId: string) => {
            calls.push({ accountNumber, orderId });
            return impl(accountNumber, orderId);
          }
        : undefined
    } as unknown as BrokerGateway & { calls: Array<{ accountNumber: string; orderId: string }> };
  }

  it("cancels sibling legs and removes the row on success", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    const { reconcilePendingBracketTeardowns } = await import("../src/lib/broker-protective-stops");
    const acct = "TEARDOWN-1";
    recordStopPlan(acct, "AAPL", "fixed", "x", 100, "local", undefined, "long", "bracket-1");
    clearStopPlans(acct, ["AAPL"]);
    expect(listPendingBracketTeardowns(acct)).toHaveLength(1);

    const gw = gatewayWithBracketCancel(async () => ({ cancelledOrderIds: ["leg-1", "leg-2"] }));
    await reconcilePendingBracketTeardowns(gw, acct, "local");

    expect(gw.calls).toEqual([{ accountNumber: acct, orderId: "bracket-1" }]);
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("drops pending rows immediately when the gateway has no cancelBracketSiblingLegs capability (e.g. Robinhood)", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    const { reconcilePendingBracketTeardowns } = await import("../src/lib/broker-protective-stops");
    const acct = "TEARDOWN-2";
    recordStopPlan(acct, "MSFT", "atr", "x", 200, "local", undefined, "long", "bracket-2");
    clearStopPlans(acct, ["MSFT"]);
    expect(listPendingBracketTeardowns(acct)).toHaveLength(1);

    const gw = gatewayWithBracketCancel(undefined);
    await reconcilePendingBracketTeardowns(gw, acct, "local");
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("bumps attempts (not removes) on a failed cancel call, below the max-attempts threshold", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    const { reconcilePendingBracketTeardowns } = await import("../src/lib/broker-protective-stops");
    const acct = "TEARDOWN-3";
    recordStopPlan(acct, "TSLA", "fixed", "x", 300, "local", undefined, "long", "bracket-3");
    clearStopPlans(acct, ["TSLA"]);

    const gw = gatewayWithBracketCancel(async () => { throw new Error("broker unreachable"); });
    await reconcilePendingBracketTeardowns(gw, acct, "local");

    const pending = listPendingBracketTeardowns(acct);
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
  });

  it("abandons (removes) a row once it reaches the max-attempts threshold on repeated failures", async () => {
    const { recordStopPlan, clearStopPlans, listPendingBracketTeardowns } = await import("../src/lib/db");
    const { reconcilePendingBracketTeardowns } = await import("../src/lib/broker-protective-stops");
    const acct = "TEARDOWN-4";
    recordStopPlan(acct, "GOOG", "fixed", "x", 150, "local", undefined, "long", "bracket-4");
    clearStopPlans(acct, ["GOOG"]);

    const gw = gatewayWithBracketCancel(async () => { throw new Error("broker unreachable"); });
    for (let i = 0; i < 10; i++) {
      await reconcilePendingBracketTeardowns(gw, acct, "local");
    }
    expect(listPendingBracketTeardowns(acct)).toEqual([]);
  });

  it("no-ops (never throws) when there are no pending teardowns", async () => {
    const { reconcilePendingBracketTeardowns } = await import("../src/lib/broker-protective-stops");
    const gw = gatewayWithBracketCancel(async () => ({ cancelledOrderIds: [] }));
    await expect(reconcilePendingBracketTeardowns(gw, "TEARDOWN-NONE", "local")).resolves.toBeUndefined();
    expect(gw.calls).toEqual([]);
  });
});

describe("broker-held short buy-stops (Alpaca)", () => {
  let gw: ReturnType<typeof fakeGateway>;
  beforeEach(() => { gw = fakeGateway(); });

  const alpacaShortPolicy = (account: string, over: Partial<TradingPolicy> = {}): TradingPolicy => ({
    ...DEFAULT_POLICY,
    accountNumber: account,
    activeBroker: "alpaca",
    shortSellingEnabled: true,
    brokerStopsForShorts: true,
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, shortStopLossPct: 8 },
    ...over
  });

  const shortPos = (symbol: string, quantity: number, averageCost: number): EquityPosition => ({
    symbol, quantity, averageCost, marketValue: quantity * averageCost
  });

  it("is enabled on Alpaca even when shortSellingEnabled is off, and off on Robinhood or when explicitly disabled", () => {
    expect(brokerStopsForShortsEnabled(alpacaShortPolicy("S"))).toBe(true);
    expect(brokerStopsForShortsEnabled(alpacaShortPolicy("S", { brokerStopsForShorts: false }))).toBe(false);
    expect(brokerStopsForShortsEnabled(alpacaShortPolicy("S", { shortSellingEnabled: false }))).toBe(true);
    expect(brokerStopsForShortsEnabled({ ...alpacaShortPolicy("S"), activeBroker: "robinhood" })).toBe(false);
  });

  it("places a GTC buy-stop (cover) above entry for an open short", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaShortPolicy("SS-1"),
      accountNumber: "SS-1",
      gateway: gw,
      positions: [shortPos("TSLA", -10, 200)],
      executionMode: "broker/paper",
      running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed).toHaveLength(1);
    expect(gw.placed[0]).toMatchObject({
      symbol: "TSLA",
      side: "cover",
      type: "stop_market",
      quantity: 10,
      stopPrice: 216,
      timeInForce: "gtc"
    });
  });

  it("places a short buy-stop even when short selling is off (existing shorts remain protected)", async () => {
    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaShortPolicy("SS-2", { shortSellingEnabled: false }),
      accountNumber: "SS-2",
      gateway: gw,
      positions: [shortPos("TSLA", -10, 200)],
      executionMode: "broker/paper",
      running: true
    });
    expect(r.placed).toBe(1);
    expect(gw.placed).toHaveLength(1);
  });

  it("cancels the cover stop when the short is closed", async () => {
    await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaShortPolicy("SS-3"),
      accountNumber: "SS-3",
      gateway: gw,
      positions: [shortPos("TSLA", -10, 200)],
      executionMode: "broker/paper",
      running: true
    });
    const r = await reconcileBrokerProtectiveStops({
      userId: "local",
      policy: alpacaShortPolicy("SS-3"),
      accountNumber: "SS-3",
      gateway: gw,
      positions: [],
      executionMode: "broker/paper",
      running: true
    });
    expect(r.cancelled).toBe(1);
  });
});
