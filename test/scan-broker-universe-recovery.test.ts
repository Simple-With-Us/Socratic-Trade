import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALPACA_PAPER_DELAY_TOLERANCE_SEC,
  ALPACA_PAPER_EXPECTED_DELAY_SEC
} from "../src/lib/alpaca-paper-quotes";
import { BROKER_QUOTE_SYMBOL_CAP } from "../src/lib/inflight-deadline";
import {
  clearMarketCache,
  scanMarket,
  ScanQuotesUnavailableError
} from "../src/lib/market";
import { recoverUniverseQuotesFromBroker } from "../src/lib/scan-broker-universe-recovery";
import { getPolicy, resetDbForTesting, setPolicy, upsertConnectedAccount } from "../src/lib/db";
import type { BrokerQuote } from "../src/lib/types";
import { resetProviderRateLimiterState } from "../src/lib/provider-rate-limit";

const mockGetEquityQuotes = vi.fn();

vi.mock("../src/lib/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/broker")>();
  return {
    ...actual,
    getBrokerGateway: () => ({
      getEquityQuotes: mockGetEquityQuotes
    })
  };
});

function liveDelayedPaperQuote(symbol: string): BrokerQuote {
  const now = Date.now();
  return {
    symbol,
    price: 210.5,
    bid: 210.4,
    ask: 210.6,
    prevClose: 208,
    open: 209,
    high: 211,
    low: 207.5,
    asOf: new Date(now - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000).toISOString(),
    provider: "alpaca",
    fetchedAt: new Date(now).toISOString(),
    venuePriceAuthoritative: true,
    expectedDelaySec: ALPACA_PAPER_EXPECTED_DELAY_SEC,
    delayToleranceSec: ALPACA_PAPER_DELAY_TOLERANCE_SEC
  };
}

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scan-broker-recovery-${randomUUID()}.db`)}`;
  resetDbForTesting();
});

