/**
 * Mobile `order.cancel` — the phone's kill switch for a rotting working order.
 *
 * Runs the SAME implementation as the console's POST /api/orders/cancel (src/lib/order-cancel.ts);
 * these tests drive it through the real mobile command lane with a mocked BrokerGateway whose
 * order book is keyed by account number, so account scoping is observable rather than asserted.
 *
 * Covered: payload validation, the happy path, an unknown order, an already-filled order, a
 * caller naming an account that is not the one selected, a cross-user attempt on someone else's
 * order id, and the deliberate NON-membership in IMMEDIATE_PROTECTIVE_COMMAND_TYPES (cancelling
 * one order must not cancel the operator's other queued work).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityOrder, ExecutedOrder, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-order-cancel-${randomUUID()}.db`)}`;
});

const broker = vi.hoisted(() => ({
  /** accountNumber -> that account's order book. Nothing crosses between entries. */
  books: new Map<string, unknown[]>(),
  /** Accounts whose broker READS fail, to exercise the fail-open branch. */
  readThrows: new Set<string>(),
  cancelCalls: [] as Array<{ accountNumber: string; orderId: string }>
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (policy: TradingPolicy) => {
      const accountNumber = policy.accountNumber ?? "";
      return {
        getAccounts: async () => [{ accountNumber, type: "brokerage" }],
        getPortfolio: async () => ({
          accountNumber,
          totalMarketValue: 0,
          buyingPower: 0,
          equityMarketValue: 0,
          optionMarketValue: 0,
          cash: 0
        }),
        // Scoped to the account the gateway was resolved for — exactly like a real broker
        // adapter holding this user's credentials for this account.
        getEquityOrders: async () => {
          if (broker.readThrows.has(accountNumber)) throw new Error("broker unreachable");
          return broker.books.get(accountNumber) ?? [];
        },
        getEquityPositions: async () => {
          if (broker.readThrows.has(accountNumber)) throw new Error("broker unreachable");
          return [];
        },
        getEquityQuotes: async () => ({}),
        getEquityTradability: async (_acc: string, symbols: string[]) =>
          Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
        reviewEquityOrder: async () => ({ estimatedNotional: 0, alerts: [], raw: {} }),
        placeEquityOrder: async () => {
          throw new Error("placement must never happen on a cancel path");
        },
        cancelEquityOrder: async (acct: string, orderId: string): Promise<ExecutedOrder> => {
          broker.cancelCalls.push({ accountNumber: acct, orderId });
          return { orderId, refId: randomUUID(), state: "canceled", raw: {} };
        }
      };
    }
  };
});

function workingOrder(id: string, symbol: string, state = "open"): EquityOrder {
  return {
    id,
    symbol,
    side: "buy",
    type: "limit",
    state,
    quantity: 10,
    filledQuantity: 0,
    limitPrice: 100,
    createdAt: new Date().toISOString()
  };
}

async function seedUser(accountNumber: string, orders: EquityOrder[]) {
  const { upsertConnectedAccount, setPolicy } = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const userId = `mobile-cancel-${randomUUID()}`;
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber,
    label: "Cancel lane",
    isActive: true
  });
  setPolicy({ ...DEFAULT_POLICY, activeBroker: "alpaca", accountNumber, connectedAccountId: accountId }, userId);
  broker.books.set(accountNumber, orders);
  return { userId, accountId };
}

async function runCancel(userId: string, payload: Record<string, unknown>) {
  const { queueMobileCommand, executeMobileCommandImmediately } = await import("../src/lib/mobile-api");
  const queued = queueMobileCommand({ userId, commandType: "order.cancel", payload });
  return executeMobileCommandImmediately(queued.command.id, userId);
}

async function auditKinds(userId: string): Promise<string[]> {
  const { getDb } = await import("../src/lib/db");
  return getDb()
    .prepare("SELECT kind FROM audit_events WHERE user_id = ?")
    .all(userId)
    .map((row) => (row as { kind: string }).kind);
}

beforeEach(() => {
  broker.cancelCalls.length = 0;
});

describe("mobile order.cancel — command shape", () => {
  it("is a recognized command type that runs immediately but is NOT protective", async () => {
    const {
      MOBILE_COMMAND_TYPES,
      isMobileCommandType,
      isImmediateMobileCommandType,
      isImmediateProtectiveMobileCommandType
    } = await import("../src/lib/mobile-api");
    expect(MOBILE_COMMAND_TYPES).toContain("order.cancel");
    expect(isMobileCommandType("order.cancel")).toBe(true);
    // Must not wait behind a 30-minute strategy.run_once...
    expect(isImmediateMobileCommandType("order.cancel")).toBe(true);
    // ...but must not drag the operator's other queued work down with it either.
    expect(isImmediateProtectiveMobileCommandType("order.cancel")).toBe(false);
  });

  it("requires an orderId and keeps only the fields it validates", async () => {
    const { queueMobileCommand, MobileCommandValidationError } = await import("../src/lib/mobile-api");
    const userId = `mobile-cancel-validate-${randomUUID()}`;
    expect(() => queueMobileCommand({ userId, commandType: "order.cancel", payload: {} })).toThrow(
      MobileCommandValidationError
    );
    expect(() => queueMobileCommand({ userId, commandType: "order.cancel", payload: { orderId: "   " } })).toThrow(
      MobileCommandValidationError
    );
    const queued = queueMobileCommand({
      userId,
      commandType: "order.cancel",
      payload: { orderId: "o-1", accountNumber: "A-1", quantity: 999, side: "sell" }
    });
    expect(queued.command.payload).toEqual({ orderId: "o-1", accountNumber: "A-1" });
  });
});

