/**
 * Regression tests: a broker call that resolves without throwing is NOT the same as "the broker
 * accepted the order" — Alpaca (and Robinhood) can both return a synchronous rejected/canceled
 * state without an HTTP error. Before this fix, executeProposal always recorded such a response
 * as proposal status "placed", telling the dashboard a live order existed when the broker had
 * already declined it. This drives the real approval path (executeProposal) through a mocked
 * Alpaca SDK so the fix is verified end-to-end, not just at the isRejectedOrCanceledState unit.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { MarketQuote, MarketScan } from "../src/lib/types";

vi.mock("../src/lib/vector-db", () => ({
  findRelevantExperiences: async () => [],
  upsertExperiences: async () => {},
  retrieveContext: async () => [],
  storeContext: async () => {},
  storeContexts: async () => {}
}));

// The market scan inside executeProposal is incidental to what this file verifies (broker
// order-state confirmation). Left unmocked it fans out to REAL Nasdaq-screener/Yahoo fetches
// (6-8s abort timeouts, 429-retry backoff): ~12s per test solo, and the direct cause of the
// full-suite flake — 4 workers' worth of shared network/rate-limit contention pushed these
// tests past even a 30s timeout. Stub ONLY scanMarket (importOriginal keeps mergeQuoteData
// and the other exports real) with a minimal fresh AAPL scan so the price/staleness gates in
// policy.ts still see a quote.
vi.mock("../src/lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/market")>();
  return {
    ...actual,
    scanMarket: async (): Promise<MarketScan> => {
      const asOf = new Date().toISOString();
      const aapl: MarketQuote = {
        symbol: "AAPL",
        price: 200,
        bid: 199,
        ask: 200,
        volume: 1_000_000,
        intradayChangePct: 0,
        positionMarketValue: 0,
        score: 1,
        provider: "test-scan",
        asOf
      };
      return {
        source: "test-scan",
        generatedAt: asOf,
        scannedSymbols: 1,
        returnedQuotes: 1,
        topCandidates: [aapl],
        sectorBySymbol: {},
        quotesBySymbol: { AAPL: aapl },
        warnings: []
      };
    }
  };
});

let mockOrderStatus = "accepted";
let lastCreateOrderOpts: Record<string, unknown> | null = null;

vi.mock("@alpacahq/alpaca-trade-api", () => {
  return {
    default: class MockAlpaca {
      async getAccount() {
        return { account_number: "ACC-CONFIRM", portfolio_value: "50000", buying_power: "25000", equity: "40000", cash: "40000" };
      }
      async getPositions() {
        return [];
      }
      async getOrders() {
        return [];
      }
      async getLatestQuotes(symbols: string[]) {
        if (symbols.includes("BRK.B")) return { "BRK.B": { bp: 409, ap: 410, t: new Date().toISOString() } };
        return { AAPL: { bp: 199, ap: 200, t: new Date().toISOString() } };
      }
      async createOrder(opts: Record<string, unknown>) {
        lastCreateOrderOpts = opts;
        return { id: "order-confirm-1", status: mockOrderStatus, qty: opts.qty, filled_qty: "0", filled_avg_price: null };
      }
      async cancelOrder() {}
    }
  };
});

const ACCOUNT = "ACC-CONFIRM";

async function seedLiveProposal(userId: string): Promise<string> {
  const { upsertConnectedAccount, setPolicy, insertProposal } = await import("../src/lib/db");

  // "paper" (not "live") deliberately — this exercises the identical broker/placeEquityOrder
  // code path (submitsBrokerOrders: true, real gateway, not the local simulator) without also
  // having to satisfy the separate typed live-approval confirmation gate, which is unrelated to
  // what this test verifies.
  upsertConnectedAccount({
    id: "acc-confirm-test",
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: ACCOUNT,
    baseUrl: "https://paper-api.alpaca.markets",
    apiKey: "AK_TEST",
    apiSecret: "secret",
    isActive: true,
    label: "Alpaca Paper Confirm Test"
  });

  setPolicy(
    {
      ...DEFAULT_POLICY,
      accountNumber: ACCOUNT,
      connectedAccountId: "acc-confirm-test",
      activeBroker: "alpaca",
      systemState: "active"
    },
    userId
  );

  const proposalId = randomUUID();
  insertProposal({
    id: proposalId,
    runId: randomUUID(),
    accountNumber: ACCOUNT,
    userId,
    proposal: {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      dollarAmount: 500,
      timeInForce: "gfd",
      marketHours: "regular_hours",
      rationale: "order confirmation test",
      tradeThesisTag: "Momentum-Breakout",
      entryMarketRegime: "Neutral (Normal Volatility)"
    },
    decision: { approved: true, reasons: [] },
    status: "proposed"
  });
  return proposalId;
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  mockOrderStatus = "accepted";
  lastCreateOrderOpts = null;
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-order-confirm-${randomUUID()}.db`)}`;
});

describe("executeProposal — broker-agnostic order-placement confirmation", () => {
  it("does NOT mark the proposal 'placed' when the broker synchronously rejects the order", async () => {
    mockOrderStatus = "rejected";
    const userId = `confirm-rejected-${randomUUID()}`;
    const proposalId = await seedLiveProposal(userId);

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("error");
    expect(result.brokerState).toBe("rejected");
    expect(lastCreateOrderOpts).not.toBeNull();

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("rejected_by_broker");
    expect(row?.status).not.toBe("placed");
  }, 30000); // Network is stubbed (scanMarket mock above); the pad now only covers the
  // vi.resetModules() re-import of the strategy module graph under full-suite CPU contention.

  it("marks the proposal 'placed' when the broker accepts the order", async () => {
    mockOrderStatus = "accepted";
    const userId = `confirm-accepted-${randomUUID()}`;
    const proposalId = await seedLiveProposal(userId);

    const { executeProposal } = await import("../src/lib/strategy");
    const { getProposal } = await import("../src/lib/db");

    const result = await executeProposal(proposalId, userId);

    expect(result.status).toBe("placed");
    expect(result.orderId).toBe("order-confirm-1");

    const row = getProposal(proposalId, userId);
    expect(row?.status).toBe("placed");
  }, 30000);

  it("returns quotes under both canonical and requested share-class symbols", async () => {
    const userId = `quote-alias-${randomUUID()}`;
    const connectedAccountId = "acc-quote-alias";
    const { upsertConnectedAccount } = await import("../src/lib/db");
    upsertConnectedAccount({
      id: connectedAccountId,
      userId,
      broker: "alpaca",
      environment: "paper",
      accountNumber: ACCOUNT,
      baseUrl: "https://paper-api.alpaca.markets",
      apiKey: "AK_TEST",
      apiSecret: "secret",
      isActive: true,
      label: "Alpaca Paper Quote Alias Test"
    });

    const { getAlpacaGateway } = await import("../src/lib/alpaca");
    const quotes = await getAlpacaGateway(userId, connectedAccountId).getEquityQuotes(ACCOUNT, ["BRK.B"]);

    expect(quotes["BRK-B"]?.price).toBe(410);
    expect(quotes["BRK.B"]?.price).toBe(410);
    expect(quotes["BRK.B"]?.symbol).toBe("BRK.B");
  });
});
