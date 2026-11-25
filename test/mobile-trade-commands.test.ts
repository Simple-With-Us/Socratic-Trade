/**
 * ST-4685 / OD-10d — phone position.close, position.trim and order.replace_at_market.
 *
 * These commands add NO second placement path: they drive the SAME rails the web console uses
 * (insertProposal -> executeProposal for exits; replaceStaleLimitOrderWithMarket under the account
 * mutation lease for replace-at-market) through the real mobile command lane, with a mocked
 * BrokerGateway whose books are keyed by account number. No LLM, no live broker, no network.
 *
 * Covered: queued -> succeeded end-to-end on a paper account (close and fractioned trim), the live
 * typed-confirmation ceremony (refusal + staged card + confirmed second attempt), the
 * expectedAccountNumber staleness refusal, oversize/zero trim rejection, queue-time idempotent
 * replay, per-user scoping, and the immediate/protective classification of each new type.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityOrder, EquityPosition, ExecutedOrder, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-mobile-trade-commands-${randomUUID()}.db`)}`;
});

const broker = vi.hoisted(() => ({
  /** accountNumber -> position rows. */
  positions: new Map<string, Array<Record<string, unknown>>>(),
  /** accountNumber -> order book. */
  orders: new Map<string, Array<Record<string, unknown>>>(),
  /** Every market order the rails placed, with the account it was placed for. */
  placed: [] as Array<{ accountNumber: string; symbol: string; side: string; type?: string; quantity?: number }>,
  canceled: [] as Array<{ accountNumber: string; orderId: string }>
}));

// Fresh approval-time quote served by the mocked approval scan; the review mock prices off it.
const QUOTE_PRICE = 202;

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// Notification I/O is incidental here (and the block/hold paths of executeProposal emit some).
vi.mock("../src/lib/notifications", () => ({
  sendNotification: async () => ({ id: "test", status: "skipped" })
}));

vi.mock("../src/lib/approval-quote-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/approval-quote-scan")>();
  return {
    ...actual,
    loadApprovalQuoteScan: async () =>
      actual.buildApprovalQuoteScan(
        {
          AAPL: {
            symbol: "AAPL",
            price: QUOTE_PRICE,
            bid: QUOTE_PRICE,
            ask: QUOTE_PRICE,
            provider: "test-scan",
            asOf: new Date().toISOString()
          }
        },
        []
      )
  };
});

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: (policy: TradingPolicy) => {
      const accountNumber = policy.accountNumber ?? "";
      return {
        getAccounts: async () => [{ accountNumber, type: "brokerage", agenticAllowed: true }],
        getPortfolio: async () => ({
          accountNumber,
          totalMarketValue: 100_000,
          buyingPower: 50_000,
          equityMarketValue: 0,
          optionMarketValue: 0,
          cash: 90_000
        }),
        getEquityPositions: async (): Promise<EquityPosition[]> =>
          (broker.positions.get(accountNumber) ?? []) as unknown as EquityPosition[],
        getEquityOrders: async (): Promise<EquityOrder[]> =>
          (broker.orders.get(accountNumber) ?? []) as unknown as EquityOrder[],
        getEquityQuotes: async () => ({}),
        getEquityTradability: async (_acc: string, symbols: string[]) =>
          Object.fromEntries(symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])),
        reviewEquityOrder: async (input: { quantity?: number; dollarAmount?: number; limitPrice?: number }) => ({
          estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * QUOTE_PRICE,
          alerts: []
        }),
        placeEquityOrder: async (order: Record<string, unknown>): Promise<ExecutedOrder> => {
          broker.placed.push({
            accountNumber,
            symbol: String(order.symbol ?? ""),
            side: String(order.side ?? ""),
            type: order.type ? String(order.type) : undefined,
            quantity: order.quantity == null ? undefined : Number(order.quantity)
          });
          return {
            orderId: `placed-${broker.placed.length}`,
            refId: String(order.refId ?? ""),
            state: "accepted",
            raw: { id: `placed-${broker.placed.length}` }
          };
        },
        cancelEquityOrder: async (acct: string, orderId: string): Promise<ExecutedOrder> => {
          broker.canceled.push({ accountNumber: acct, orderId });
          // The broker's book flips to canceled, so the replacement pump's poll settles at once.
          const book = broker.orders.get(acct) ?? [];
          for (const row of book) {
            if (row.id === orderId) row.state = "canceled";
          }
          return { orderId, refId: randomUUID(), state: "canceled", raw: {} };
        }
      };
    }
  };
});

