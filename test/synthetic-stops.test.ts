import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStop, runSyntheticStopMonitor } from "../src/lib/synthetic-stops";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { listFillEvents, upsertConnectedAccount } from "../src/lib/db";
import type { TradingPolicy } from "../src/lib/types";

const broker = vi.hoisted(() => ({
  positions: [] as Array<{ symbol: string; quantity: number; averageCost: number; marketValue: number }>,
  quotes: {} as Record<string, { price?: number }>,
  placed: [] as Array<{ side: string; quantity: number; symbol: string }>,
  orders: [] as Array<{ id: string; symbol: string; side: string; type: string; state: string }>
}));

vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getPortfolio: async () => ({
      accountNumber: "TEST",
      totalMarketValue: 10000,
      buyingPower: 5000,
      equityMarketValue: 10000,
      optionMarketValue: 0,
      cash: 5000
    }),
    getEquityPositions: async () => broker.positions,
    getEquityOrders: async () => broker.orders,
    getEquityQuotes: async () => broker.quotes,
    getEquityTradability: async (_accountNumber: string, symbols: string[]) => Object.fromEntries(
      symbols.map((symbol) => [symbol, { tradable: true, fractional: true }])
    ),
    placeEquityOrder: async (order: { side: string; quantity: number; symbol: string }) => {
      broker.placed.push(order);
      return { orderId: "ord-1" };
    }
  })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-synthstops-${randomUUID()}.db`)}`;
});

const longBase = { side: "long" as const, extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 100 };

describe("evaluateStop (synthetic trailing stop)", () => {
  it("raises the extreme as a long climbs and does not trigger above the trail", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 100, lastPrice: 105 }, 110);
    expect(r.newExtreme).toBe(110);
    expect(r.triggerPrice).toBeCloseTo(104.5); // 110 * (1 - 5%)
    expect(r.triggered).toBe(false);
  });

  it("triggers a long when price falls trailPercent below the extreme", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 109 }, 104); // 104 <= 104.5
    expect(r.triggered).toBe(true);
    expect(r.newExtreme).toBe(110); // a pullback never raises the extreme
  });

  it("ignores a bad tick (>10% off last price): no extreme move, no trigger", () => {
    const r = evaluateStop({ ...longBase, extremePrice: 110, lastPrice: 110 }, 60); // -45% spurious print
    expect(r.badTick).toBe(true);
    expect(r.newExtreme).toBe(110);
    expect(r.triggered).toBe(false);
  });

  it("triggers a short when price rises trailPercent above the low extreme", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: 5, trailAmount: undefined, lastPrice: 101 }, 106);
    expect(r.triggerPrice).toBeCloseTo(105); // 100 * (1 + 5%)
    expect(r.triggered).toBe(true);
  });

  it("lowers the extreme as a short falls and supports an absolute trail amount", () => {
    const r = evaluateStop({ side: "short", extremePrice: 100, trailPercent: undefined, trailAmount: 3, lastPrice: 99 }, 95);
    expect(r.newExtreme).toBe(95); // a short's extreme tracks DOWN
    expect(r.triggerPrice).toBeCloseTo(98); // 95 + 3
    expect(r.triggered).toBe(false); // 95 < 98, not yet
  });
});

describe("runSyntheticStopMonitor (orchestration)", () => {
  function policyFor(account: string): TradingPolicy {
    return {
      ...DEFAULT_POLICY,
      accountNumber: account,
      systemState: "active",
      shortSellingEnabled: true,
      additionalSymbols: ["AAPL", "TSLA", "NVDA"],
      riskRules: { ...DEFAULT_POLICY.riskRules, trailingStopPct: 5 }
    };
  }

  // An account is an account: runSyntheticStopMonitor derives its execution mode from the real
  // connected account's own `environment` (getActiveConnectedAccount) — there is no local-simulation
  // fallback. getBrokerGateway itself is mocked above, but the account lookup is real DB state, so
  // every test needs a matching connected TEST-BROKER account (test infrastructure) wired up first.
  function connectTestAccount(accountNumber: string, environment: "paper" | "live" = "paper"): void {
    upsertConnectedAccount({
      id: `acct-${accountNumber}`,
      userId: "local",
      broker: "test",
      environment,
      accountNumber,
      label: accountNumber,
      isActive: true
    });
  }

  beforeEach(() => {
    broker.positions = [];
    broker.quotes = {};
    broker.placed = [];
    broker.orders = [];
  });

  it("auto-registers and fires a SELL to exit a long when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // extreme 100, trail 5% → trigger ≤95; 90 breaches
    connectTestAccount("SYN-LONG");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LONG"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
    expect(broker.placed[0].quantity).toBe(10);
  });

  it("fires a COVER to exit a short when the trail breaches (running)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } }; // short extreme 100, trail 5% → trigger ≥105; 110 breaches
    connectTestAccount("SYN-SHORT");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SHORT"), true);
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("cover");
    expect(broker.placed[0].quantity).toBe(5);
  });

  it("suppresses the exit order when not running (would-trigger only)", async () => {
    broker.positions = [{ symbol: "TSLA", quantity: -5, averageCost: 100, marketValue: -500 }];
    broker.quotes = { TSLA: { price: 110 } };
    connectTestAccount("SYN-SUPPRESS");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-SUPPRESS"), false);
    expect(result.triggered).toBe(1);
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("does NOT auto-register a synthetic stop when a broker-held stop already rests for the symbol", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } }; // would breach a 5% trail off extreme 100 IF registered
    broker.orders = [{ id: "oco-stop-1", symbol: "AAPL", side: "sell", type: "stop", state: "new" }];
    connectTestAccount("SYN-BRACKET");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-BRACKET"), true);
    // The broker bracket owns the exit — no synthetic stop registered, so nothing evaluated/fired.
    expect(result.exited).toBe(0);
    expect(broker.placed).toHaveLength(0);
  });

  it("still auto-registers when the only broker stop for the symbol is terminal (canceled)", async () => {
    broker.positions = [{ symbol: "AAPL", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { AAPL: { price: 90 } };
    broker.orders = [{ id: "dead", symbol: "AAPL", side: "sell", type: "stop", state: "canceled" }];
    connectTestAccount("SYN-CANCELED");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-CANCELED"), true);
    // A canceled broker stop no longer protects → the synthetic must take over and fire.
    expect(result.exited).toBe(1);
    expect(broker.placed).toHaveLength(1);
    expect(broker.placed[0].side).toBe("sell");
  });

  it("books a LIVE stop exit as pending_reconciliation (provisional at quote price, not a final fill)", async () => {
    broker.positions = [{ symbol: "NVDA", quantity: 10, averageCost: 100, marketValue: 1000 }];
    broker.quotes = { NVDA: { price: 90 } }; // breaches a 5% trail off extreme 100
    connectTestAccount("SYN-LIVE", "live");
    const result = await runSyntheticStopMonitor("local", policyFor("SYN-LIVE"), true);
    expect(result.exited).toBe(1);
    const fills = listFillEvents("SYN-LIVE", "live", 10, "local");
    expect(fills).toHaveLength(1);
    expect(fills[0].status).toBe("pending_reconciliation"); // reconcilePendingFills books the real fill
    expect(fills[0].brokerOrderId).toBe("ord-1");
  });
});
