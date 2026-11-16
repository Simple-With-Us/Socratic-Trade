// reconcile-refire (handoff 4.3 + 6b.3): live closed lots write episodic memory when the receipt
// flips to filled during reconciliation; absent-from-listing orders NEVER auto-flip (fill_events
// is not a complete broker ledger and no gateway exposes a per-order lookup) — they stay pending
// and escalate with position evidence as diagnostic context; aged escalation fires exactly once
// and ONLY for genuinely-unresolvable fills (never a matched open/working order).
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, EquityOrder, EquityPosition } from "../src/lib/types";

// vi.hoisted: the vi.mock factory can run while STATIC imports (../src/lib/db and friends) are
// still evaluating, i.e. before this module's own body — a plain const here would not exist yet.
const { storeContextsMock } = vi.hoisted(() => ({
  storeContextsMock: vi.fn(async (_documents: Array<{ metadata: Record<string, unknown> }>) => ({ attempted: 1, indexed: 1 }))
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: storeContextsMock
}));

import { insertFillEvent, listFillEvents, listNotificationEvents } from "../src/lib/db";
import { reconcilePendingFills } from "../src/lib/strategy-execution";

function createMockGateway(overrides: Partial<BrokerGateway>): BrokerGateway {
  return overrides as BrokerGateway;
}

function brokerOrder(partial: Partial<EquityOrder> & Pick<EquityOrder, "id" | "symbol" | "side" | "state">): EquityOrder {
  return {
    type: "market",
    createdAt: new Date().toISOString(),
    ...partial
  } as EquityOrder;
}

const sellProposal = (symbol: string, quantity: number) => ({
  symbol,
  side: "sell" as const,
  type: "market" as const,
  quantity,
  timeInForce: "gfd" as const,
  marketHours: "regular_hours" as const,
  rationale: "Thesis complete; taking the exit.",
  tradeThesisTag: "Momentum-Breakout",
  entryMarketRegime: "Neutral"
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-refire-${randomUUID()}.db`)}`;
});

describe("experience-memory re-fire on pending_reconciliation -> filled", () => {
  it("writes the closed-lot experience exactly once across two reconcile passes", async () => {
    const accountNumber = `ACC-REFIRE-${randomUUID()}`;
    const brokerOrderId = randomUUID();
    // Entry lot already booked as accounting truth.
    insertFillEvent({
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 150,
      notional: 1500,
      status: "filled",
      filledAt: "2026-07-14T14:00:00.000Z"
    });
    // Closing sell landed as pending_reconciliation (the live default) — the write hook in
    // recordFillFromProposal would have matched no closed lot at insert time.
    const sellFillId = randomUUID();
    insertFillEvent({
      id: sellFillId,
      proposalId: randomUUID(),
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "sell",
      quantity: 10,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId,
      raw: { proposal: sellProposal("AAPL", 10) }
    });

    const gateway = createMockGateway({
      getEquityOrders: async () => [
        brokerOrder({
          id: brokerOrderId,
          symbol: "AAPL",
          side: "sell",
          state: "filled",
          filledQuantity: 10,
          averagePrice: 156,
          updatedAt: "2026-07-14T15:00:00.000Z"
        })
      ]
    });

    await reconcilePendingFills(gateway, accountNumber);
    await vi.waitFor(() => expect(storeContextsMock).toHaveBeenCalledTimes(1));

    const flipped = listFillEvents(accountNumber, "live").find((fill) => fill.id === sellFillId);
    expect(flipped).toMatchObject({ status: "filled", price: 156, quantity: 10, notional: 1560 });

    const documents = storeContextsMock.mock.calls[0]![0];
    expect(documents.length).toBeGreaterThan(0);
    expect(String(documents[0]!.metadata.accession)).toMatch(/^exp:/);
    expect(documents[0]!.metadata.symbol).toBe("AAPL");

    // Second pass: the fill left the pending list — no duplicate experience write.
    await reconcilePendingFills(gateway, accountNumber);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(storeContextsMock).toHaveBeenCalledTimes(1);
  });
});