async function seedUser(opts: {
  accountNumber: string;
  environment?: "paper" | "live";
  positions?: Array<Record<string, unknown>>;
  orders?: Array<Record<string, unknown>>;
}) {
  const { upsertConnectedAccount, setPolicy } = await import("../src/lib/db");
  const userId = `mobile-trade-${randomUUID()}`;
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: opts.environment ?? "paper",
    accountNumber: opts.accountNumber,
    label: "Phone exit lane",
    isActive: true
  });
  setPolicy(
    {
      ...DEFAULT_POLICY,
      activeBroker: "alpaca",
      accountNumber: opts.accountNumber,
      connectedAccountId: accountId,
      systemState: "active",
      additionalSymbols: ["AAPL"]
    },
    userId
  );
  broker.positions.set(opts.accountNumber, opts.positions ?? []);
  broker.orders.set(opts.accountNumber, opts.orders ?? []);
  return { userId, accountId };
}

function heldLong(quantity = 10, marketValue = 2020): Record<string, unknown> {
  return { symbol: "AAPL", quantity, averageCost: 190, marketValue, marketValueSource: "live" };
}

function staleLimitBuy(id: string, ageMinutes = 60): Record<string, unknown> {
  const created = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  return { id, symbol: "AAPL", side: "buy", type: "limit", state: "accepted", quantity: 10, filledQuantity: 2, limitPrice: 200, createdAt: created };
}

async function runQueued() {
  const { processPendingMobileCommands } = await import("../src/lib/mobile-api");
  await processPendingMobileCommands({ limit: 5 });
}

async function proposalRow(proposalId: string, userId: string) {
  const { getProposal } = await import("../src/lib/db");
  return getProposal(proposalId, userId);
}

async function auditKinds(userId: string): Promise<string[]> {
  const { getDb } = await import("../src/lib/db");
  return getDb()
    .prepare("SELECT kind FROM audit_events WHERE user_id = ?")
    .all(userId)
    .map((row) => (row as { kind: string }).kind);
}

beforeEach(() => {
  broker.placed = [];
  broker.canceled = [];
});

describe("mobile trade commands — classification", () => {
  it("position.close/trim are queued (not immediate); replace_at_market is immediate but not protective", async () => {
    const {
      MOBILE_COMMAND_TYPES,
      isMobileCommandType,
      isImmediateMobileCommandType,
      isImmediateProtectiveMobileCommandType
    } = await import("../src/lib/mobile-api");
    for (const type of ["position.close", "position.trim", "order.replace_at_market"] as const) {
      expect(MOBILE_COMMAND_TYPES).toContain(type);
      expect(isMobileCommandType(type)).toBe(true);
      // Not protective: none of these may drop the operator's other queued work.
      expect(isImmediateProtectiveMobileCommandType(type)).toBe(false);
    }
    // Exits share proposal.approve's queued rail (strategy lock + typed confirmation).
    expect(isImmediateMobileCommandType("position.close")).toBe(false);
    expect(isImmediateMobileCommandType("position.trim")).toBe(false);
    // Replace rides the same seat as order.cancel: it IS a cancel and must not queue behind a run.
    expect(isImmediateMobileCommandType("order.replace_at_market")).toBe(true);
  });
});

