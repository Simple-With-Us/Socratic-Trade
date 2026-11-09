import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityOrder } from "../src/lib/types";

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-provenance-unit-${randomUUID()}.db`)}`;
});

function order(overrides: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: "ord-1",
    symbol: "AAPL",
    side: "sell",
    type: "limit",
    state: "accepted",
    quantity: 10,
    filledQuantity: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("isAppPlacedBrokerOrder", () => {
  it("treats protstop- and sstop- prefixes as app-placed", async () => {
    const { isAppPlacedBrokerOrder } = await import("../src/lib/order-provenance");
    expect(isAppPlacedBrokerOrder(order({ clientOrderId: "protstop-local-APCA-AAPL-1" }))).toBe(true);
    expect(isAppPlacedBrokerOrder(order({ clientOrderId: "sstop-abc-123" }))).toBe(true);
  });

  it("treats a nonempty Alpaca UUID with no tracked row as not_app_placed", async () => {
    const { isAppPlacedBrokerOrder, autoReplaceProvenanceSkipReason } = await import("../src/lib/order-provenance");
    const ownerUuid = "6fa459ea-ee8a-3ca4-894e-db77e160355e";
    const ownerOrder = order({ clientOrderId: ownerUuid });
    expect(isAppPlacedBrokerOrder(ownerOrder)).toBe(false);
    expect(isAppPlacedBrokerOrder(ownerOrder, { userId: "local", accountNumber: "APCA-PAPER" })).toBe(false);
    expect(autoReplaceProvenanceSkipReason(ownerOrder, { userId: "local", accountNumber: "APCA-PAPER" })).toBe("not_app_placed");
  });

  it("treats a UUID that matches a trade_proposals.ref_id as app-placed", async () => {
    const { insertProposal } = await import("../src/lib/db");
    const { isAppPlacedBrokerOrder } = await import("../src/lib/order-provenance");
    const refId = randomUUID();
    insertProposal({
      id: `prop-${refId}`,
      runId: "run-1",
      accountNumber: "APCA-PAPER",
      proposal: { symbol: "AAPL", side: "sell", type: "limit", quantity: 10, tradeThesisTag: "t", entryMarketRegime: "bull" },
      decision: { action: "approve" },
      status: "placed",
      refId,
      tradeThesisTag: "t",
      entryMarketRegime: "bull"
    });
    expect(isAppPlacedBrokerOrder(order({ clientOrderId: refId }), { userId: "local", accountNumber: "APCA-PAPER" })).toBe(true);
  });

  it("treats a UUID that matches a protective-stop placement intent as app-placed", async () => {
    const { upsertBrokerStopPlacementIntent } = await import("../src/lib/db");
    const { isAppPlacedBrokerOrder } = await import("../src/lib/order-provenance");
    const refId = randomUUID();
    upsertBrokerStopPlacementIntent({
      userId: "local",
      accountNumber: "APCA-PAPER",
      symbol: "AAPL",
      clientOrderId: refId,
      quantity: 10,
      stopPrice: 90,
      kind: "fixed"
    });
    expect(isAppPlacedBrokerOrder(order({ clientOrderId: refId }), { userId: "local", accountNumber: "APCA-PAPER" })).toBe(true);
  });

  it("treats missing clientOrderId as not_app_placed", async () => {
    const { isAppPlacedBrokerOrder, autoReplaceProvenanceSkipReason } = await import("../src/lib/order-provenance");
    const bare = order({ clientOrderId: undefined });
    expect(isAppPlacedBrokerOrder(bare)).toBe(false);
    expect(autoReplaceProvenanceSkipReason(bare)).toBe("not_app_placed");
  });
});
