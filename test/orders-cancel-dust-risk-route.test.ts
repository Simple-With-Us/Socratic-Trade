/**
 * POST /api/orders/cancel — cancel-dust advisory (r2 lesson: freqtrade). Cancelling a
 * partially-filled entry order can leave a position fragment below the broker's minimum order
 * notional; the route now surfaces that as `dustWarning` in the response and audits
 * "order_cancel_dust_risk" — but the cancel itself must ALWAYS execute regardless, since cancel is
 * the operator's emergency lever. These tests drive the REAL route handler through a mocked
 * BrokerGateway (activeBroker "robinhood", $1 floor) covering: a dust-producing partial fill, a
 * partial fill that's just scaling into a larger existing position (no warning), and a broker
 * lookup failure (fail-open — cancel still proceeds with no warning attached).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AUTHENTICATED_EMAIL_HEADER } from "../src/lib/request-user";
import type { EquityOrder, EquityPosition, ExecutedOrder } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-cancel-dust-route-${randomUUID()}.db`)}`;
});

const ACCOUNT = "RH-CANCEL-DUST";
const ORDER_ID = "order-partial-1";

let scriptedOrders: EquityOrder[] = [];
let scriptedPositions: EquityPosition[] = [];
let ordersShouldThrow = false;
const cancelEquityOrder = vi.fn(async (_accountNumber: string, orderId: string): Promise<ExecutedOrder> => ({
  orderId,
  refId: randomUUID(),
  state: "canceled",
  raw: { test: true }
}));

function makeGateway() {
  return {
    getAccounts: async () => [{ accountNumber: ACCOUNT, type: "brokerage" }],
    getPortfolio: async () => ({
      accountNumber: ACCOUNT,
      totalMarketValue: 5000,
      buyingPower: 2500,
      equityMarketValue: 5000,
      optionMarketValue: 0,
      cash: 2500
    }),
    getEquityPositions: async () => {
      if (ordersShouldThrow) throw new Error("broker unreachable");
      return scriptedPositions;
    },
    getEquityOrders: async () => {
      if (ordersShouldThrow) throw new Error("broker unreachable");
      return scriptedOrders;
    },
    getEquityQuotes: async () => ({}),
    getEquityTradability: async (_acc: string, symbols: string[]) =>
      Object.fromEntries(symbols.map((s) => [s, { tradable: true, fractional: true }])),
    reviewEquityOrder: vi.fn(async () => ({ estimatedNotional: 0, alerts: [], raw: {} })),
    placeEquityOrder: vi.fn(),
    cancelEquityOrder
  };
}

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return { ...actual, getBrokerGateway: () => makeGateway() };
});

async function seedAccount(userId: string) {
  const { upsertConnectedAccount, setPolicy } = await import("../src/lib/db");
  const { DEFAULT_POLICY } = await import("../src/lib/defaults");
  const accountId = randomUUID();
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "robinhood",
    environment: "paper",
    accountNumber: ACCOUNT,
    isActive: true,
    label: "Cancel Dust Test"
  });
  setPolicy({ ...DEFAULT_POLICY, activeBroker: "robinhood", accountNumber: ACCOUNT, connectedAccountId: accountId }, userId);
  return accountId;
}

function makeRequest(email: string): Request {
  return new Request("http://localhost/api/orders/cancel", {
    method: "POST",
    headers: { "content-type": "application/json", [AUTHENTICATED_EMAIL_HEADER]: email },
    body: JSON.stringify({ orderId: ORDER_ID })
  });
}

describe("POST /api/orders/cancel — cancel-dust advisory", () => {
  it("surfaces dustWarning and audits order_cancel_dust_risk, but still cancels", async () => {
    const email = `dust-warn-${randomUUID()}@example.com`;
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const userId = userIdForEmail(email);
    await seedAccount(userId);
    ordersShouldThrow = false;
    scriptedOrders = [
      {
        id: ORDER_ID,
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        state: "partially_filled",
        quantity: 0.02,
        filledQuantity: 0.005,
        averagePrice: 100,
        createdAt: new Date().toISOString()
      }
    ];
    // Filled 0.005 sh is the ENTIRE resulting position — nothing else backs it — and its $0.50
    // notional is below Robinhood's $1 floor.
    scriptedPositions = [{ symbol: "AAPL", quantity: 0.005, averageCost: 100, marketValue: 0.5 }];

    const { POST } = await import("../app/api/orders/cancel/route");
    const response = await POST(makeRequest(email));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dustWarning).toBeDefined();
    expect(body.dustWarning).toContain("AAPL");
    expect(body.dustWarning).toContain("$1.00");
    // The cancel must have actually gone through.
    expect(cancelEquityOrder).toHaveBeenCalledWith(ACCOUNT, ORDER_ID);

    const { getDb } = await import("../src/lib/db");
    const kinds = getDb().prepare("SELECT kind FROM audit_events WHERE user_id = ?").all(userId).map((r) => (r as { kind: string }).kind);
    expect(kinds).toContain("order_cancel_dust_risk");
    expect(kinds).toContain("order_cancel");
  });

  it("does not warn when the fill is only a slice of an existing larger position, and still cancels", async () => {
    const email = `dust-scaling-${randomUUID()}@example.com`;
    const { userIdForEmail } = await import("../src/lib/auth/identity");
    const userId = userIdForEmail(email);
    await seedAccount(userId);
    ordersShouldThrow = false;
    cancelEquityOrder.mockClear();
    scriptedOrders = [
      {
        id: ORDER_ID,
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        state: "partially_filled",
        quantity: 0.02,
        filledQuantity: 0.005,
        averagePrice: 100,
        createdAt: new Date().toISOString()
      }
    ];
    // Held position (5 sh) is much larger than the 0.005 sh this order filled — an add to an
    // existing position, not a standalone dust fragment.
    scriptedPositions = [{ symbol: "AAPL", quantity: 5, averageCost: 100, marketValue: 500 }];

    const { POST } = await import("../app/api/orders/cancel/route");
    const response = await POST(makeRequest(email));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dustWarning).toBeUndefined();
    expect(cancelEquityOrder).toHaveBeenCalledWith(ACCOUNT, ORDER_ID);

    const { getDb } = await import("../src/lib/db");
    const kinds = getDb().prepare("SELECT kind FROM audit_events WHERE user_id = ?").all(userId).map((r) => (r as { kind: string }).kind);
    expect(kinds).not.toContain("order_cancel_dust_risk");
    expect(kinds).toContain("order_cancel");
  });

  it("still cancels unconditionally when the dust lookup itself fails (fail-open)", async () => {
    const email = `dust-lookup-fails-${randomUUID()}@example.com`;
    await seedAccount(await (await import("../src/lib/auth/identity")).userIdForEmail(email));
    ordersShouldThrow = true;
    cancelEquityOrder.mockClear();

    const { POST } = await import("../app/api/orders/cancel/route");
    const response = await POST(makeRequest(email));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dustWarning).toBeUndefined();
    // The lookup failure must never block or delay the cancel itself.
    expect(cancelEquityOrder).toHaveBeenCalledWith(ACCOUNT, ORDER_ID);
  });
});
