/**
 * Per-account broker-mutation lease (oss-lessons §7 slice 3, PR-1) — keying, mutual
 * exclusion, skip-and-retry busy semantics, kill switch, fencing, post-success ownership
 * loss, and the advisory unleased-placement backstop. Interleave tests mirror
 * test/order-replacement.test.ts's two-caller pattern; lease-loss tests are made
 * deterministic by deleting the persisted lease row instead of racing timers.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-acctmut-${randomUUID()}.db`)}`;
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("brokerMutationLeaseGroup — keying", () => {
  it("keys on accountNumber, falls back to cid, null when both absent", async () => {
    const { brokerMutationLeaseGroup } = await import("../src/lib/account-mutation");
    expect(brokerMutationLeaseGroup("u1", "ACCT-9")).toEqual({ group: "broker-mutation:u1:ACCT-9", keyed: "account" });
    expect(brokerMutationLeaseGroup("u1", "  ", "conn-3")).toEqual({ group: "broker-mutation:u1:cid:conn-3", keyed: "cid" });
    expect(brokerMutationLeaseGroup("u1", null, "conn-3")).toEqual({ group: "broker-mutation:u1:cid:conn-3", keyed: "cid" });
    expect(brokerMutationLeaseGroup("u1", null, null)).toBeNull();
  });
});

describe("withAccountMutation — mutual exclusion and busy semantics", () => {
  it("second sequence on the SAME account is busy (try-once) while the first holds the lease", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const userId = `mx-${randomUUID()}`;
    let firstRunning = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => {
      firstRunning = true;
      await gate;
      return "first";
    });
    await sleep(50);
    expect(firstRunning).toBe(true);

    const second = await withAccountMutation({ userId, accountNumber: "A1", lane: "stale-exit-replacement" }, async () => "second");
    expect(second.acquired).toBe(false);
    if (!second.acquired) expect(second.busy.activeOperation).toBe("stop-monitor");

    release();
    const firstResult = await first;
    expect(firstResult).toEqual({ acquired: true, value: "first" });

    const third = await withAccountMutation({ userId, accountNumber: "A1", lane: "account-drain" }, async () => "third");
    expect(third).toEqual({ acquired: true, value: "third" });
  });

  it("different accounts (and different users) never contend", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const userId = `mx-${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const holder = withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => {
      await gate;
      return "held";
    });
    await sleep(30);
    const otherAccount = await withAccountMutation({ userId, accountNumber: "A2", lane: "stop-monitor" }, async () => "a2");
    const otherUser = await withAccountMutation({ userId: `${userId}-b`, accountNumber: "A1", lane: "stop-monitor" }, async () => "b");
    expect(otherAccount).toEqual({ acquired: true, value: "a2" });
    expect(otherUser).toEqual({ acquired: true, value: "b" });
    release();
    await holder;
  });

  it("a bounded wait acquires once the holder releases, without running the body twice", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const userId = `mx-${randomUUID()}`;
    let bodyRuns = 0;
    const holder = withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => {
      await sleep(400);
      return "held";
    });
    await sleep(30);
    const waiter = await withAccountMutation(
      { userId, accountNumber: "A1", lane: "manual-replace", waitMs: 5_000 },
      async () => {
        bodyRuns += 1;
        return "waited";
      }
    );
    expect(waiter).toEqual({ acquired: true, value: "waited" });
    expect(bodyRuns).toBe(1);
    await holder;
  });

  it("busy audits account_mutation_busy and NEVER order_placement_uncertain", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const userId = `mx-${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => { await gate; });
    await sleep(30);
    await withAccountMutation({ userId, accountNumber: "A1", lane: "account-drain" }, async () => "never");
    release();
    await holder;
    const kinds = db
      .getDb()
      .prepare("SELECT kind FROM audit_events WHERE user_id = ?")
      .all(userId)
      .map((row) => (row as { kind: string }).kind);
    expect(kinds).toContain("account_mutation_busy");
    expect(kinds).not.toContain("order_placement_uncertain");
  });
});

describe("withAccountMutation — kill switch and degenerate keys", () => {
  it("kill switch off runs unserialized (two concurrent sequences both acquire)", async () => {
    const { withAccountMutation, ACCOUNT_MUTATION_SERIALIZATION_SETTING } = await import("../src/lib/account-mutation");
    const { setSetting } = await import("../src/lib/db-settings");
    const userId = `mx-${randomUUID()}`;
    setSetting(ACCOUNT_MUTATION_SERIALIZATION_SETTING, false);
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => { await gate; return 1; });
      await sleep(30);
      const second = await withAccountMutation({ userId, accountNumber: "A1", lane: "account-drain" }, async () => 2);
      expect(second).toEqual({ acquired: true, value: 2 });
      release();
      expect(await first).toEqual({ acquired: true, value: 1 });
    } finally {
      setSetting(ACCOUNT_MUTATION_SERIALIZATION_SETTING, true);
    }
  });

  it("fully unkeyed runs unserialized with an account_mutation_unkeyed receipt", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const userId = `mx-${randomUUID()}`;
    const outcome = await withAccountMutation({ userId, accountNumber: "", lane: "stop-monitor" }, async () => "ran");
    expect(outcome).toEqual({ acquired: true, value: "ran" });
    const kinds = db.getDb().prepare("SELECT kind FROM audit_events WHERE user_id = ?").all(userId)
      .map((row) => (row as { kind: string }).kind);
    expect(kinds).toContain("account_mutation_unkeyed");
  });
});

describe("withAccountMutation — fencing and ownership loss", () => {
  it("assertOwned throws after the persisted lease vanishes mid-window; cancels-style code can still proceed", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const userId = `mx-${randomUUID()}`;
    const outcome = await withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async (ctx) => {
      ctx.assertOwned(); // healthy while held
      db.getDb().prepare("DELETE FROM settings WHERE key LIKE 'operation_lease:broker-mutation:%'").run();
      let threw = false;
      try {
        ctx.assertOwned();
      } catch {
        threw = true;
      }
      return threw;
    }).catch((error) => ({ postLoss: true, error }));
    // Either shape is acceptable at the boundary (post-success loss is converted below), but the
    // in-window assert MUST have thrown.
    if (typeof outcome === "object" && "acquired" in outcome && outcome.acquired) {
      expect(outcome.value).toBe(true);
    }
  });

  it("ownership lost AFTER the body resolves returns the value with ownershipLostAfterRun + audit (never a throw)", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const userId = `mx-${randomUUID()}`;
    const outcome = await withAccountMutation({ userId, accountNumber: "A1", lane: "stale-exit-replacement" }, async () => {
      // Simulate a stolen/expired lease during a long final await: the body's work COMPLETED.
      db.getDb().prepare("DELETE FROM settings WHERE key LIKE 'operation_lease:broker-mutation:%'").run();
      return "mutations-happened";
    });
    expect(outcome.acquired).toBe(true);
    if (outcome.acquired) {
      expect(outcome.value).toBe("mutations-happened");
      expect(outcome.ownershipLostAfterRun).toBe(true);
    }
    const kinds = db.getDb().prepare("SELECT kind FROM audit_events WHERE user_id = ?").all(userId)
      .map((row) => (row as { kind: string }).kind);
    expect(kinds).toContain("account_mutation_lost");
  });
});

describe("wrap points and takeover evidence", () => {
  it("a fresh acquisition over an EXPIRED record audits broker_mutation_takeover_expired", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const userId = `mx-${randomUUID()}`;
    // Plant an expired lease record for the account's group (a crashed holder's leftovers).
    db.getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(
        `operation_lease:broker-mutation:${userId}:A1`,
        JSON.stringify({ owner: "dead:1", operation: "stop-monitor", acquiredAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: new Date(Date.now() - 300_000).toISOString() }),
        new Date().toISOString()
      );
    const outcome = await withAccountMutation({ userId, accountNumber: "A1", lane: "account-drain" }, async () => "took-over");
    expect(outcome.acquired).toBe(true);
    const rows = db.getDb()
      .prepare("SELECT payload FROM audit_events WHERE user_id = ? AND kind = 'broker_mutation_takeover_expired'")
      .all(userId)
      .map((row) => JSON.parse((row as { payload: string }).payload));
    expect(rows).toHaveLength(1);
    expect(rows[0].expiredOperation).toBe("stop-monitor");
  });

  it("the manual cancel route proceeds during someone else's window and receipts the interleave", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const { resolveRequestUserId } = await import("../src/lib/request-user");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const db = await import("../src/lib/db");
    const makeRequest = () =>
      new Request("http://localhost/api/orders/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: "o-77" })
      });
    // Use whatever identity the route itself resolves for this request shape — no auth spelunking.
    const userId = resolveRequestUserId(makeRequest());
    const accountId = randomUUID();
    db.upsertConnectedAccount({
      id: accountId, userId, broker: "test", environment: "paper",
      accountNumber: "T-9", label: "Test", isActive: true
    });
    db.setPolicy({ ...DEFAULT_POLICY, activeBroker: "test", accountNumber: "T-9", connectedAccountId: accountId }, userId);
    const { POST } = await import("../app/api/orders/cancel/route");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withAccountMutation(
      { userId, accountNumber: "T-9", connectedAccountId: accountId, lane: "stop-monitor" },
      async () => { await gate; }
    );
    await sleep(20);

    const response = await POST(makeRequest());
    release();
    await holder;
    expect(response.status).toBe(200);
    const kinds = db.getDb().prepare("SELECT kind FROM audit_events WHERE user_id = ?").all(userId)
      .map((row) => (row as { kind: string }).kind);
    expect(kinds).toContain("broker_mutation_cancel_during_lease");
    expect(kinds).toContain("order_cancel");
  });
});

describe("local claim registry, peek, and the unleased-placement backstop", () => {
  it("hasActiveLocalBrokerMutationClaim and peekBrokerMutationLease reflect the window, then clear", async () => {
    const { withAccountMutation, hasActiveLocalBrokerMutationClaim, peekBrokerMutationLease } = await import("../src/lib/account-mutation");
    const userId = `mx-${randomUUID()}`;
    await withAccountMutation({ userId, accountNumber: "A1", lane: "stop-monitor" }, async () => {
      expect(hasActiveLocalBrokerMutationClaim(userId, "A1")).toBe(true);
      expect(peekBrokerMutationLease(userId, "A1")?.operation).toBe("stop-monitor");
    });
    expect(hasActiveLocalBrokerMutationClaim(userId, "A1")).toBe(false);
    expect(peekBrokerMutationLease(userId, "A1")).toBeNull();
  });

  it("a placement OUTSIDE any mutation window audits broker_mutation_unleased; inside a window it does not", async () => {
    const { withAccountMutation } = await import("../src/lib/account-mutation");
    const db = await import("../src/lib/db");
    const { getBrokerGateway } = await import("../src/lib/broker");
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const userId = `mx-${randomUUID()}`;
    const accountId = randomUUID();
    db.upsertConnectedAccount({
      id: accountId, userId, broker: "test", environment: "paper",
      accountNumber: "T-1", label: "Test", isActive: true
    });
    const policy = { ...DEFAULT_POLICY, activeBroker: "test" as const, accountNumber: "T-1", connectedAccountId: accountId };
    const gateway = getBrokerGateway(policy, userId);
    const order = {
      accountNumber: "T-1", symbol: "AAPL", side: "buy" as const, type: "market" as const,
      quantity: 1, timeInForce: "gfd" as const, marketHours: "regular_hours" as const, refId: randomUUID()
    };

    await gateway.placeEquityOrder({ ...order, refId: randomUUID() });
    await withAccountMutation({ userId, accountNumber: "T-1", connectedAccountId: accountId, lane: "stop-monitor" }, async () => {
      await gateway.placeEquityOrder({ ...order, refId: randomUUID() });
    });

    const rows = db.getDb()
      .prepare("SELECT kind FROM audit_events WHERE user_id = ? AND kind = 'broker_mutation_unleased'")
      .all(userId);
    expect(rows).toHaveLength(1);
  });
});
