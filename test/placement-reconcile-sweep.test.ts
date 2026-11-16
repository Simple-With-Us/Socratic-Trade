/**
 * Idempotency + notification-resolution for the placement-reconcile fix, exercised through the
 * crash-recovery sweep (flagStalePlacingIntents):
 *   - the status gate (sweep only reads status='placing') + the (proposalId, brokerOrderId) dedupe
 *     guard together book a recovered fill EXACTLY once (MP-1), even across inline→sweep / sweep×2 /
 *     a crash between recordFill and the status flip;
 *   - a recovered order clears the perpetual "verify with broker" alert for THAT proposal only (MP-5).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerGateway, EquityOrder } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

function createMockGateway(overrides: Partial<BrokerGateway>): BrokerGateway {
  return overrides as BrokerGateway;
}

const ACCOUNT = "SWEEP-TEST";
const STALE_ISO = new Date(Date.now() - 10 * 60_000).toISOString(); // older than the 2-min cutoff

beforeEach(() => {
  vi.resetModules();
  process.env.PAPER_EXECUTION_COST_MODEL = "off";
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-reconcile-sweep-${randomUUID()}.db`)}`;
});

async function seedPlacingProposal(userId: string, id: string, refId: string): Promise<void> {
  const { insertProposal, getDb, upsertSocraticDecisionCase } = await import("../src/lib/db");
  insertProposal({
    userId,
    id,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      quantity: 1,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "sweep test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)",
      referencePrice: 200
    },
    decision: { approved: true, reasons: [] },
    refId,
    status: "placing",
    executionMode: "broker/live"
  });
  upsertSocraticDecisionCase({
    id,
    userId,
    proposalId: id,
    accountNumber: ACCOUNT,
    symbol: "AAPL",
    side: "buy",
    status: "placing",
    authority: "decide",
    thesis: "Momentum-Breakout",
    rationale: "sweep test",
    action: "BUY AAPL 1 sh"
  });
  // Backdate so listStalePlacingProposals (created_at < now-2min) picks it up.
  getDb().prepare("UPDATE trade_proposals SET created_at = ? WHERE id = ?").run(STALE_ISO, id);
}

function orderWith(clientOrderId: string, over: Partial<EquityOrder> = {}): EquityOrder {
  return {
    id: `broker-${clientOrderId}`,
    symbol: "AAPL",
    side: "buy",
    type: "market",
    state: "accepted",
    clientOrderId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over
  };
}

describe("flagStalePlacingIntents idempotency", () => {
  it("crash window: an existing fill for the same brokerOrderId is not double-booked", async () => {
    const userId = `sweep-crash-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const order = orderWith(refId);
    // Simulate a crash AFTER recordFillFromProposal but BEFORE the status flip persisted: a fill row
    // exists with this brokerOrderId, but the proposal is still 'placing'.
    insertFillEvent({
      userId,
      proposalId,
      accountNumber: ACCOUNT,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 200,
      notional: 200,
      status: "pending_reconciliation",
      brokerOrderId: order.id
    });

    const gateway = createMockGateway({ getEquityOrders: async () => [order] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(1);
  });

  it("crash window: a pending receipt is finalized when broker truth advances to filled", async () => {
    const userId = `sweep-pending-to-filled-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal, getSocraticDecisionCase, insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const order = orderWith(refId, { state: "filled", filledQuantity: 1, averagePrice: 202 });
    insertFillEvent({
      userId,
      proposalId,
      accountNumber: ACCOUNT,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 200,
      notional: 200,
      status: "pending_reconciliation",
      brokerOrderId: order.id
    });

    const gateway = createMockGateway({ getEquityOrders: async () => [order] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(listFillEventsByProposalId(proposalId, userId)).toHaveLength(1);
    expect(listFillEventsByProposalId(proposalId, userId)[0]).toMatchObject({ status: "filled", price: 202, quantity: 1, notional: 202 });
    expect(getProposal(proposalId, userId)).toMatchObject({ status: "filled", estimatedNotional: 202 });
    expect(getSocraticDecisionCase(proposalId, userId)).toMatchObject({ status: "filled", notional: 202 });
  });

  it("crash window: a terminal order with executed quantity finalizes the existing partial receipt", async () => {
    const userId = `sweep-terminal-partial-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal, getSocraticDecisionCase, insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const order = orderWith(refId, { state: "canceled", filledQuantity: 0.25, averagePrice: 204 });
    insertFillEvent({
      userId,
      proposalId,
      accountNumber: ACCOUNT,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 1,
      price: 200,
      notional: 200,
      status: "pending_reconciliation",
      brokerOrderId: order.id
    });

    await flagStalePlacingIntents(createMockGateway({ getEquityOrders: async () => [order] }), ACCOUNT, userId);

    expect(listFillEventsByProposalId(proposalId, userId)).toMatchObject([
      { status: "filled", quantity: 0.25, price: 204, notional: 51 }
    ]);
    expect(getProposal(proposalId, userId)).toMatchObject({ status: "filled", estimatedNotional: 51 });
    expect(getSocraticDecisionCase(proposalId, userId)).toMatchObject({ status: "filled", notional: 51 });
  });

  it("crash window: a stale terminal-zero snapshot finalizes rather than erases an existing priced partial", async () => {
    const userId = `sweep-terminal-stale-zero-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal, getSocraticDecisionCase, insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const order = orderWith(refId, { state: "canceled", filledQuantity: 0, averagePrice: undefined });
    insertFillEvent({
      userId,
      proposalId,
      accountNumber: ACCOUNT,
      source: "live",
      executionMode: "broker/live",
      symbol: "AAPL",
      side: "buy",
      quantity: 0.4,
      price: 203,
      notional: 81.2,
      status: "partially_filled",
      brokerOrderId: order.id
    });

    await flagStalePlacingIntents(createMockGateway({ getEquityOrders: async () => [order] }), ACCOUNT, userId);

    expect(listFillEventsByProposalId(proposalId, userId)).toMatchObject([
      { status: "filled", quantity: 0.4, price: 203, notional: 81.2 }
    ]);
    expect(getProposal(proposalId, userId)).toMatchObject({ status: "filled", estimatedNotional: 81.2 });
    expect(getSocraticDecisionCase(proposalId, userId)).toMatchObject({ status: "filled", notional: 81.2 });
  });

  it("sweep run twice books exactly one fill (status gate closes after the first pass)", async () => {
    const userId = `sweep-twice-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { listFillEventsByProposalId, getProposal } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const gateway = createMockGateway({ getEquityOrders: async () => [orderWith(refId)] });

    await flagStalePlacingIntents(gateway, ACCOUNT, userId);
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(getProposal(proposalId, userId)?.status).toBe("placed");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(1);
  });

  it("recovers a broker-confirmed fill as filled in proposal, case, and fill ledgers", async () => {
    const userId = `sweep-filled-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal, getSocraticDecisionCase, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const gateway = createMockGateway({
      getEquityOrders: async () => [orderWith(refId, { state: "filled", filledQuantity: 1, averagePrice: 201 })]
    });

    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(getProposal(proposalId, userId)).toMatchObject({ status: "filled", estimatedNotional: 201 });
    expect(getSocraticDecisionCase(proposalId, userId)).toMatchObject({ status: "filled", notional: 201 });
    expect(listFillEventsByProposalId(proposalId, userId)[0]).toMatchObject({ status: "filled", notional: 201 });
  });

  it("inline-then-sweep: a proposal already flipped out of 'placing' is never re-booked", async () => {
    const userId = `sweep-inline-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { insertFillEvent, updateProposalStatus, listFillEventsByProposalId } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const order = orderWith(refId);
    // Simulate a completed inline reconcile: fill booked AND status flipped to 'placed'.
    insertFillEvent({
      userId, proposalId, accountNumber: ACCOUNT, source: "live", executionMode: "broker/live",
      symbol: "AAPL", side: "buy", quantity: 1, price: 200, notional: 200,
      status: "pending_reconciliation", brokerOrderId: order.id
    });
    updateProposalStatus(proposalId, "placed", order.id, undefined, undefined, userId);

    const gateway = createMockGateway({ getEquityOrders: async () => [order] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(1);
  });
});

describe("flagStalePlacingIntents terminal-decline + non-authoritative guards", () => {
  it("(2) matched order in a DECLINED state → rejected_by_broker, NO fill, alert NOT cleared as placed", async () => {
    const userId = `sweep-declined-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { insertNotificationEvent, listNotificationEvents, listFillEventsByProposalId, getProposal } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const alert = insertNotificationEvent({
      userId, type: "run_failed", status: "sent",
      title: "AAPL order placement uncertain — verify with broker",
      payload: { proposalId, refId, reconcile: "uncertain" }
    });

    // The broker order carrying our refId is TERMINALLY DECLINED (rejected). The sweep must NOT book
    // a fill and must NOT mark it placed (the money-path bug: phantom fill + false "placed").
    const gateway = createMockGateway({ getEquityOrders: async () => [orderWith(refId, { state: "rejected" })] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(getProposal(proposalId, userId)?.status).toBe("rejected_by_broker");
    expect(listFillEventsByProposalId(proposalId, userId).length).toBe(0);
    // The uncertain alert is never silently cleared as "placed" — a declined order is a standing fact.
    const notifs = listNotificationEvents(userId);
    expect(notifs.find((n) => n.id === alert.id)?.acknowledgedAt).toBeUndefined();
  });

  it("(3) order ABSENT from an AUTHORITATIVE list → abandoned (placing_failed)", async () => {
    const userId = `sweep-absent-auth-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const gateway = createMockGateway({
      ordersListIncludesTerminal: true,
      getEquityOrders: async () => [orderWith("unrelated-key")]
    });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(getProposal(proposalId, userId)?.status).toBe("placing_failed");
  });

  it("(3) order ABSENT from a NON-authoritative list (Robinhood) → stays 'placing', NOT abandoned", async () => {
    const userId = `sweep-absent-conservative-${randomUUID()}`;
    const proposalId = randomUUID();
    const refId = randomUUID();
    await seedPlacingProposal(userId, proposalId, refId);

    const { getProposal } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    // No ordersListIncludesTerminal ⇒ conservative: absence can't prove "never placed", so the sweep
    // must keep the durable 'placing' intent (+ protected alert) rather than abandon a maybe-real order.
    const gateway = createMockGateway({ getEquityOrders: async () => [orderWith("unrelated-key")] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    expect(getProposal(proposalId, userId)?.status).toBe("placing");
  });
});

describe("flagStalePlacingIntents resolves the uncertain alert on recovery", () => {
  it("acks the recovered proposal's uncertain alert only — a different proposal's stays unacked", async () => {
    const userId = `sweep-resolve-${randomUUID()}`;
    const pX = randomUUID();
    const rX = randomUUID();
    const pY = randomUUID();
    await seedPlacingProposal(userId, pX, rX);

    const { insertNotificationEvent, listNotificationEvents } = await import("../src/lib/db");
    const { flagStalePlacingIntents } = await import("../src/lib/strategy");
    const alertX = insertNotificationEvent({
      userId, type: "run_failed", status: "sent",
      title: "AAPL order placement uncertain — verify with broker",
      payload: { proposalId: pX, refId: rX, reconcile: "uncertain" }
    });
    const alertY = insertNotificationEvent({
      userId, type: "run_failed", status: "sent",
      title: "TSLA order placement uncertain — verify with broker",
      payload: { proposalId: pY, refId: randomUUID(), reconcile: "uncertain" }
    });

    const gateway = createMockGateway({ getEquityOrders: async () => [orderWith(rX)] });
    await flagStalePlacingIntents(gateway, ACCOUNT, userId);

    const notifs = listNotificationEvents(userId);
    expect(notifs.find((n) => n.id === alertX.id)?.acknowledgedAt).toBeTruthy();
    expect(notifs.find((n) => n.id === alertY.id)?.acknowledgedAt).toBeUndefined();
  });
});
