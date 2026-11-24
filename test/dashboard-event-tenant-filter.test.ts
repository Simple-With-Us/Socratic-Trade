import { describe, expect, it } from "vitest";
import {
  GLOBAL_DASHBOARD_EVENT_TYPES,
  shouldDeliverDashboardEvent,
  type DashboardEvent
} from "../src/lib/events";

const at = "2026-11-22T00:00:00.000Z";
const ev = (partial: Partial<DashboardEvent> & Pick<DashboardEvent, "type">): DashboardEvent => ({ at, ...partial });

describe("shouldDeliverDashboardEvent (SSE tenant filter)", () => {
  it("enumerates exactly today's untagged global emit types", () => {
    // From the emit sites: regime-watch.ts + admin/emit-test emit untagged `dirty`;
    // history.ts emits untagged `market-data` (shared cache fill). Nothing else is untagged.
    expect([...GLOBAL_DASHBOARD_EVENT_TYPES].sort()).toEqual(["dirty", "market-data"]);
  });

  it("still broadcasts each allowlisted untagged type to every subscriber", () => {
    for (const type of GLOBAL_DASHBOARD_EVENT_TYPES) {
      expect(shouldDeliverDashboardEvent(ev({ type }), "user-a")).toBe(true);
      expect(shouldDeliverDashboardEvent(ev({ type }), "user-b")).toBe(true);
    }
  });

  it("drops an untagged order-shaped event for every tenant", () => {
    const order = ev({ type: "order", detail: { orderId: "o1", symbol: "AAPL" } });
    expect(shouldDeliverDashboardEvent(order, "user-a")).toBe(false);
    expect(shouldDeliverDashboardEvent(order, "user-b")).toBe(false);
  });

  it("drops untagged proposal/run-complete/chat-turn/pending-learned-change events", () => {
    for (const type of ["proposal", "run-complete", "chat-turn", "pending-learned-change"] as const) {
      expect(shouldDeliverDashboardEvent(ev({ type, detail: { proposalId: "p1" } }), "user-a")).toBe(false);
    }
  });

  it("delivers tagged events only to their owner, including allowlisted types", () => {
    expect(shouldDeliverDashboardEvent(ev({ type: "order", userId: "user-a" }), "user-a")).toBe(true);
    expect(shouldDeliverDashboardEvent(ev({ type: "order", userId: "user-a" }), "user-b")).toBe(false);
    expect(shouldDeliverDashboardEvent(ev({ type: "dirty", userId: "user-a" }), "user-a")).toBe(true);
    expect(shouldDeliverDashboardEvent(ev({ type: "dirty", userId: "user-a" }), "user-b")).toBe(false);
  });
});
