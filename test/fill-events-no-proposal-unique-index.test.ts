/**
 * Item 6 (2026-07-18): migration 16's partial UNIQUE index on fill_events (proposal_id,
 * broker_order_id) requires proposal_id NOT NULL, so it never covers a recovered/booked fill that
 * has no owning proposal — specifically bookBrokerHeldStopFill (broker-protective-stops.ts), which
 * tags its inserts with `raw.brokerHeldProtectiveStop: true`. The
 * fill_events_no_proposal_broker_order_unique_index migration adds a partial UNIQUE index scoped to
 * exactly that recovery class: (user_id, account_number, broker_order_id) WHERE proposal_id IS NULL
 * AND broker_order_id IS NOT NULL AND json_extract(raw, '$.brokerHeldProtectiveStop') = 1.
 * insertFillEvent must treat a violation the same idempotent-no-op way it already treats the
 * proposal_id-scoped one — return the already-booked fill, never throw, never double-book.
 *
 * Deliberately NOT constrained: proposal-less fills WITHOUT the marker. order-replacement.ts books
 * multiple proposal-less rows that can legitimately share a broker_order_id within one (user,
 * account) — its idempotency key is `raw.replacementRefId` (see its "does not let another
 * tenant/account fill with the same broker order id suppress recovery" test, which a broader index
 * broke during development). Mirrors test/fill-events-dedupe-index.test.ts's style for migration 16.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrderSide } from "../src/lib/types";

const ACCOUNT = "NO-PROPOSAL-DEDUPE-TEST";

beforeEach(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-fill-no-proposal-dedupe-${randomUUID()}.db`)}`;
});

/** A broker-held-stop recovery fill, exactly as bookBrokerHeldStopFill shapes it (incl. the marker). */
function recoveryFill(over: Record<string, unknown>) {
  return {
    accountNumber: ACCOUNT,
    source: "live" as const,
    executionMode: "broker/live" as const,
    symbol: "AAPL",
    side: "sell" as const,
    quantity: 1,
    price: 200,
    notional: 200,
    status: "filled",
    raw: { brokerHeldProtectiveStop: true, kind: "fixed" },
    ...over
  };
}

describe("fill_events broker-held-stop-recovery double-fill backstop (proposal-less, marker-scoped)", () => {
  it("a replayed recovery of the same (user, account, brokerOrderId) is an idempotent no-op", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const userId = `no-proposal-dedupe-${randomUUID()}`;
    const brokerOrderId = `broker-${randomUUID()}`;

    const first = insertFillEvent({ userId, ...recoveryFill({ brokerOrderId }) });
    // A replayed recovery of the SAME physical broker order — must NOT throw and must NOT create a
    // 2nd row, even though neither insert carries a proposalId.
    const second = insertFillEvent({ userId, ...recoveryFill({ brokerOrderId, price: 999, quantity: 5 }) });

    const rows = listFillEvents(ACCOUNT, "live", 500, userId);
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id); // idempotent no-op returns the already-booked fill
    expect(rows[0].price).toBe(200);
  });

  it("different brokerOrderIds both persist (index is the triple, not just user+account)", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const userId = `no-proposal-diff-${randomUUID()}`;

    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId: `a-${randomUUID()}` }) });
    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId: `b-${randomUUID()}` }) });

    expect(listFillEvents(ACCOUNT, "live", 500, userId)).toHaveLength(2);
  });

  it("rows with a NULL broker_order_id are never constrained (partial index)", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const userId = `no-proposal-null-${randomUUID()}`;

    // Two marker-tagged fills, neither with a broker order id — the partial index must not touch
    // them (broker_order_id IS NOT NULL is a strict condition).
    insertFillEvent({ userId, ...recoveryFill({ source: "paper" }) });
    insertFillEvent({ userId, ...recoveryFill({ source: "paper" }) });

    expect(listFillEvents(ACCOUNT, "paper", 500, userId)).toHaveLength(2);
  });

  it("proposal-less fills WITHOUT the brokerHeldProtectiveStop marker are never constrained (order-replacement's design)", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const userId = `no-proposal-unmarked-${randomUUID()}`;
    const brokerOrderId = `reused-${randomUUID()}`;

    // order-replacement.ts legitimately books multiple proposal-less rows sharing a broker_order_id
    // within one (user, account), deduped by raw.replacementRefId — the scoped index must not
    // collapse them.
    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId, raw: { source: "market_replace", replacementRefId: "ref-a" } }) });
    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId, raw: { source: "market_replace", replacementRefId: "ref-b" } }) });

    expect(listFillEvents(ACCOUNT, "live", 500, userId)).toHaveLength(2);
  });

  it("a fill WITH a proposalId is governed by migration 16's index, not this one", async () => {
    const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
    const userId = `no-proposal-vs-proposal-${randomUUID()}`;
    const brokerOrderId = `broker-${randomUUID()}`;

    // Marker-tagged proposal-less recovery first...
    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId }) });
    // ...a proposal-carrying fill for the SAME broker order id is outside this index's partial
    // condition (proposal_id IS NULL) and must persist independently.
    insertFillEvent({ userId, ...recoveryFill({ brokerOrderId, proposalId: randomUUID() }) });

    expect(listFillEvents(ACCOUNT, "live", 500, userId)).toHaveLength(2);
  });

  // Item 6: "Check all four OrderSides (buy/sell/short/cover) behave correctly through the changed
  // path." The index and insertFillEvent's catch handler are side-agnostic (keyed purely on
  // user/account/brokerOrderId + the marker) — verify replay-idempotency holds identically for
  // every side.
  const sides: OrderSide[] = ["buy", "sell", "short", "cover"];
  for (const side of sides) {
    it(`side="${side}": a replayed recovery books exactly once`, async () => {
      const { insertFillEvent, listFillEvents } = await import("../src/lib/db");
      const userId = `no-proposal-side-${side}-${randomUUID()}`;
      const brokerOrderId = `broker-${side}-${randomUUID()}`;

      const first = insertFillEvent({ userId, ...recoveryFill({ side, brokerOrderId }) });
      const replay = insertFillEvent({ userId, ...recoveryFill({ side, brokerOrderId, price: 1, quantity: 1000 }) });

      const rows = listFillEvents(ACCOUNT, "live", 500, userId);
      expect(rows).toHaveLength(1);
      expect(replay.id).toBe(first.id);
      expect(rows[0].side).toBe(side);
    });
  }
});