describe("mobile position.close / position.trim — validation", () => {
  it("trims require a size; fraction is bounded to (0,1]; fraction and quantity are exclusive", async () => {
    const { queueMobileCommand, MobileCommandValidationError } = await import("../src/lib/mobile-api");
    const userId = `mobile-trade-validate-${randomUUID()}`;
    expect(() => queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL" } })).toThrow(
      MobileCommandValidationError
    );
    expect(() =>
      queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", fraction: 1.5 } })
    ).toThrow(MobileCommandValidationError);
    expect(() =>
      queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", fraction: 0 } })
    ).toThrow(MobileCommandValidationError);
    expect(() =>
      queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", fraction: 0.5, quantity: 4 } })
    ).toThrow(/not both/);
    expect(() => queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "" } })).toThrow(
      MobileCommandValidationError
    );
    const queued = queueMobileCommand({
      userId,
      commandType: "position.close",
      payload: { symbol: "aapl", accountNumber: "A-9", side: "sell", quantity: 3 }
    });
    expect(queued.command.payload).toEqual({ symbol: "AAPL", accountNumber: "A-9", quantity: 3 });
  });

  it("never echoes the typed confirmation phrase back in a command response", async () => {
    const { queueMobileCommand } = await import("../src/lib/mobile-api");
    const userId = `mobile-trade-redact-${randomUUID()}`;
    const queued = queueMobileCommand({
      userId,
      commandType: "position.close",
      payload: { symbol: "AAPL", liveConfirmation: { typedText: "APPROVE LIVE AAPL", proposalId: "p-1" } }
    });
    expect(JSON.stringify(queued.command.payload)).not.toContain("APPROVE LIVE");
    expect(queued.command.payload.hasLiveConfirmation).toBe(true);
  });
});

describe("mobile position.close — paper account, queued -> succeeded", () => {
  it("closes the full held position through the executeProposal rail", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-CLOSE", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toMatchObject({ symbol: "AAPL", side: "sell", quantity: 10, status: "placed" });
    expect(broker.placed).toEqual([{ accountNumber: "ACCT-CLOSE", symbol: "AAPL", side: "sell", type: "market", quantity: 10 }]);
    const card = await proposalRow(String((done?.result as { proposalId: string }).proposalId), userId);
    expect(card?.status).toBe("placed");
    const kinds = await auditKinds(userId);
    expect(kinds).toContain("mobile_position_exit_staged");
  });

  it("refuses a close of a symbol the account does not hold, without placing", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-FLAT", positions: [] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("No open AAPL position");
    expect(broker.placed).toEqual([]);
  });

  it("closes a held short with COVER", async () => {
    const { userId } = await seedUser({
      accountNumber: "ACCT-SHORT",
      positions: [{ symbol: "AAPL", quantity: -4, averageCost: 210, marketValue: -840, marketValueSource: "live" }]
    });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toMatchObject({ side: "cover", quantity: 4 });
    expect(broker.placed).toEqual([{ accountNumber: "ACCT-SHORT", symbol: "AAPL", side: "cover", type: "market", quantity: 4 }]);
  });
});

describe("mobile position.trim", () => {
  it("sizes an explicit fraction down to whole held shares", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-TRIM", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", fraction: 0.5 } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toMatchObject({ side: "sell", quantity: 5 });
    expect(broker.placed).toEqual([{ accountNumber: "ACCT-TRIM", symbol: "AAPL", side: "sell", type: "market", quantity: 5 }]);
  });

  it("rejects a trim larger than the held position at execution time", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-OVERSIZE", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", quantity: 999 } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("only 10 are held");
    expect(broker.placed).toEqual([]);
  });

  it("rejects a fraction that rounds to zero shares", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-ZERO", positions: [heldLong(2)] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "position.trim", payload: { symbol: "AAPL", fraction: 0.1 } });
    await runQueued();

    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("rounds to zero shares");
    expect(broker.placed).toEqual([]);
  });
});