describe("absent broker orders NEVER auto-flip (no direct per-order lookup available)", () => {
  it("does NOT flip a fill when the position delta is ambiguous", async () => {
    const accountNumber = `ACC-AMBIG-${randomUUID()}`;
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 10,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID()
    });

    const gateway = createMockGateway({
      // ordersListIncludesTerminal deliberately unset (Robinhood-style).
      getEquityOrders: async () => [],
      // Position shows 4 shares — matches neither "not executed" (0) nor "executed" (10).
      getEquityPositions: async (): Promise<EquityPosition[]> => [
        { symbol: "AAPL", quantity: 4, averageCost: 150, marketValue: 600 }
      ]
    });

    await reconcilePendingFills(gateway, accountNumber);

    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "pending_reconciliation",
      price: 0,
      notional: 0
    });
  });

  it("never flips even when the position delta exactly matches execution — external holdings fake the same delta; escalates with the evidence instead", async () => {
    const accountNumber = `ACC-NOFLIP-${randomUUID()}`;
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "NVDA",
      side: "buy",
      quantity: 5,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID(),
      filledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() // past the 30m default threshold
    });

    const gateway = createMockGateway({
      // ordersListIncludesTerminal deliberately unset (Robinhood-style, non-authoritative).
      getEquityOrders: async () => [],
      // The owner already held 5 NVDA bought manually OUTSIDE the app (never in fill_events).
      // The delta "matches" this order executing even though it may never have — quantity
      // arithmetic cannot distinguish an external trade from this order's execution.
      getEquityPositions: async (): Promise<EquityPosition[]> => [
        { symbol: "NVDA", quantity: 5, averageCost: 120, marketValue: 600 }
      ]
    });

    await reconcilePendingFills(gateway, accountNumber);

    // The fill must stay pending — never a fabricated fill at an inferred price.
    const fill = listFillEvents(accountNumber, "live").find((f) => f.id === fillId);
    expect(fill).toMatchObject({ status: "pending_reconciliation", price: 0, notional: 0 });
    expect((fill!.raw as Record<string, unknown>).positionInference).toBeUndefined();

    // The escalation carries the observed position comparison as DIAGNOSTIC context only.
    const escalations = listNotificationEvents("local", 100).filter(
      (event) => event.type === "run_failed" && (event.payload as Record<string, unknown>)?.fillId === fillId
    );
    expect(escalations).toHaveLength(1);
    const payload = escalations[0]!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("order_absent_from_listing");
    expect(payload.evidence).toMatchObject({
      brokerPositionQuantity: 5,
      bookedNetQuantity: 0,
      intendedQuantity: 5,
      deltaConsistentWithExecution: true
    });
    expect(String((payload.evidence as Record<string, unknown>).summary)).toContain("NOT proof");
  });

  it("never flips an absent-order SELL even when the position is gone (consistent with execution, but not proof)", async () => {
    const accountNumber = `ACC-SELLABS-${randomUUID()}`;
    insertFillEvent({
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "MSFT",
      side: "buy",
      quantity: 8,
      price: 100,
      notional: 800,
      status: "filled",
      filledAt: "2026-07-14T14:00:00.000Z"
    });
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "MSFT",
      side: "sell",
      quantity: 8,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID()
    });

    const gateway = createMockGateway({
      getEquityOrders: async () => [],
      // Position gone: consistent with the sell having executed — but a manual/MCP sell outside
      // the app produces the same picture, so the fill must stay pending for owner resolution.
      getEquityPositions: async (): Promise<EquityPosition[]> => []
    });

    await reconcilePendingFills(gateway, accountNumber);

    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "pending_reconciliation",
      price: 0
    });
  });

  it("fetches no positions when nothing escalates (fresh fill, authoritative listing)", async () => {
    const accountNumber = `ACC-AUTH-${randomUUID()}`;
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "NVDA",
      side: "buy",
      quantity: 5,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID()
    });
    const getEquityPositions = vi.fn(async (): Promise<EquityPosition[]> => [
      { symbol: "NVDA", quantity: 5, averageCost: 120, marketValue: 600 }
    ]);
    const gateway = createMockGateway({
      ordersListIncludesTerminal: true,
      getEquityOrders: async () => [],
      getEquityPositions
    } as Partial<BrokerGateway>);

    await reconcilePendingFills(gateway, accountNumber);

    // No flip, no inference: the fill just stays pending, and since it is younger than the
    // escalation threshold no position evidence is even collected.
    expect(getEquityPositions).not.toHaveBeenCalled();
    expect(listFillEvents(accountNumber, "live").find((fill) => fill.id === fillId)).toMatchObject({
      status: "pending_reconciliation"
    });
  });
});