beforeEach(() => {
  clearMarketCache();
  resetProviderRateLimiterState();
  mockGetEquityQuotes.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubEmptyNasdaqYahoo(): void {
  vi.stubGlobal("fetch", async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.includes("api.nasdaq.com")) {
      return new Response(
        JSON.stringify({ data: { asof: "2026-11-09", table: { rows: [] } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  });
}

function tradierVenueQuote(symbol: string): BrokerQuote {
  const now = Date.now();
  return {
    symbol,
    price: 118.25,
    bid: 118.2,
    ask: 118.3,
    volume: 1_200_000,
    prevClose: 117,
    change: 1.25,
    changePct: 1.07,
    asOf: new Date(now - 15 * 60 * 1000).toISOString(),
    provider: "tradier",
    fetchedAt: new Date(now).toISOString(),
    venuePriceAuthoritative: true
  };
}

function seedTradierSandboxUser(userId: string, accountId: string): void {
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "tradier",
    environment: "paper",
    accountNumber: "VA123",
    label: "Tradier sandbox",
    isActive: true
  });
  const policy = getPolicy(userId, accountId);
  setPolicy(
    {
      ...policy,
      activeBroker: "tradier",
      connectedAccountId: accountId,
      accountNumber: "VA123"
    },
    userId,
    accountId
  );
}

function seedAlpacaPaperUser(userId: string, accountId: string): void {
  upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: "PA123",
    label: "Alpaca paper",
    isActive: true
  });
  const policy = getPolicy(userId, accountId);
  setPolicy(
    {
      ...policy,
      activeBroker: "alpaca",
      connectedAccountId: accountId,
      accountNumber: "PA123"
    },
    userId,
    accountId
  );
}

describe("recoverUniverseQuotesFromBroker", () => {
  it("returns usable Alpaca PAPER delayed_sip quotes for the allowed set", async () => {
    const userId = "broker-recovery-user";
    const accountId = `ap-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    mockGetEquityQuotes.mockResolvedValue({
      AAPL: liveDelayedPaperQuote("AAPL"),
      MSFT: liveDelayedPaperQuote("MSFT")
    });

    const result = await recoverUniverseQuotesFromBroker({
      symbols: ["AAPL", "MSFT"],
      positions: [],
      userId,
      connectedAccountId: accountId
    });

    expect(result.recoverySource).toBe("alpaca-delayed_sip");
    expect(result.quotes).toHaveLength(2);
    expect(result.quotes[0]?.expectedDelaySec).toBe(ALPACA_PAPER_EXPECTED_DELAY_SEC);
    expect(mockGetEquityQuotes).toHaveBeenCalled();
  });

  it("returns usable Tradier sandbox quotes with movement fields", async () => {
    const userId = "broker-recovery-tradier";
    const accountId = `tr-${userId}`;
    seedTradierSandboxUser(userId, accountId);
    mockGetEquityQuotes.mockResolvedValue({
      IBM: tradierVenueQuote("IBM")
    });

    const result = await recoverUniverseQuotesFromBroker({
      symbols: ["IBM"],
      positions: [],
      userId,
      connectedAccountId: accountId
    });

    expect(result.recoverySource).toBe("tradier");
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]?.intradayChangePct).toBe(1.07);
    expect(result.quotes[0]?.volume).toBe(1_200_000);
  });

  it("fetches broker quote chunks with bounded concurrency", async () => {
    const userId = "broker-recovery-parallel";
    const accountId = `ap-parallel-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    let inFlight = 0;
    let maxInFlight = 0;
    const symbolCount = BROKER_QUOTE_SYMBOL_CAP * 3 + 2;
    const symbols = Array.from({ length: symbolCount }, (_, i) => `SYM${i}`);

    mockGetEquityQuotes.mockImplementation(async (_acct: string, chunk: string[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return Object.fromEntries(chunk.map((symbol) => [symbol, liveDelayedPaperQuote(symbol)]));
    });

    const result = await recoverUniverseQuotesFromBroker({
      symbols,
      positions: [],
      userId,
      connectedAccountId: accountId
    });

    expect(result.quotes.length).toBe(symbolCount);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(mockGetEquityQuotes.mock.calls.length).toBeGreaterThan(1);
  });

  it("rethrows when the recovery signal is aborted", async () => {
    const userId = "broker-recovery-abort";
    const accountId = `ap-abort-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    const controller = new AbortController();
    controller.abort(new DOMException("aborted", "AbortError"));

    mockGetEquityQuotes.mockResolvedValue({ AAPL: liveDelayedPaperQuote("AAPL") });

    await expect(
      recoverUniverseQuotesFromBroker({
        symbols: ["AAPL"],
        positions: [],
        userId,
        connectedAccountId: accountId,
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed when the broker returns no priced symbols", async () => {
    const userId = "broker-recovery-empty";
    const accountId = `ap-empty-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    mockGetEquityQuotes.mockResolvedValue({});

    const result = await recoverUniverseQuotesFromBroker({
      symbols: ["AAPL"],
      positions: [],
      userId,
      connectedAccountId: accountId
    });

    expect(result.quotes).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/no usable quotes/i);
  });
});

describe("scanMarket broker universe recovery", () => {
  it("does not throw when Nasdaq/Yahoo miss but the broker fills the allowed set", async () => {
    const userId = "scan-broker-fill";
    const accountId = `ap-scan-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    stubEmptyNasdaqYahoo();
    mockGetEquityQuotes.mockResolvedValue({ AAPL: liveDelayedPaperQuote("AAPL") });

    const scan = await scanMarket(["AAPL"], [], undefined, userId, [], {
      enrichmentMode: "skip",
      connectedAccountId: accountId
    });

    expect(scan.returnedQuotes).toBe(1);
    expect(scan.universeQuoteRecoverySource).toBe("alpaca-delayed_sip");
    expect(scan.warnings.join(" ")).toMatch(/broker universe recovery/i);
    expect(scan.topCandidates[0]?.symbol).toBe("AAPL");
  });

  it("still throws ScanQuotesUnavailableError when Yahoo and broker both miss", async () => {
    const userId = "scan-broker-miss";
    const accountId = `ap-miss-${userId}`;
    seedAlpacaPaperUser(userId, accountId);
    stubEmptyNasdaqYahoo();
    mockGetEquityQuotes.mockResolvedValue({});

    await expect(
      scanMarket(["AAPL", "MSFT"], [], undefined, userId, [], {
        enrichmentMode: "skip",
        connectedAccountId: accountId
      })
    ).rejects.toBeInstanceOf(ScanQuotesUnavailableError);
  });
});
