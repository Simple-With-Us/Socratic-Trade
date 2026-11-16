/**
 * Alpaca broker gateway — ACCOUNT-SCOPED market-data feed.
 *
 * The connected Alpaca PAPER account (`broker=alpaca`, `environment=paper`)
 * must request Alpaca's `delayed_sip` feed (expected ~900s publication delay)
 * and stamp the result as the venue-authoritative delayed tape.  Every other
 * account (Alpaca LIVE, the operator env path) must keep the SDK default feed
 * and the ordinary real-time quote semantics.
 *
 * The global `ALPACA_DATA_FEED` env var is deliberately NOT consulted here —
 * it is a process-wide setting and would repoint other accounts' tapes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALPACA_PAPER_DELAY_TOLERANCE_SEC, ALPACA_PAPER_EXPECTED_DELAY_SEC } from "../src/lib/alpaca-paper-quotes";

const mockGetConnectedAccount = vi.fn();
vi.mock("../src/lib/db", () => ({
  getConnectedAccount: (...args: unknown[]) => mockGetConnectedAccount(...args),
  getActiveConnectedAccount: () => undefined,
  resolveApiKey: () => undefined,
  audit: () => {}
}));

vi.mock("../src/lib/db-health", () => ({
  logApiHealth: () => {}
}));

const mockGetLatestQuotes = vi.fn();
const mockGetLatestTrades = vi.fn();
vi.mock("../src/lib/alpaca-sdk-legacy-client", () => ({
  createAlpacaBrokerSdk: () => ({
    configuration: { paper: true },
    getLatestQuotes: mockGetLatestQuotes,
    getLatestTrades: mockGetLatestTrades,
    getAccount: async () => ({}),
    getPositions: async () => [],
    getOrders: async () => [],
    getAsset: async () => ({}),
    createOrder: async () => ({}),
    cancelOrder: async () => {},
    getOrder: async () => ({}),
    sendRequest: async () => ({})
  })
}));

const { getAlpacaGateway } = await import("../src/lib/alpaca");

const PAPER_ACCOUNT = {
  id: "ap-paper",
  userId: "local",
  broker: "alpaca",
  environment: "paper",
  label: "Alpaca Paper",
  apiKey: "paper-key",
  apiSecret: "paper-secret",
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const LIVE_ACCOUNT = { ...PAPER_ACCOUNT, id: "ap-live", environment: "live" as const, label: "Alpaca Live" };

const NOW = Date.parse("2026-11-05T20:00:00.000Z");

describe("Alpaca gateway — account-scoped market-data feed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLatestQuotes.mockResolvedValue({
      AAPL: { bp: 199.9, ap: 200.1, t: new Date(NOW - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000).toISOString() }
    });
    mockGetLatestTrades.mockResolvedValue({
      AAPL: { p: 200, t: new Date(NOW - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000).toISOString() }
    });
  });

  it("requests delayed_sip for the connected Alpaca PAPER account", async () => {
    mockGetConnectedAccount.mockReturnValue(PAPER_ACCOUNT);
    const gateway = getAlpacaGateway("local", "ap-paper");

    const quotes = await gateway.getEquityQuotes("PA33IDTHMFK9", ["AAPL"]);

    expect(mockGetLatestQuotes).toHaveBeenCalledWith(
      expect.arrayContaining(["AAPL"]),
      { feed: "delayed_sip" }
    );
    expect(mockGetLatestTrades).toHaveBeenCalledWith(
      expect.arrayContaining(["AAPL"]),
      { feed: "delayed_sip" }
    );
    expect(quotes.AAPL?.price).toBe(200);
  });

  it("stamps the PAPER quote as the venue-authoritative delayed tape", async () => {
    mockGetConnectedAccount.mockReturnValue(PAPER_ACCOUNT);
    const gateway = getAlpacaGateway("local", "ap-paper");

    const quotes = await gateway.getEquityQuotes("PA33IDTHMFK9", ["AAPL"]);

    expect(quotes.AAPL?.venuePriceAuthoritative).toBe(true);
    expect(quotes.AAPL?.expectedDelaySec).toBe(ALPACA_PAPER_EXPECTED_DELAY_SEC);
    expect(quotes.AAPL?.delayToleranceSec).toBe(ALPACA_PAPER_DELAY_TOLERANCE_SEC);
    expect(quotes.AAPL?.asOf).toBeTruthy();
    expect(quotes.AAPL?.fetchedAt).toBeTruthy();
  });

  it("leaves Alpaca LIVE on the SDK default feed and ordinary quote semantics", async () => {
    mockGetConnectedAccount.mockReturnValue(LIVE_ACCOUNT);
    const gateway = getAlpacaGateway("local", "ap-live");

    const quotes = await gateway.getEquityQuotes("PA1LIVEACCT", ["AAPL"]);

    expect(mockGetLatestQuotes).toHaveBeenCalledWith(expect.arrayContaining(["AAPL"]), undefined);
    expect(mockGetLatestTrades).toHaveBeenCalledWith(expect.arrayContaining(["AAPL"]), undefined);
    expect(quotes.AAPL?.price).toBe(200);
    expect(quotes.AAPL?.venuePriceAuthoritative).toBeUndefined();
    expect(quotes.AAPL?.expectedDelaySec).toBeUndefined();
  });
});
