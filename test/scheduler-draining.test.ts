import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EquityOrder } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scheduler-draining-${randomUUID()}.db`)}`;
});

function order(state: string): EquityOrder {
  return {
    id: randomUUID(),
    symbol: "AAPL",
    side: "buy",
    type: "market",
    state,
    quantity: 1,
    createdAt: new Date(0).toISOString()
  };
}

describe("scheduler draining-account cleanup", () => {
  it("treats every broker-live order state as blocking account purge", async () => {
    const { drainingAccountLiveOrders } = await import("../src/lib/scheduler");

    const orders = [
      order("accepted"),
      order("pending_new"),
      order("queued"),
      order("confirmed"),
      order("pending"),
      order("pending_cancel"),
      order("open"),
      order("partially_filled"),
      order("filled"),
      order("canceled"),
      order("rejected"),
      order("something_else")
    ];

    expect(drainingAccountLiveOrders(orders).map((o) => o.state)).toEqual([
      "accepted",
      "pending_new",
      "queued",
      "confirmed",
      "pending",
      "pending_cancel",
      "open",
      "partially_filled"
    ]);
  });
});
