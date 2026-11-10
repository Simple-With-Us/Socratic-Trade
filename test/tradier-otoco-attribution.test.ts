/**
 * ST-4592: Tradier OTOCO day-TIF expiry reconciliation and untagged exit-leg attribution.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 0, indexed: 0 })
}));

import { insertProposal, getDb } from "../src/lib/db";
import { listingExecutionOwner } from "../src/lib/fill-reconciliation";
import { reconcilePendingFills as reconcileFromStrategy } from "../src/lib/strategy-execution";
import { resetFillReconciliationStateForTests } from "../src/lib/fill-reconciliation";
import {
  executionsFromTradierRow,
  mapTradierBracketContainerRow,
  mapTradierBracketLegRow,
  resolveTradierBracketContainerState,
  tradierBracketParts,
  tradierOrderLookupFromRow
} from "../src/lib/tradier";
import { isAppPlacedBrokerOrder } from "../src/lib/order-provenance";
import { classifyOrderRole } from "../src/lib/order-role";
import { loadOrderRoleContexts } from "../src/lib/order-role-context";
import type { BrokerGateway, BrokerOrderLookup, EquityOrder } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-tradier-otoco-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  resetFillReconciliationStateForTests();
});

describe("Tradier OTOCO attribution", () => {
  it("omits bracket orderClass on leg-entry container and entry leg rows but keeps it on exit legs", () => {
    const container: Record<string, unknown> = {
      id: 88100,
      class: "otoco",
      tag: "st-ref-entry-class",
      status: "open",
      symbol: "MPC",
      create_date: "2026-11-07T14:00:00.000Z",
      leg: [
        { id: 88101, class: "equity", side: "buy", type: "limit", status: "open", quantity: 5, create_date: "2026-11-07T14:00:00.000Z" },
        { id: 88102, class: "equity", side: "sell", type: "limit", status: "open", quantity: 5, price: 150, create_date: "2026-11-07T14:00:00.000Z" },
        { id: 88103, class: "equity", side: "sell", type: "stop", status: "open", quantity: 5, stop_price: 140, create_date: "2026-11-07T14:00:00.000Z" }
      ]
    };
    const legs = container.leg as Record<string, unknown>[];
    expect(mapTradierBracketContainerRow(container).orderClass).toBeUndefined();
    expect(mapTradierBracketLegRow(container, legs[0]).orderClass).toBeUndefined();
    expect(mapTradierBracketLegRow(container, legs[1]).orderClass).toBe("otoco");
    expect(mapTradierBracketLegRow(container, legs[2]).orderClass).toBe("otoco");
  });

  it("inherit parentClientOrderId on flattened exit legs without copying tag onto clientOrderId", () => {
    const container: Record<string, unknown> = {
      id: 88100, class: "otoco", tag: "st-ref-attrib", status: "open", symbol: "MPC",
      leg: [
        { id: 88101, class: "equity", side: "sell", type: "limit", status: "open", quantity: 5 },
        { id: 88102, class: "equity", side: "sell", type: "stop", status: "open", quantity: 5, stop_price: 140 }
      ]
    };
    const exit = mapTradierBracketLegRow(container, (container.leg as Record<string, unknown>[])[0]);
    expect(exit.clientOrderId).toBeUndefined();
    expect(exit.parentClientOrderId).toBe("st-ref-attrib");
    expect(exit.parentOrderId).toBe("88100");
    expect(exit.orderClass).toBe("otoco");
  });

  it("classifies an app OTOCO exit leg as bracket stop/take-profit, not external", () => {
    const lookup = { userId: "local", accountNumber: "VA-1" };
    const refId = "st-ref-bracket-ui";
    getDb()
      .prepare(
        "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, ref_id, order_id, status, trade_thesis_tag, entry_market_regime, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(), "local", randomUUID(), "VA-1", new Date().toISOString(),
        JSON.stringify({ symbol: "MPC", side: "buy", type: "limit", quantity: 5 }),
        JSON.stringify({ allowed: true, reasons: [] }),
        refId, "88100", "placed", "test", "Neutral", "MPC"
      );
    const exitLeg: EquityOrder = {
      id: "88102",
      symbol: "MPC",
      side: "sell",
      type: "stop_market",
      state: "open",
      quantity: 5,
      createdAt: "2026-11-07T14:00:00.000Z",
      orderClass: "otoco",
      parentOrderId: "88100",
      parentClientOrderId: refId
    };
    expect(isAppPlacedBrokerOrder(exitLeg, lookup)).toBe(true);
    const ctx = loadOrderRoleContexts([exitLeg], lookup).get("88102")!;
    const classified = classifyOrderRole(exitLeg, { ...ctx, bracketSiblingWorkingCount: 1 });
    expect(classified.role).not.toBe("external");
    expect(["bracket_stop_loss", "bracket_take_profit", "exit"]).toContain(classified.role);
  });

  it("classifies a resting OTOCO buy entry as entry, not a bracket exit leg", () => {
    const lookup = { userId: "local", accountNumber: "VA-2" };
    const refId = "st-ref-entry-role";
    const createdAt = "2026-11-07T14:00:00.000Z";
    getDb()
      .prepare(
        "INSERT INTO trade_proposals (id, user_id, run_id, account_number, created_at, proposal, decision, ref_id, order_id, status, trade_thesis_tag, entry_market_regime, symbol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        "local",
        randomUUID(),
        "VA-2",
        createdAt,
        JSON.stringify({ symbol: "MPC", side: "buy", type: "limit", quantity: 5 }),
        JSON.stringify({ allowed: true, reasons: [] }),
        refId,
        "88100",
        "placed",
        "test",
        "Neutral",
        "MPC"
      );
    const container: Record<string, unknown> = {
      id: 88100,
      class: "otoco",
      tag: refId,
      status: "open",
      symbol: "MPC",
      create_date: createdAt,
      leg: [
        { id: 88101, class: "equity", side: "buy", type: "limit", status: "open", quantity: 5, create_date: createdAt },
        { id: 88102, class: "equity", side: "sell", type: "limit", status: "open", quantity: 5, price: 150, create_date: createdAt },
        { id: 88103, class: "equity", side: "sell", type: "stop", status: "open", quantity: 5, stop_price: 140, create_date: createdAt }
      ]
    };
    const legs = container.leg as Record<string, unknown>[];
    const containerRow = mapTradierBracketContainerRow(container);
    expect(containerRow.id).toBe("88100");
    expect(containerRow.side).toBe("buy");
    const working = [
      containerRow,
      mapTradierBracketLegRow(container, legs[1]),
      mapTradierBracketLegRow(container, legs[2])
    ];
    expect(working.map((o) => o.id).sort()).toEqual(["88100", "88102", "88103"]);
    const contexts = loadOrderRoleContexts(working, lookup);
    const entryRole = classifyOrderRole(containerRow, contexts.get("88100")!);
    expect(entryRole.role).toBe("entry");
    expect(contexts.get("88102")?.bracketSiblingWorkingCount).toBe(1);
    const exitRole = classifyOrderRole(working[1], contexts.get("88102")!);
    expect(exitRole.role).toBe("bracket_take_profit");
  });

  it("carries parent attribution on leg-entry executions", () => {
    const rows = executionsFromTradierRow({
      id: 900,
      class: "otoco",
      tag: "st-ref-entry-parent",
      status: "open",
      create_date: "2026-11-07T14:00:00.000Z",
      leg: [
        { id: 901, class: "equity", symbol: "SLB", side: "buy", status: "open", quantity: 10, type: "limit", create_date: "2026-11-07T14:00:00.000Z" },
        { id: 902, class: "equity", symbol: "SLB", side: "sell", status: "open", quantity: 10, type: "limit", price: 45, create_date: "2026-11-07T14:00:00.000Z" },
        { id: 903, class: "equity", symbol: "SLB", side: "sell", status: "open", quantity: 10, type: "stop", stop_price: 38, create_date: "2026-11-07T14:00:00.000Z" }
      ]
    });
    const entry = rows.find((row) => row.role === "entry")!;
    expect(entry.order.id).toBe("901");
    expect(entry.order.parentClientOrderId).toBe("st-ref-entry-parent");
    expect(entry.order.parentOrderId).toBe("900");
    expect(entry.order.orderClass).toBeUndefined();
    expect(isAppPlacedBrokerOrder(entry.order, { userId: "local", accountNumber: "VA-1" })).toBe(false);
  });

  it("still ingests filled app bracket exit legs (listing owner) and carries parentClientOrderId on exit orders", () => {
    const rows = executionsFromTradierRow({
      id: 900, class: "otoco", tag: "st-ref-skip", status: "filled",
      leg: [
        { id: 901, class: "equity", symbol: "SLB", side: "buy", status: "filled", exec_quantity: 10, avg_fill_price: 40 },
        { id: 902, class: "equity", symbol: "SLB", side: "sell", status: "filled", exec_quantity: 10, avg_fill_price: 42, type: "limit" }
      ]
    });
    const exit = rows.find((row) => row.order.id === "902")!;
    expect(exit.parentClientOrderId).toBe("st-ref-skip");
    expect(exit.order.parentClientOrderId).toBe("st-ref-skip");
    expect(listingExecutionOwner(exit, () => false)).toBeUndefined();
  });
});

describe("Tradier day-TIF OTOCO expiry", () => {
  const dayOtocoOpenEntryExpired: Record<string, unknown> = {
    id: 400001, type: "otoco", status: "open", duration: "day", class: "otoco", tag: "st-ref-day",
    create_date: "2026-11-07T14:30:00.000Z",
    leg: [
      { id: 400002, type: "limit", symbol: "XOM", side: "buy", quantity: 10, status: "expired", duration: "day", exec_quantity: 0, remaining_quantity: 10, price: 120, class: "equity", transaction_date: "2026-11-07T20:00:00.000Z" },
      { id: 400003, type: "limit", symbol: "XOM", side: "sell", quantity: 10, status: "canceled", duration: "gtc", class: "equity" },
      { id: 400004, type: "stop", symbol: "XOM", side: "sell", quantity: 10, status: "canceled", duration: "gtc", stop_price: 110, class: "equity" }
    ]
  };

  it("resolveTradierBracketContainerState prefers an expired entry over a stale open container", () => {
    const parts = tradierBracketParts(dayOtocoOpenEntryExpired)!;
    expect(resolveTradierBracketContainerState(dayOtocoOpenEntryExpired, parts)).toBe("expired");
    const lookup = tradierOrderLookupFromRow(dayOtocoOpenEntryExpired);
    expect(lookup.order).toMatchObject({ id: "400001", state: "expired", clientOrderId: "st-ref-day" });
  });

  it("reconciles a stale pending receipt when lookup reports the day entry expired", async () => {
    const accountNumber = `VA-${randomUUID()}`;
    const proposalId = randomUUID();
    const fillId = randomUUID();
    insertProposal({
      id: proposalId,
      runId: randomUUID(),
      accountNumber,
      proposal: {
        symbol: "XOM", side: "buy", type: "limit", quantity: 10, limitPrice: 120,
        timeInForce: "gfd", marketHours: "regular_hours", rationale: "test", tradeThesisTag: "t", entryMarketRegime: "Neutral"
      },
      decision: { allowed: true, reasons: [] },
      orderId: "400001",
      status: "placed",
      executionMode: "broker/paper"
    });
    const { insertFillEvent, listFillEvents, getProposal } = await import("../src/lib/db");
    insertFillEvent({
      id: fillId,
      proposalId,
      accountNumber,
      source: "paper",
      executionMode: "broker/paper",
      symbol: "XOM",
      side: "buy",
      quantity: 10,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: "400001",
      filledAt: "2026-11-07T14:31:00.000Z",
      raw: {}
    });
    const book = new Map<string, Record<string, unknown>>([["400001", dayOtocoOpenEntryExpired]]);
    const gateway: BrokerGateway = {
      ordersListIncludesTerminal: true,
      getEquityOrders: async () => [],
      getEquityPositions: async () => [],
      getEquityOrder: async (_account: string, orderId: string): Promise<BrokerOrderLookup | undefined> => {
        const row = book.get(orderId);
        return row ? tradierOrderLookupFromRow(row) : undefined;
      }
    } as unknown as BrokerGateway;

    await reconcileFromStrategy(gateway, accountNumber, "local", undefined, { ignoreThrottle: true });

    expect(listFillEvents(accountNumber, "paper").find((f) => f.id === fillId)?.status).toBe("expired");
    expect(getProposal(proposalId)?.status).toBe("rejected_by_broker");
  });
});
