// Conformance tests for the per-broker order-status tables (oss-lessons §7 slice 1).
// Every row of BROKER_ORDER_STATUS_CONFORMANCE is executed against the REAL production
// classifiers via classifyOrderStatus — a vocabulary or classifier change that alters any
// documented mapping is a CI failure here, not a production order-state bug.
// Pure — no DB, no network.

import { describe, expect, it } from "vitest";
import {
  BROKER_ORDER_STATUS_CONFORMANCE,
  classifyOrderStatus,
  type BrokerId,
  type CanonicalOrderStatusClass
} from "../src/lib/broker-status-conformance";
import { isLiveOrderState, isRejectedOrCanceledState as isDeclineBrokerSide } from "../src/lib/broker-side";
import {
  isActiveBrokerOrderState,
  isWorkingOrderState,
  isRejectedOrCanceledState as isDeclineBrokerHeld
} from "../src/lib/broker-held-orders";

const ALL_ROWS = (Object.keys(BROKER_ORDER_STATUS_CONFORMANCE) as BrokerId[]).flatMap((broker) =>
  BROKER_ORDER_STATUS_CONFORMANCE[broker].map((row) => ({ broker, row }))
);

describe("broker order-status conformance tables", () => {
  it("every documented raw status classifies exactly as the table says (REAL classifiers)", () => {
    for (const { broker, row } of ALL_ROWS) {
      const actual = classifyOrderStatus(row.raw);
      const expected: CanonicalOrderStatusClass = {
        live: row.live,
        active: row.active,
        working: row.working,
        decline: row.decline,
        filled: row.filled
      };
      expect(actual, `${broker}:${row.raw}`).toEqual(expected);
    }
  });

  it("the two modules' decline classifiers are the SAME function (drift unification holds)", () => {
    // broker-held-orders.ts previously carried a drifted local copy missing "failed"/"error".
    expect(isDeclineBrokerHeld).toBe(isDeclineBrokerSide);
    for (const { row } of ALL_ROWS) {
      expect(isDeclineBrokerHeld(row.raw), row.raw).toBe(isDeclineBrokerSide(row.raw));
    }
  });

  it("classification is internally consistent across the four lenses", () => {
    for (const { broker, row } of ALL_ROWS) {
      const c = classifyOrderStatus(row.raw);
      // Filled or declined orders can never be resting/active/working.
      if (c.filled || c.decline) {
        expect(c.live, `${broker}:${row.raw} live`).toBe(false);
        expect(c.active, `${broker}:${row.raw} active`).toBe(false);
        expect(c.working, `${broker}:${row.raw} working`).toBe(false);
      }
      // Active (held) must always imply live (the superset invariant, per status).
      if (c.active) expect(c.live, `${broker}:${row.raw}`).toBe(true);
      // Working must always imply live OR the two documented EXTRA_WORKING states.
      if (c.working && !c.live) {
        expect(["stopped", "calculated"], `${broker}:${row.raw}`).toContain(row.raw);
      }
    }
  });

  it("unknown statuses fail CLOSED on every lens (not live, not working, not decline, not filled)", () => {
    for (const garbage of ["", "  ", "weird_new_state", "done_for_dayX", "FILLED2", "null", "undefined"]) {
      const c = classifyOrderStatus(garbage);
      expect(c, JSON.stringify(garbage)).toEqual({ live: false, active: false, working: false, decline: false, filled: false });
    }
  });

  it("normalization: mixed-case and padded statuses classify identically to their canonical form", () => {
    expect(classifyOrderStatus("  New ")).toEqual(classifyOrderStatus("new"));
    expect(classifyOrderStatus("CANCELLED")).toEqual(classifyOrderStatus("cancelled"));
    expect(classifyOrderStatus("Done_For_Day")).toEqual(classifyOrderStatus("done_for_day"));
    expect(classifyOrderStatus("Filled")).toEqual(classifyOrderStatus("filled"));
  });

  it("regression guards for the documented production traps", () => {
    // 2026-07-27: done_for_day must never count as working (Orders-list/stale-limit inflation).
    expect(isWorkingOrderState("done_for_day")).toBe(false);
    expect(isLiveOrderState("done_for_day")).toBe(false);
    expect(isActiveBrokerOrderState("done_for_day")).toBe(false);
    // pending_cancel/pending_replace stay live — a requested cancel/replace can still fill.
    expect(isLiveOrderState("pending_cancel")).toBe(true);
    expect(isLiveOrderState("pending_replace")).toBe(true);
    // "failed"/"error" are declines in BOTH modules (the drift this slice fixed).
    expect(isDeclineBrokerSide("failed")).toBe(true);
    expect(isDeclineBrokerHeld("failed")).toBe(true);
    expect(isDeclineBrokerSide("error")).toBe(true);
    expect(isDeclineBrokerHeld("error")).toBe(true);
  });

  it("tables cover the weird statuses named in the §7 design (done_for_day, pending_cancel, replaced, expired)", () => {
    const alpacaRaws = new Set(BROKER_ORDER_STATUS_CONFORMANCE.alpaca.map((r) => r.raw));
    for (const required of ["done_for_day", "pending_cancel", "replaced", "expired", "pending_replace", "stopped", "calculated"]) {
      expect(alpacaRaws.has(required), required).toBe(true);
    }
  });
});