describe("mobile position.close — live account typed confirmation", () => {
  it("refuses without the ceremony, stages the card, then places when the phrase is confirmed", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-LIVE", environment: "live", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");

    const first = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();
    const firstDone = listMobileCommands({ userId }).find((command) => command.id === first.command.id);
    expect(firstDone?.status).toBe("failed");
    const staged = firstDone?.result as {
      error: string;
      proposalId: string;
      staged: boolean;
      expectedText: string;
      reasons: string[];
    };
    expect(staged.error).toBe("LIVE_CONFIRMATION_REQUIRED");
    expect(staged.staged).toBe(true);
    expect(staged.expectedText).toBe("APPROVE LIVE AAPL");
    expect(broker.placed).toEqual([]);
    // The card is pending and visible for the unchanged proposal.approve path.
    const card = await proposalRow(staged.proposalId, userId);
    expect(card?.status).toBe("proposed");
    expect(card?.proposal).toMatchObject({ symbol: "AAPL", side: "sell", type: "market", quantity: 10 });

    const second = queueMobileCommand({
      userId,
      commandType: "position.close",
      payload: {
        symbol: "AAPL",
        proposalId: staged.proposalId,
        liveConfirmation: {
          proposalId: staged.proposalId,
          accountNumber: "ACCT-LIVE",
          executionMode: "broker/live",
          typedText: staged.expectedText,
          estimatedNotional: card?.estimatedNotional
        }
      }
    });
    await runQueued();
    const secondDone = listMobileCommands({ userId }).find((command) => command.id === second.command.id);
    expect(secondDone?.status).toBe("succeeded");
    expect(secondDone?.result).toMatchObject({ proposalId: staged.proposalId, status: "placed" });
    expect(broker.placed).toEqual([{ accountNumber: "ACCT-LIVE", symbol: "AAPL", side: "sell", type: "market", quantity: 10 }]);
    // The staged card was REUSED, not re-minted.
    const { getDb } = await import("../src/lib/db");
    const stagedCards = getDb()
      .prepare("SELECT COUNT(*) AS n FROM trade_proposals WHERE user_id = ?")
      .get(userId) as { n: number };
    expect(stagedCards.n).toBe(1);
  });

  it("refuses a proposalId pointer that is not this user's pending phone-exit card", async () => {
    const holder = await seedUser({ accountNumber: "ACCT-LIVE-H", environment: "live", positions: [heldLong()] });
    const attacker = await seedUser({ accountNumber: "ACCT-LIVE-A", environment: "live", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");

    const first = queueMobileCommand({ userId: holder.userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();
    const holderDone = listMobileCommands({ userId: holder.userId }).find((command) => command.id === first.command.id);
    const holderStaged = holderDone?.result as { proposalId: string };
    expect(holderDone?.status).toBe("failed");

    const hijack = queueMobileCommand({
      userId: attacker.userId,
      commandType: "position.close",
      payload: { symbol: "AAPL", proposalId: holderStaged.proposalId }
    });
    await runQueued();
    const attackerDone = listMobileCommands({ userId: attacker.userId }).find((command) => command.id === hijack.command.id);
    expect(attackerDone?.status).toBe("failed");
    expect(attackerDone?.error).toContain("does not belong to this command");
    // Nothing executed: neither the holder's card nor the attacker's position moved.
    expect(broker.placed).toEqual([]);
    expect((await proposalRow(holderStaged.proposalId, holder.userId))?.status).toBe("proposed");
  });
});

describe("mobile trade commands — account staleness", () => {
  it("position.close refuses when the named account is no longer the selected one", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-MOVED", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");

    // The phone tapped on ACCT-STALE-BELIEF; the selection has since moved to ACCT-MOVED.
    const queued = queueMobileCommand({
      userId,
      commandType: "position.close",
      payload: { symbol: "AAPL", accountNumber: "ACCT-STALE-BELIEF" }
    });

    await runQueued();
    const done = listMobileCommands({ userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("changed since this was sent");
    expect(broker.placed).toEqual([]);
    expect(await auditKinds(userId)).toContain("mobile_position_exit_account_mismatch");
  });
});

describe("mobile trade commands — idempotency and per-user bounds", () => {
  it("an idempotent replay returns the first command and never places twice", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-IDEM", positions: [heldLong()] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");
    const key = `close-${randomUUID()}`;
    const first = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" }, idempotencyKey: key });
    const replay = queueMobileCommand({ userId, commandType: "position.close", payload: { symbol: "AAPL" }, idempotencyKey: key });

    expect(replay.deduped).toBe(true);
    expect(replay.command.id).toBe(first.command.id);

    await runQueued();
    expect(broker.placed).toHaveLength(1);
    const commands = listMobileCommands({ userId });
    expect(commands.filter((command) => command.commandType === "position.close")).toHaveLength(1);
    expect(commands.find((command) => command.id === first.command.id)?.status).toBe("succeeded");
  });

  it("scoping is per user: another user's command never touches this user's book", async () => {
    const victim = await seedUser({ accountNumber: "ACCT-VICTIM-P", positions: [heldLong()] });
    const stranger = await seedUser({ accountNumber: "ACCT-STRANGER", positions: [] });
    const { queueMobileCommand, listMobileCommands } = await import("../src/lib/mobile-api");

    const queued = queueMobileCommand({ userId: stranger.userId, commandType: "position.close", payload: { symbol: "AAPL" } });
    await runQueued();

    const done = listMobileCommands({ userId: stranger.userId }).find((command) => command.id === queued.command.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toContain("No open AAPL position");
    expect(broker.placed).toEqual([]);
    // The victim's position and command list are untouched.
    expect(broker.positions.get("ACCT-VICTIM-P")).toHaveLength(1);
    expect(listMobileCommands({ userId: victim.userId })).toHaveLength(0);
  });
});

describe("mobile order.replace_at_market", () => {
  it("replaces a stale working limit through the console's replacement state machine", async () => {
    const { userId } = await seedUser({
      accountNumber: "ACCT-REPLACE",
      positions: [heldLong()],
      orders: [staleLimitBuy("stale-1")]
    });
    const { queueMobileCommand, executeMobileCommandImmediately, listMobileCommands } = await import("../src/lib/mobile-api");

    // A queued run_once must survive the replace (non-protective blast radius).
    const queuedRun = queueMobileCommand({ userId, commandType: "strategy.run_once" });
    const queued = queueMobileCommand({ userId, commandType: "order.replace_at_market", payload: { orderId: "stale-1", accountNumber: "ACCT-REPLACE" } });
    const done = await executeMobileCommandImmediately(queued.command.id, userId);

    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ ok: true, canceledOrderId: "stale-1", remainingQuantity: 8 });
    expect(broker.canceled).toEqual([{ accountNumber: "ACCT-REPLACE", orderId: "stale-1" }]);
    expect(broker.placed).toEqual([{ accountNumber: "ACCT-REPLACE", symbol: "AAPL", side: "buy", type: "market", quantity: 8 }]);
    const stillQueued = listMobileCommands({ userId }).find((command) => command.id === queuedRun.command.id);
    expect(stillQueued?.status).toBe("queued");
    expect(await auditKinds(userId)).toContain("mobile_order_replace_at_market");
  });

  it("refuses an order id the broker does not have, as a precondition failure", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-REPL-MISSING", orders: [] });
    const { queueMobileCommand, executeMobileCommandImmediately } = await import("../src/lib/mobile-api");
    const queued = queueMobileCommand({ userId, commandType: "order.replace_at_market", payload: { orderId: "ghost" } });
    const done = await executeMobileCommandImmediately(queued.command.id, userId);

    expect(done.status).toBe("failed");
    expect(done.result).toMatchObject({ error: "replace_precondition_failed" });
    expect(done.error).toContain("Order was not found at the broker");
    expect(broker.canceled).toEqual([]);
    expect(broker.placed).toEqual([]);
  });

  it("refuses when the named account is no longer selected, before touching the broker", async () => {
    const { userId } = await seedUser({ accountNumber: "ACCT-REPL-MOVED", orders: [staleLimitBuy("stale-2")] });
    const { queueMobileCommand, executeMobileCommandImmediately } = await import("../src/lib/mobile-api");
    // Same shape as the order.cancel account-mismatch case: a named-but-not-selected account is
    // refused at the scoping check, before any broker read or cancel.
    const queued = queueMobileCommand({
      userId,
      commandType: "order.replace_at_market",
      payload: { orderId: "stale-2", accountNumber: "ACCT-STALE-BELIEF" }
    });
    const done = await executeMobileCommandImmediately(queued.command.id, userId);

    expect(done.status).toBe("failed");
    expect(done.error).toContain("changed since this was sent");
    expect(broker.canceled).toEqual([]);
    expect(await auditKinds(userId)).toContain("mobile_replace_market_account_mismatch");
  });
});
