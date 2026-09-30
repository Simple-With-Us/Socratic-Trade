/**
 * PR #4005 review round (2026-09-30): the AUTOPILOT lane's wiring of the exit-stop-release fences,
 * through the REAL runStrategyOnce.
 *
 *  - Owner Stop lands while the app's own stop is being released: the final placement fence
 *    (`placementBlockReason`, wired in strategy.ts) must keep the exit from leaving and put the
 *    released stop back.  Before this file only the approval lane had an end-to-end test, so
 *    deleting that strategy.ts line (or pointing it at the wrong account) left every test green.
 *  - A transient refusal inside the release (the position re-read failed after the cancel) must
 *    book retryable "not_placed", never terminal "blocked" (ExitStopReleaseError position_unverified
 *    used to fall through to the generic OrderValidationError branch).
 *
 * The mocked broker ENFORCES held quantity like Alpaca (403 while an open sell holds the shares),
 * so an exit only reaches it once the app's own stop is out of the way.  LLM fixture shape from
 * test/order-position-invariant-lanes.test.ts.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { EquityOrder, EquityPosition, TradingPolicy } from "../src/lib/types";

const broker = vi.hoisted(() => ({
  positions: [] as EquityPosition[],
  orders: [] as EquityOrder[],
  placed: [] as Array<{ symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; refId?: string }>,
  cancelled: [] as string[],
  seq: 0,
  /** Position reads that fail next (the release's post-cancel re-read). */
  failPositionReads: 0,
  /** The deterministic test gateway every non-overridden call falls through to (set in beforeAll). */
  makeBase: undefined as undefined | ((userId: string) => object),
  /** Test hook: runs as the broker receives a cancel (e.g. the owner pressing Stop mid-release). */
  onCancel: undefined as (() => void) | undefined
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 0, indexed: 0 })
}));

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  const ACTIVE = new Set(["new", "accepted", "held", "pending_new", "partially_filled", "pending_cancel"]);
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const quote = (symbol: string) => ({ symbol, price: 50, bid: 49.99, ask: 50, asOf: new Date().toISOString(), provider: "test" });
  return {
    ...actual,
    getBrokerGateway: (_policy: TradingPolicy, userId: string = "local") => {
      if (!broker.makeBase) throw new Error("test base gateway not set");
      const base = broker.makeBase(userId);
      const overrides: Record<string, unknown> = {
        ordersListIncludesTerminal: true,
        getPortfolio: async (accountNumber: string) => ({
          accountNumber,
          totalMarketValue: 10_000,
          buyingPower: 8_800,
          equityMarketValue: broker.positions.reduce((sum, p) => sum + p.marketValue, 0),
          optionMarketValue: 0,
          cash: 8_800
        }),
        getEquityPositions: async () => {
          if (broker.failPositionReads > 0) {
            broker.failPositionReads -= 1;
            throw new Error("alpaca getPositions timed out");
          }
          return clone(broker.positions);
        },
        getEquityOrders: async () => clone(broker.orders),
        getEquityQuotes: async (_accountNumber: string, symbols: string[]) =>
          Object.fromEntries(symbols.map((symbol) => [symbol.toUpperCase(), quote(symbol.toUpperCase())])),
        reviewEquityOrder: async (input: { quantity?: number; dollarAmount?: number }) => ({
          estimatedNotional: input.dollarAmount ?? (input.quantity ?? 0) * 50,
          alerts: [],
          raw: {}
        }),
        cancelEquityOrder: async (_accountNumber: string, orderId: string) => {
          broker.cancelled.push(orderId);
          broker.onCancel?.();
          const order = broker.orders.find((o) => o.id === orderId);
          if (order) order.state = "canceled";
          return { orderId, refId: "x", state: "cancel_requested", raw: {} };
        },
        placeEquityOrder: async (order: { symbol: string; side: string; type: string; quantity?: number; stopPrice?: number; refId?: string }) => {
          broker.placed.push(order);
          const position = broker.positions.find((p) => p.symbol === order.symbol);
          const qty = order.quantity ?? 0;
          if (order.side === "sell") {
            const held = broker.orders
              .filter((o) => o.symbol === order.symbol && o.side === "sell" && ACTIVE.has(String(o.state)))
              .reduce((sum, o) => sum + ((o.quantity ?? 0) - (o.filledQuantity ?? 0)), 0);
            const available = Math.max((position?.quantity ?? 0) - held, 0);
            if (qty > available) throw new Error(`HTTP 403 insufficient qty available for order (requested: ${qty}, available: ${available})`);
          }
          broker.seq += 1;
          const id = `ord-${broker.seq}`;
          const fills = order.type === "market";
          broker.orders.push({
            id,
            symbol: order.symbol,
            side: order.side as EquityOrder["side"],
            type: order.type as EquityOrder["type"],
            state: fills ? "filled" : "new",
            quantity: qty,
            filledQuantity: fills ? qty : 0,
            averagePrice: fills ? 50 : undefined,
            stopPrice: order.stopPrice,
            createdAt: new Date().toISOString(),
            clientOrderId: order.refId
          });
          if (fills && position) {
            position.quantity -= qty;
            position.marketValue = position.quantity * 50;
            if (position.quantity <= 0) broker.positions = broker.positions.filter((p) => p.symbol !== order.symbol);
          }
          return { orderId: id, refId: order.refId ?? id, state: fills ? "filled" : "new", raw: {} };
        }
      };
      return new Proxy(base, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && prop in overrides) return overrides[prop];
          return Reflect.get(target, prop, receiver);
        }
      });
    }
  };
});

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-exit-stop-release-autopilot-${randomUUID()}.db`)}`;
  const { getTestGateway } = await import("../src/lib/robinhood");
  broker.makeBase = (userId) => getTestGateway(userId);
}, 180_000);

