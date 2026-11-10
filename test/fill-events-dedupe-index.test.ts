/**
 * (4) [LOW] Durable double-fill backstop: a partial UNIQUE index on
 * fill_events (proposal_id, broker_order_id) (migration 16) so the inline/sweep check-then-insert
 * can't double-book the same physical broker order even if the single-process dedupe guard is ever
 * bypassed. insertFillEvent must treat the constraint violation as an idempotent no-op (return the
 * already-booked fill), NOT throw and NOT create a duplicate. The partial index (both columns
 * non-null) must never constrain the many legitimate NULL-column rows.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const ACCOUNT = "DEDUPE-TEST";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fill-dedupe-${randomUUID()}.db`)}`;
});

function baseFill(over: Record<string, unknown>) {
  return {
    accountNumber: ACCOUNT,
    source: "live" as const,
    executionMode: "broker/live" as const,
    symbol: "AAPL",
    side: "buy" as const,
    quantity: 1,
    price: 200,
    notional: 200,
    status: "pending_reconciliation",
    ...over
  };
}

describe("fill_events (proposal_id, broker_order_id) double-fill backstop", () => {
  it("a second insert of the same (proposalId, brokerOrderId) is an idempotent no-op", async () => {
    const { insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const userId = `dedupe-${randomUUID()}`;
    const proposalId = randomUUID();
    const brokerOrderId = `broker-${randomUUID()}`;

    const first = insertFillEvent({ userId, ...baseFill({ proposalId, brokerOrderId }) });
    // Second insert of the SAME physical order — must NOT throw and must NOT create a 2nd row.
    const second = insertFillEvent({ userId, ...baseFill({ proposalId, brokerOrderId, price: 999, quantity: 5 }) });

    const rows = listFillEventsByProposalId(proposalId, userId);
    expect(rows).toHaveLength(1);
    // The no-op returns the ALREADY-booked fill (the first one), not the rejected second insert.
    expect(second.id).toBe(first.id);
    expect(rows[0].price).toBe(200);
  });

  it("same proposalId with DIFFERENT brokerOrderIds both persist (index is the pair, not proposalId)", async () => {
    const { insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const userId = `dedupe-diff-${randomUUID()}`;
    const proposalId = randomUUID();

    insertFillEvent({ userId, ...baseFill({ proposalId, brokerOrderId: `a-${randomUUID()}` }) });
    insertFillEvent({ userId, ...baseFill({ proposalId, brokerOrderId: `b-${randomUUID()}` }) });

    expect(listFillEventsByProposalId(proposalId, userId)).toHaveLength(2);
  });

  it("rows with a NULL broker_order_id are never constrained (partial index)", async () => {
    const { insertFillEvent, listFillEventsByProposalId } = await import("../src/lib/db");
    const userId = `dedupe-null-${randomUUID()}`;
    const proposalId = randomUUID();

    // Two fills for the same proposal, both without a broker order id (e.g. paper entries) — legit.
    insertFillEvent({ userId, ...baseFill({ proposalId, source: "paper", status: "filled" }) });
    insertFillEvent({ userId, ...baseFill({ proposalId, source: "paper", status: "filled" }) });

    expect(listFillEventsByProposalId(proposalId, userId)).toHaveLength(2);
  });
});