describe("age-based escalation of stuck pending fills", () => {
  it("emits exactly one notification + persists a marker across two reconcile passes, without touching accounting state", async () => {
    const accountNumber = `ACC-ESC-${randomUUID()}`;
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "TSLA",
      side: "buy",
      quantity: 3,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID(),
      filledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() // 2h old > 30m default
    });

    const gateway = createMockGateway({
      getEquityOrders: async () => [],
      // Broker position unchanged (none) — inference correctly concludes "no execution shown".
      getEquityPositions: async (): Promise<EquityPosition[]> => []
    });

    await reconcilePendingFills(gateway, accountNumber);
    await reconcilePendingFills(gateway, accountNumber);

    const escalations = listNotificationEvents("local", 100).filter(
      (event) => event.type === "run_failed" && (event.payload as Record<string, unknown>)?.fillId === fillId
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.title).toContain("pending reconciliation");
    expect((escalations[0]!.payload as Record<string, unknown>).reconcile).toBe("uncertain");

    const fill = listFillEvents(accountNumber, "live").find((f) => f.id === fillId);
    // Informational only: the fill stays pending, with the once-per-fill marker persisted.
    expect(fill).toMatchObject({ status: "pending_reconciliation", price: 0 });
    expect((fill!.raw as Record<string, unknown>).pendingEscalation).toBeTruthy();
  });

  it("does not escalate a fill younger than the threshold", async () => {
    const accountNumber = `ACC-YOUNG-${randomUUID()}`;
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "AMD",
      side: "buy",
      quantity: 2,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId: randomUUID()
    });

    await reconcilePendingFills(createMockGateway({
      getEquityOrders: async () => [],
      getEquityPositions: async (): Promise<EquityPosition[]> => []
    }), accountNumber);

    const escalations = listNotificationEvents("local", 100).filter(
      (event) => event.type === "run_failed" && (event.payload as Record<string, unknown>)?.fillId === fillId
    );
    expect(escalations).toHaveLength(0);
    const fill = listFillEvents(accountNumber, "live").find((f) => f.id === fillId);
    expect((fill!.raw ?? {}) as Record<string, unknown>).not.toHaveProperty("pendingEscalation");
  });

  it("NEVER escalates a fill whose matched broker order is still open/working, even past the threshold", async () => {
    const accountNumber = `ACC-WORKING-${randomUUID()}`;
    const brokerOrderId = randomUUID();
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "GOOG",
      side: "buy",
      quantity: 4,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId,
      filledAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() // 3h old — a healthy day limit
    });

    const gateway = createMockGateway({
      getEquityOrders: async () => [
        // A resting working limit — normal for a day limit order; stale-limit-order alerting
        // owns this case, so the pending-fill escalation must stay silent.
        brokerOrder({ id: brokerOrderId, symbol: "GOOG", side: "buy", state: "accepted", type: "limit" })
      ]
    });

    await reconcilePendingFills(gateway, accountNumber);

    const escalations = listNotificationEvents("local", 100).filter(
      (event) => event.type === "run_failed" && (event.payload as Record<string, unknown>)?.fillId === fillId
    );
    expect(escalations).toHaveLength(0);
    const fill = listFillEvents(accountNumber, "live").find((f) => f.id === fillId);
    expect(fill).toMatchObject({ status: "pending_reconciliation" });
    expect((fill!.raw ?? {}) as Record<string, unknown>).not.toHaveProperty("pendingEscalation");
  });

  it("escalates a matched order in a TERMINAL state whose execution data is unusable (executed quantity, no price)", async () => {
    const accountNumber = `ACC-TERM-${randomUUID()}`;
    const brokerOrderId = randomUUID();
    const fillId = randomUUID();
    insertFillEvent({
      id: fillId,
      accountNumber,
      source: "live",
      executionMode: "broker/live",
      symbol: "META",
      side: "buy",
      quantity: 6,
      price: 0,
      notional: 0,
      status: "pending_reconciliation",
      brokerOrderId,
      filledAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    });

    const gateway = createMockGateway({
      getEquityOrders: async () => [
        // Canceled after a partial execution the broker reports WITHOUT a realized price — the
        // receipt cannot be booked (no defensible price) and the order will never progress.
        brokerOrder({ id: brokerOrderId, symbol: "META", side: "buy", state: "canceled", filledQuantity: 3 })
      ]
    });

    await reconcilePendingFills(gateway, accountNumber);

    const escalations = listNotificationEvents("local", 100).filter(
      (event) => event.type === "run_failed" && (event.payload as Record<string, unknown>)?.fillId === fillId
    );
    expect(escalations).toHaveLength(1);
    const payload = escalations[0]!.payload as Record<string, unknown>;
    expect(payload.reason).toBe("terminal_state_unusable_execution_data");
    expect(payload.brokerState).toBe("canceled");
    expect(payload.knownBrokerQuantity).toBe(3);
    expect(payload.reconcile).toBe("uncertain");
    // Advisory only: accounting state untouched, marker persisted once.
    const fill = listFillEvents(accountNumber, "live").find((f) => f.id === fillId);
    expect(fill).toMatchObject({ status: "pending_reconciliation", price: 0 });
    expect((fill!.raw as Record<string, unknown>).pendingEscalation).toMatchObject({
      reason: "terminal_state_unusable_execution_data"
    });
  });
});