beforeEach(() => {
  broker.positions = [{ symbol: "BAC", quantity: 24, averageCost: 50, marketValue: 24 * 50 }];
  broker.orders = [
    {
      id: "stop-BAC",
      symbol: "BAC",
      side: "sell",
      type: "stop_market",
      state: "new",
      quantity: 24,
      filledQuantity: 0,
      stopPrice: 46,
      timeInForce: "gtc",
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      clientOrderId: "protstop-g2-BAC-1700000000000"
    }
  ];
  broker.placed = [];
  broker.cancelled = [];
  broker.seq = 0;
  broker.failPositionReads = 0;
  broker.onCancel = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// The deterministic test gateway (getAccounts, capabilities) serves exactly this account number.
const ACCOUNT = "TEST";

function stubLlmAndScan(): void {
  vi.stubEnv("OPENROUTER_API_KEY", "test-openai-key");
  vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");
  vi.stubEnv("AGENTIC_TEST_FORCE_TRADING_DAY", "1");
  const exitProposal = {
    symbol: "BAC",
    side: "sell",
    type: "market",
    quantity: 24,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Exit the whole BAC long: the thesis is spent (autopilot stop-release lane test).",
    tradeThesisTag: "Discretionary-Exit",
    confidenceScore: 85
  };
  const chat = (content: unknown) =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("openrouter.ai") || href.includes("api.openai.com")) {
      const body = String(init?.body ?? "");
      if (body.includes("Red Team Risk Agent") || body.includes("rigorously critique")) {
        return chat({ verdict: "approve", reason: "Lane fixture looks fine." });
      }
      return chat({ proposals: [exitProposal] });
    }
    if (href.includes("nasdaq.com")) {
      return new Response(
        JSON.stringify({
          data: {
            asof: "2026-06-15",
            table: {
              rows: [
                {
                  symbol: "BAC",
                  lastsale: "$50",
                  pctchange: "0%",
                  volume: "1000000",
                  marketCap: "300000000000",
                  sector: "Finance",
                  industry: "Major Banks"
                }
              ]
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

async function seed(userId: string): Promise<{ accountId: string; policy: TradingPolicy }> {
  const db = await import("../src/lib/db");
  db.upsertUserApiKey(userId, "openrouter", "test-openai-key", "exit stop release autopilot fixture");
  const accountId = randomUUID();
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT,
    label: "G2 autopilot",
    isActive: true
  });
  db.setActiveConnectedAccount(accountId, userId);
  const policy: TradingPolicy = {
    ...DEFAULT_POLICY,
    connectedAccountId: accountId,
    accountNumber: ACCOUNT,
    activeBroker: "alpaca",
    systemState: "active",
    strategyAuthority: "decide",
    brokerTrailingStops: false,
    riskRules: { ...DEFAULT_POLICY.riskRules, stopLossPct: 8, trailingStopPct: 0 },
    includedIndices: [],
    additionalSymbols: ["BAC"],
    llmModel: "openai/gpt-4.1-mini",
    redTeamLlmModel: "openai/gpt-4.1-mini",
    maxOrderPctOfNav: 100,
    maxDailyNotional: 400_000,
    maxDailyPctOfNav: 0,
    maxSymbolExposurePct: 100,
    maxGrossExposurePct: 1000,
    maxNetExposurePct: 1000
  };
  db.setPolicy(policy, userId, accountId);
  // The app's OWN protective stop, exactly as the reconciler tracks it.
  db.upsertBrokerProtectiveStop({
    id: `protstop-${userId}-${ACCOUNT}-BAC`,
    userId,
    accountNumber: ACCOUNT,
    symbol: "BAC",
    brokerOrderId: "stop-BAC",
    quantity: 24,
    stopPrice: 46,
    status: "resting",
    kind: "fixed"
  });
  return { accountId, policy };
}

describe("runStrategyOnce — autopilot exit vs the app's own resting stop", () => {
  it("owner presses Stop while the stop is being released: the exit is blocked, not sent, and the stop is put back", async () => {
    const userId = `g2-auto-halt-${randomUUID()}`;
    stubLlmAndScan();
    const { accountId, policy } = await seed(userId);
    const db = await import("../src/lib/db");
    // The durable Stop lands on THIS account after the lane's own fence passed, mid-release.
    broker.onCancel = () => db.setPolicy({ ...policy, systemState: "halted" }, userId, accountId);

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const run = await runStrategyOnce(userId, { manual: false, connectedAccountId: accountId });

    expect(broker.cancelled).toEqual(["stop-BAC"]);
    // The only order sent is the restored protective stop for all 24 shares; the exit never left.
    expect(broker.placed.map((o) => [o.symbol, o.side, o.type, o.quantity, o.stopPrice])).toEqual([["BAC", "sell", "stop_market", 24, 46]]);
    const result = run.proposals.find((p) => p.proposal.symbol === "BAC");
    expect(result?.reasons?.[0]).toMatch(/halted/);
    const rows = db.listRecentProposals(ACCOUNT, 100, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
    const kinds = db.listAudit(500, userId).map((entry) => entry.kind);
    expect(kinds).toContain("exit_stop_release_placement_blocked");
    const stops = db.listBrokerProtectiveStops(ACCOUNT, userId);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ quantity: 24, status: "resting" });
  }, 180_000);

  it("the position re-read fails after the stop cancel: retryable not_placed, never terminal blocked, and the stop is put back", async () => {
    const userId = `g2-auto-unverified-${randomUUID()}`;
    stubLlmAndScan();
    const { accountId } = await seed(userId);
    // Exactly the release's post-cancel position read fails (a transient broker timeout).
    broker.onCancel = () => {
      broker.failPositionReads = 1;
    };

    const { runStrategyOnce } = await import("../src/lib/strategy");
    const run = await runStrategyOnce(userId, { manual: false, connectedAccountId: accountId });

    expect(broker.cancelled).toEqual(["stop-BAC"]);
    expect(broker.placed.map((o) => [o.symbol, o.side, o.type, o.quantity, o.stopPrice])).toEqual([["BAC", "sell", "stop_market", 24, 46]]);
    const result = run.proposals.find((p) => p.proposal.symbol === "BAC");
    expect(result?.status).toBe("error");
    const db = await import("../src/lib/db");
    const rows = db.listRecentProposals(ACCOUNT, 100, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("not_placed");
    const kinds = db.listAudit(500, userId).map((entry) => entry.kind);
    expect(kinds).toContain("order_not_placed_exit_stop_release");
    expect(kinds).not.toContain("order_blocked_live_preflight");
  }, 180_000);
});
