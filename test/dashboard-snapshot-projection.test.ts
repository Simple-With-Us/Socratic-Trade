import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CLIENT_SNAPSHOT_TERMINAL_ORDER_LIMIT,
  collectSnapshotQuoteSymbols,
  projectMarketScanForClient,
  projectOrdersForClientSnapshot,
  projectQuotesBySymbolForClient
} from "../src/lib/dashboard-snapshot-projection";
import type { EquityOrder, MarketScan } from "../src/lib/types";

vi.mock("../src/lib/macro", () => ({
  fetchMacroData: vi.fn(async () => ({})),
  determineMarketRegime: vi.fn(() => "Unknown")
}));
vi.mock("../src/lib/macro-metrics", () => ({ deriveMacroMetrics: vi.fn(() => ({})) }));
vi.mock("../src/lib/macro-history", () => ({ fetchMacroHistory: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals", () => ({ getMarketSignals: vi.fn(async () => ({})) }));
vi.mock("../src/lib/market-signals/massive", () => ({ fetchMassiveNews: vi.fn(async () => []) }));
vi.mock("../src/lib/market-internals", () => ({ computeMarketInternals: vi.fn(() => ({ medianEarnYld: undefined })) }));
vi.mock("../src/lib/benchmark", () => ({
  computeSpyBenchmark: vi.fn(async () => null),
  computeSpyBenchmarkDetailed: vi.fn(async () => ({ comparison: null }))
}));
vi.mock("../src/lib/web-sources", () => ({
  getCongressDataset: vi.fn(() => undefined),
  getInsiderDataset: vi.fn(() => undefined),
  getWebSourcesStatus: vi.fn(() => ({}))
}));
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: vi.fn(() => ({
    async getAccounts() {
      return [{ accountNumber: "TEST", label: "Test", agenticAllowed: true }];
    },
    async getPortfolio() {
      return { accountNumber: "TEST", totalMarketValue: 1000, buyingPower: 1000, equityMarketValue: 0, optionMarketValue: 0, cash: 1000 };
    },
    async getEquityPositions() {
      return [];
    },
    async getEquityOrders() {
      return [];
    },
    async getEquityQuotes() {
      return {};
    }
  }))
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-dash-projection-${randomUUID()}.db`)}`;
});

afterEach(async () => {
  const { resetDashboardSnapshotCacheForTests } = await import("../src/lib/dashboard-snapshot-cache");
  resetDashboardSnapshotCacheForTests();
});

describe("dashboard snapshot projection helpers", () => {
  it("keeps only referenced symbols in quotesBySymbol", () => {
    const symbols = collectSnapshotQuoteSymbols({
      positions: [{ symbol: "AAPL", quantity: 1, averageCost: 1, marketValue: 1 } as import("../src/lib/types").EquityPosition],
      orders: [{ symbol: "MSFT" } as EquityOrder],
      pendingProposals: [],
      scan: { topCandidates: [{ symbol: "NVDA" } as MarketScan["topCandidates"][number]] }
    });
    const projected = projectQuotesBySymbolForClient(
      {
        AAPL: { symbol: "AAPL", price: 1, score: 1 },
        MSFT: { symbol: "MSFT", price: 2, score: 2 },
        NVDA: { symbol: "NVDA", price: 3, score: 3 },
        TSLA: { symbol: "TSLA", price: 4, score: 4 }
      },
      symbols
    );
    expect(Object.keys(projected).sort()).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(projected.TSLA).toBeUndefined();
  });

  it("projects orders to working rows plus terminal history cap", () => {
    const terminal = Array.from({ length: 30 }, (_, index) => ({
      id: `t-${index}`,
      symbol: "AAPL",
      state: "filled",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString()
    })) as EquityOrder[];
    const working = [{ id: "w-1", symbol: "MSFT", state: "new", createdAt: "2026-01-01T00:00:00.000Z" }] as EquityOrder[];
    const projected = projectOrdersForClientSnapshot([...terminal, ...working]);
    expect(projected.filter((order) => order.state === "new")).toHaveLength(1);
    expect(projected.filter((order) => order.state === "filled")).toHaveLength(CLIENT_SNAPSHOT_TERMINAL_ORDER_LIMIT);
  });

  it("projectMarketScanForClient preserves topCandidates while trimming quotes", () => {
    const scan = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: "test",
      scannedSymbols: 2,
      returnedQuotes: 2,
      sectorBySymbol: {},
      warnings: [],
      topCandidates: [{ symbol: "AAPL", price: 10, score: 1, volume: 1, intradayChangePct: 0, positionMarketValue: 0 }],
      quotesBySymbol: {
        AAPL: { symbol: "AAPL", price: 10, score: 1 },
        TSLA: { symbol: "TSLA", price: 20, score: 2 }
      }
    } as MarketScan;
    const projected = projectMarketScanForClient(scan, new Set(["AAPL"]));
    expect(projected?.topCandidates).toHaveLength(1);
    expect(Object.keys(projected?.quotesBySymbol ?? {})).toEqual(["AAPL"]);
  });
});

describe("getDashboardSnapshot client payload projection", () => {
  it("omits raw audit[] while keeping auditFeed/unifiedFeed", async () => {
    const db = await import("../src/lib/db");
    const { getDashboardSnapshot } = await import("../src/lib/dashboard");
    const userId = `dash-projection-${randomUUID()}`;

    db.audit("market_scan", { scan: { generatedAt: new Date().toISOString(), topCandidates: [] } }, userId);

    const snapshot = await getDashboardSnapshot(userId);
    expect("audit" in snapshot ? snapshot.audit : undefined).toBeUndefined();
    expect(Array.isArray(snapshot.auditFeed)).toBe(true);
    expect(Array.isArray(snapshot.unifiedFeed)).toBe(true);
  });
});
