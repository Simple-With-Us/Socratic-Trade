import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALPACA_PAPER_DELAY_TOLERANCE_SEC,
  ALPACA_PAPER_EXPECTED_DELAY_SEC
} from "../src/lib/alpaca-paper-quotes";
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