describe("mobile order.cancel — execution", () => {
  it("cancels a working order through the shared console cancel path", async () => {
    const { userId } = await seedUser("ACCT-HAPPY", [workingOrder("o-happy", "AAPL")]);
    const command = await runCancel(userId, { orderId: "o-happy" });

    expect(command.status).toBe("succeeded");
    expect(command.result).toMatchObject({ ok: true, orderId: "o-happy", symbol: "AAPL", status: "canceled" });
    expect(broker.cancelCalls).toEqual([{ accountNumber: "ACCT-HAPPY", orderId: "o-happy" }]);
    // The shared path's receipts, not a second cancel implementation's.
    expect(await auditKinds(userId)).toContain("order_cancel");
  });

  it("refuses an unknown order id without touching the broker", async () => {
    const { userId } = await seedUser("ACCT-UNKNOWN", [workingOrder("o-real", "MSFT")]);
    const command = await runCancel(userId, { orderId: "o-ghost" });

    expect(command.status).toBe("failed");
    expect(command.error).toContain("not open in the selected account");
    expect(broker.cancelCalls).toEqual([]);
  });

  it("refuses an order the broker already filled, and says which state it is in", async () => {
    const { userId } = await seedUser("ACCT-FILLED", [workingOrder("o-filled", "NVDA", "filled")]);
    const command = await runCancel(userId, { orderId: "o-filled" });

    expect(command.status).toBe("failed");
    expect(command.error).toContain("no longer working");
    expect(command.error).toContain("filled");
    expect(broker.cancelCalls).toEqual([]);
  });

  it("still cancels when the advisory pre-read is unavailable (fail-open, receipted)", async () => {
    const { userId } = await seedUser("ACCT-BLIND", []);
    // A broker read that throws teaches nothing either way; the emergency lever still works.
    broker.readThrows.add("ACCT-BLIND");
    const command = await runCancel(userId, { orderId: "o-blind" });

    expect(command.status).toBe("succeeded");
    expect(broker.cancelCalls).toEqual([{ accountNumber: "ACCT-BLIND", orderId: "o-blind" }]);
    expect(await auditKinds(userId)).toContain("order_cancel_precheck_unavailable");
  });

  it("does not cancel the operator's other queued work (non-protective blast radius)", async () => {
    const { userId } = await seedUser("ACCT-BLAST", [workingOrder("o-blast", "TSLA")]);
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queuedRun = queueMobileCommand({ userId, commandType: "strategy.run_once" });

    const command = await runCancel(userId, { orderId: "o-blast" });
    expect(command.status).toBe("succeeded");

    const stillQueued = listMobileCommands({ userId }).find((item) => item.id === queuedRun.command.id);
    expect(stillQueued?.status).toBe("queued");
  });
});

describe("mobile order.cancel — account isolation (hard rule)", () => {
  it("refuses when the caller names an account other than the selected one", async () => {
    const { userId } = await seedUser("ACCT-SELECTED", [workingOrder("o-scoped", "AMD")]);
    await seedUser("ACCT-OTHER", [workingOrder("o-scoped", "AMD")]);

    const command = await runCancel(userId, { orderId: "o-scoped", accountNumber: "ACCT-OTHER" });

    expect(command.status).toBe("failed");
    expect(command.error).toContain("different account");
    // Neither account was touched — not the named one, and not the selected one either.
    expect(broker.cancelCalls).toEqual([]);
    expect(await auditKinds(userId)).toContain("order_cancel_account_mismatch");
  });

  it("cannot cancel another user's order, even with the exact broker order id", async () => {
    const victim = await seedUser("ACCT-VICTIM", [workingOrder("o-victim", "SPY")]);
    const attacker = await seedUser("ACCT-ATTACKER", [workingOrder("o-attacker", "QQQ")]);

    const command = await runCancel(attacker.userId, { orderId: "o-victim" });

    expect(command.status).toBe("failed");
    expect(command.error).toContain("not open in the selected account");
    // The victim's account was never addressed, and their order id was never sent anywhere.
    expect(broker.cancelCalls).toEqual([]);
    expect(broker.books.get("ACCT-VICTIM")).toHaveLength(1);

    // Naming the victim's account explicitly is refused at the scoping check, before any I/O.
    const named = await runCancel(attacker.userId, { orderId: "o-victim", accountNumber: "ACCT-VICTIM" });
    expect(named.status).toBe("failed");
    expect(named.error).toContain("different account");
    expect(broker.cancelCalls).toEqual([]);
    expect(await auditKinds(victim.userId)).not.toContain("order_cancel");
  });
});
