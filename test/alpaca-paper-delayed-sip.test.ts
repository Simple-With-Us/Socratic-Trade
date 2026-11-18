/**
 * Alpaca PAPER account-scoped `delayed_sip` tape.
 *
 * Owner authorization (2026-11-05): the connected Alpaca PAPER account
 * (`broker=alpaca`, `environment=paper`) trades against Alpaca's `delayed_sip`
 * feed — expected ~900s publication delay.  These tests pin:
 *
 *  - the account-scoped decision (never a global env flip),
 *  - expected-900 is NOT staleness, but EXCESS lag beyond 900 + tolerance IS,
 *  - fresh retrieval is required independently of the tape delay,
 *  - no realtime overlay for symbols the delayed tape priced,
 *  - a symbol the delayed tape did not price may use another source,
 *  - live Alpaca / Tradier / everything else is unchanged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALPACA_PAPER_DELAY_TOLERANCE_SEC,
  ALPACA_PAPER_DELAYED_FEED,
  ALPACA_PAPER_EXPECTED_DELAY_SEC,
  alpacaPaperFeedForAccount,
  alpacaSnapshotCacheIdentity,
  delayedTapeStatus,
  isAlpacaPaperAccount
} from "../src/lib/alpaca-paper-quotes";
import {
  fetchFreshQuotesCascade,
  isQuoteFresh,
  quoteAgeSecForStalenessGate,
  resolveVenueQuoteMode
} from "../src/lib/quotes-cascade";
import type { BrokerQuote } from "../src/lib/types";

// ── Mocks (same surface as test/quotes-cascade.test.ts) ──────────────────────
const mockGetPolicy = vi.fn();
const mockResolveAlpacaMarketData = vi.fn();
const mockResolveApiKeyWithSource = vi.fn();
const mockGetConnectedAccount = vi.fn();
const mockGetActiveConnectedAccount = vi.fn();
vi.mock("../src/lib/db", () => ({
  getPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  resolveAlpacaMarketData: () => mockResolveAlpacaMarketData(),
  resolveApiKeyWithSource: (...args: unknown[]) => mockResolveApiKeyWithSource(...args),
  getConnectedAccount: (...args: unknown[]) => mockGetConnectedAccount(...args),
  getActiveConnectedAccount: (...args: unknown[]) => mockGetActiveConnectedAccount(...args),
  listConnectedAccounts: () => []
}));

const mockGetEquityQuotes = vi.fn();
vi.mock("../src/lib/broker", () => ({
  getBrokerGateway: () => ({
    getEquityQuotes: mockGetEquityQuotes
  })
}));

const mockEnrich = vi.fn();
const mockFetchWithRetry = vi.fn();
vi.mock("../src/lib/data-providers", () => ({
  AlpacaSnapshotEnrichmentProvider: class {
    enrich(symbols: string[]) {
      return mockEnrich(symbols);
    }
  },
  fetchWithRetry: (...args: unknown[]) => mockFetchWithRetry(...args),
  // Fixed SYNTHETIC fingerprint — never echo the credential it fingerprints.
  apiKeyFingerprint: async () => "fp:test"
}));

const mockUpsertSymbolFieldLatest = vi.fn();
vi.mock("../src/lib/db-fundamentals", () => ({
  upsertSymbolFieldLatest: (...args: unknown[]) => mockUpsertSymbolFieldLatest(...args)
}));

const mockFetchYahooFinanceQuote = vi.fn();
const mockFetchYahooFinanceQuotesBatch = vi.fn();
vi.mock("../src/lib/yahoo-finance", () => ({
  fetchYahooFinanceQuote: (sym: string) => mockFetchYahooFinanceQuote(sym),
  fetchYahooFinanceQuotesBatch: (syms: string[]) => mockFetchYahooFinanceQuotesBatch(syms)
}));

const NOW = Date.parse("2026-11-05T20:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

/** A quote from the Alpaca PAPER `delayed_sip` tape: ~900s old print, fetched now. */
function delayedPaperQuote(overrides: Partial<BrokerQuote> = {}): BrokerQuote {
  return {
    symbol: "AAPL",
    price: 200,
    bid: 199.9,
    ask: 200.1,
    prevClose: 198,
    open: 199,
    high: 201,
    low: 198.5,
    asOf: iso(NOW - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000),
    provider: "alpaca",
    fetchedAt: iso(NOW),
    venuePriceAuthoritative: true,
    expectedDelaySec: ALPACA_PAPER_EXPECTED_DELAY_SEC,
    delayToleranceSec: ALPACA_PAPER_DELAY_TOLERANCE_SEC,
    ...overrides
  };
}

/**
 * The same tape anchored to the REAL clock.
 *
 * The cascade reads `Date.now()` itself, so a quote stamped at a fixed past
 * instant would look years old to the delayed-tape usability check.
 */
function liveDelayedPaperQuote(overrides: Partial<BrokerQuote> = {}): BrokerQuote {
  const now = Date.now();
  return delayedPaperQuote({
    asOf: new Date(now - ALPACA_PAPER_EXPECTED_DELAY_SEC * 1000).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    ...overrides
  });
}

describe("alpaca paper account scoping", () => {
  it("treats ONLY the connected Alpaca paper account as the delayed tape", () => {
    expect(isAlpacaPaperAccount({ broker: "alpaca", environment: "paper" })).toBe(true);
    expect(isAlpacaPaperAccount({ broker: "alpaca", environment: "live" })).toBe(false);
    expect(isAlpacaPaperAccount({ broker: "tradier", environment: "paper" })).toBe(false);
    expect(isAlpacaPaperAccount({ broker: "robinhood", environment: "paper" })).toBe(false);
    // The MCP transport is a different data path and was not authorized.
    expect(isAlpacaPaperAccount({ broker: "alpaca-mcp", environment: "paper" })).toBe(false);
    expect(isAlpacaPaperAccount(undefined)).toBe(false);
  });

  it("resolves delayed_sip for the paper account and no override for anyone else", () => {
    expect(alpacaPaperFeedForAccount({ broker: "alpaca", environment: "paper" })).toBe("delayed_sip");
    expect(ALPACA_PAPER_DELAYED_FEED).toBe("delayed_sip");
    expect(alpacaPaperFeedForAccount({ broker: "alpaca", environment: "live" })).toBeUndefined();
    expect(alpacaPaperFeedForAccount({ broker: "tradier", environment: "paper" })).toBeUndefined();
  });

  it("folds account + feed identity into the snapshot cache identity", () => {
    expect(alpacaSnapshotCacheIdentity("ap-paper", "delayed_sip")).toBe("ap-paper:delayed_sip");
    expect(alpacaSnapshotCacheIdentity("ap-live", "delayed_sip")).not.toBe(
      alpacaSnapshotCacheIdentity("ap-paper", "delayed_sip")
    );
    // No feed override → no identity → the default (unchanged) cache key is kept.
    expect(alpacaSnapshotCacheIdentity("ap-live", undefined)).toBeUndefined();
  });
});

describe("delayed tape status (expected ~900s delay)", () => {
  const maxFetchAgeMs = 120_000;

  it("treats the expected ~900s print age as NORMAL, not stale", () => {
    const status = delayedTapeStatus(delayedPaperQuote(), NOW, maxFetchAgeMs);
    expect(status.delayed).toBe(true);
    expect(status.asOfAgeSec).toBe(ALPACA_PAPER_EXPECTED_DELAY_SEC);
    expect(status.excessDelaySec).toBe(0);
    expect(status.retrievalFresh).toBe(true);
    expect(status.usable).toBe(true);
  });

  it("tolerates a couple of seconds of jitter around the expected delay", () => {
    const status = delayedTapeStatus(delayedPaperQuote({ asOf: iso(NOW - 902_000) }), NOW, maxFetchAgeMs);
    expect(status.asOfAgeSec).toBe(902);
    expect(status.excessDelaySec).toBe(0);
    expect(status.usable).toBe(true);
  });

  it("flags EXCESS delay beyond expected + tolerance", () => {
    const excessSec = 400;
    const status = delayedTapeStatus(
      delayedPaperQuote({ asOf: iso(NOW - (ALPACA_PAPER_EXPECTED_DELAY_SEC + ALPACA_PAPER_DELAY_TOLERANCE_SEC + excessSec) * 1000) }),
      NOW,
      maxFetchAgeMs
    );
    expect(status.excessDelaySec).toBe(excessSec);
    expect(status.usable).toBe(false);
  });

  it("requires a FRESH retrieval independently of the tape delay", () => {
    // Fresh print, but the snapshot itself was pulled 10 minutes ago.
    const status = delayedTapeStatus(
      delayedPaperQuote({ asOf: iso(NOW - 2_000), fetchedAt: iso(NOW - 600_000) }),
      NOW,
      maxFetchAgeMs
    );
    expect(status.retrievalFresh).toBe(false);
    expect(status.excessDelaySec).toBe(0);
    expect(status.usable).toBe(false);
  });

  it("never treats a missing observation as usable", () => {
    const status = delayedTapeStatus(delayedPaperQuote({ asOf: undefined }), NOW, maxFetchAgeMs);
    expect(status.asOfAgeSec).toBeUndefined();
    expect(status.usable).toBe(false);
  });

  it("never treats a missing retrieval stamp as usable", () => {
    const status = delayedTapeStatus(delayedPaperQuote({ fetchedAt: undefined }), NOW, maxFetchAgeMs);
    expect(status.retrievalFresh).toBe(false);
    expect(status.fetchAgeSec).toBeUndefined();
    expect(status.usable).toBe(false);
  });

  it("fails CLOSED on a FUTURE observation stamp (bad data, not a fresh print)", () => {
    // A print stamped ahead of the wall clock cannot be aged into a positive
    // age.  It used to clamp to age 0 and read as a healthy 900s tape.
    const status = delayedTapeStatus(delayedPaperQuote({ asOf: iso(NOW + 60_000) }), NOW, maxFetchAgeMs);
    expect(status.asOfAgeSec).toBeUndefined();
    expect(status.excessDelaySec).toBeUndefined();
    expect(status.usable).toBe(false);
  });

  it("fails CLOSED on a FUTURE retrieval stamp (not a fresh retrieval)", () => {
    const status = delayedTapeStatus(delayedPaperQuote({ fetchedAt: iso(NOW + 60_000) }), NOW, maxFetchAgeMs);
    expect(status.retrievalFresh).toBe(false);
    expect(status.fetchAgeSec).toBeUndefined();
    expect(status.usable).toBe(false);
  });

  it("rejects a stale post-session print instead of accepting stale session data", () => {
    // Overnight / last-session prints arrive with a fresh fetch but an asOf age
    // far beyond the documented 900s window.  There is NO carve-out that
    // accepts stale session data as a healthy delayed tape.  (With the market
    // OPEN this is excess delay; with the market CLOSED it is an expected
    // print that is still not tradable — see the closed-session cases below.)
    const status = delayedTapeStatus(
      delayedPaperQuote({ asOf: iso(NOW - 4 * 60 * 60_000) }),
      NOW,
      maxFetchAgeMs
    );
    expect(status.retrievalFresh).toBe(true);
    expect(status.excessDelaySec).toBeGreaterThan(0);
    expect(status.usable).toBe(false);
  });

  it("OPEN market: a print beyond expected + tolerance is excess delay and is not usable", () => {
    const status = delayedTapeStatus(
      delayedPaperQuote({ asOf: iso(NOW - 4 * 60 * 60_000) }),
      NOW,
      maxFetchAgeMs,
      true
    );
    expect(status.marketSessionOpen).toBe(true);
    expect(status.excessDelaySec).toBeGreaterThan(0);
    expect(status.usable).toBe(false);
  });

  it("CLOSED market: an old print is NOT excess delay (no prints while the market is shut) and is still not usable", () => {
    // Honest split: with the market shut there are no prints at all, so the old
    // asOf is expected — it is NOT evidence of a broken feed.  The tape is still
    // not tradable, so `usable` stays false and no excess is reported.
    const status = delayedTapeStatus(
      delayedPaperQuote({ asOf: iso(NOW - 4 * 60 * 60_000) }),
      NOW,
      maxFetchAgeMs,
      false
    );
    expect(status.marketSessionOpen).toBe(false);
    expect(status.excessDelaySec).toBeUndefined();
    expect(status.retrievalFresh).toBe(true);
    expect(status.usable).toBe(false);
  });
});

describe("isQuoteFresh on a delayed tape", () => {
  it("accepts the expected ~900s delayed print with a fresh fetch", () => {
    expect(isQuoteFresh(delayedPaperQuote(), NOW, 120_000)).toBe(true);
  });

  it("rejects an EXCESSIVELY delayed print even though the fetch is fresh", () => {
    const quote = delayedPaperQuote({
      asOf: iso(NOW - (ALPACA_PAPER_EXPECTED_DELAY_SEC + ALPACA_PAPER_DELAY_TOLERANCE_SEC + 60) * 1000)
    });
    expect(isQuoteFresh(quote, NOW, 120_000)).toBe(false);
  });

  it("rejects a delayed print whose retrieval is stale", () => {
    const quote = delayedPaperQuote({ fetchedAt: iso(NOW - 600_000) });
    expect(isQuoteFresh(quote, NOW, 120_000)).toBe(false);
  });

  it("rejects a delayed print whose observation stamp is in the future", () => {
    expect(isQuoteFresh(delayedPaperQuote({ asOf: iso(NOW + 60_000) }), NOW, 120_000)).toBe(false);
  });

  it("rejects a delayed snapshot whose retrieval stamp is in the future", () => {
    expect(isQuoteFresh(delayedPaperQuote({ fetchedAt: iso(NOW + 60_000) }), NOW, 120_000)).toBe(false);
  });

  it("leaves non-delayed (real-time) quotes on the old behavior", () => {
    const realtime = {
      symbol: "AAPL",
      price: 200,
      asOf: iso(NOW - 5_000),
      fetchedAt: iso(NOW),
      provider: "alpaca"
    };
    expect(isQuoteFresh(realtime, NOW, 120_000)).toBe(true);
    expect(isQuoteFresh({ ...realtime, asOf: iso(NOW - 300_000) }, NOW, 120_000)).toBe(false);
  });
});

describe("quoteAgeSecForStalenessGate on a delayed tape", () => {
  it("ages the venue-delayed snapshot by fetchedAt (expected-900 is not stale)", () => {
    const result = quoteAgeSecForStalenessGate(delayedPaperQuote({ fetchedAt: iso(NOW - 10_000) }), NOW);
    expect(result.missing).toBe(false);
    expect(result.venueDelayed).toBe(true);
    expect(result.ageSec).toBe(10);
    expect(result.excessDelaySec).toBe(0);
    expect(result.expectedDelayedTape).toBe(true);
  });

  it("reports the excess delay independently of the age stamp", () => {
    const result = quoteAgeSecForStalenessGate(
      delayedPaperQuote({ asOf: iso(NOW - 1_500_000), fetchedAt: iso(NOW - 5_000) }),
      NOW
    );
    expect(result.ageSec).toBe(5);
    expect(result.excessDelaySec).toBe(1_500_000 / 1000 - (ALPACA_PAPER_EXPECTED_DELAY_SEC + ALPACA_PAPER_DELAY_TOLERANCE_SEC));
  });

  it("does not add delayed-tape fields to real-time quotes", () => {
    const result = quoteAgeSecForStalenessGate(
      { asOf: iso(NOW - 5_000), fetchedAt: iso(NOW), provider: "alpaca" },
      NOW
    );
    expect(result.expectedDelayedTape).toBeUndefined();
    expect(result.excessDelaySec).toBeUndefined();
  });

  it("fails CLOSED on a future stamp instead of handing the gate a negative age", () => {
    const futureFetch = quoteAgeSecForStalenessGate(
      delayedPaperQuote({ fetchedAt: iso(NOW + 60_000) }),
      NOW
    );
    expect(futureFetch.missing).toBe(true);
    expect(futureFetch.ageSec).toBeUndefined();

    const futureObservation = quoteAgeSecForStalenessGate(
      delayedPaperQuote({ asOf: iso(NOW + 60_000) }),
      NOW
    );
    expect(futureObservation.missing).toBe(true);
    expect(futureObservation.ageSec).toBeUndefined();
  });

  it("flags a stale post-session print as excess delay while the market is open", () => {
    const result = quoteAgeSecForStalenessGate(
      delayedPaperQuote({ asOf: iso(NOW - 4 * 60 * 60_000), fetchedAt: iso(NOW - 5_000) }),
      NOW
    );
    expect(result.excessDelaySec).toBeGreaterThan(0);
  });
});

describe("resolveVenueQuoteMode — account isolation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns venue_delayed for the connected Alpaca PAPER account", () => {
    mockGetConnectedAccount.mockReturnValue({ id: "ap-paper", broker: "alpaca", environment: "paper" });
    expect(resolveVenueQuoteMode({ activeBroker: "alpaca", connectedAccountId: "ap-paper" }, "local")).toBe(
      "venue_delayed"
    );
  });

  it("leaves Alpaca LIVE on the realtime tape", () => {
    mockGetConnectedAccount.mockReturnValue({ id: "ap-live", broker: "alpaca", environment: "live" });
    expect(resolveVenueQuoteMode({ activeBroker: "alpaca", connectedAccountId: "ap-live" }, "local")).toBe(
      "realtime"
    );
  });

  it("leaves Tradier paper/live and every other broker unchanged", () => {
    mockGetConnectedAccount.mockReturnValue({ id: "tr", broker: "tradier", environment: "paper" });
    expect(resolveVenueQuoteMode({ activeBroker: "tradier", connectedAccountId: "tr" }, "local")).toBe("venue_delayed");
    mockGetConnectedAccount.mockReturnValue({ id: "tr", broker: "tradier", environment: "live" });
    expect(resolveVenueQuoteMode({ activeBroker: "tradier", connectedAccountId: "tr" }, "local")).toBe("venue_locked");
    mockGetConnectedAccount.mockReturnValue({ id: "rh", broker: "robinhood", environment: "paper" });
    expect(resolveVenueQuoteMode({ activeBroker: "robinhood", connectedAccountId: "rh" }, "local")).toBe("realtime");
  });
});

describe("fetchFreshQuotesCascade — Alpaca PAPER tape", () => {
  beforeAll(() => {
    vi.stubEnv("TEST_ALLOW_CASCADE_EXTERNAL", "1");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveConnectedAccount.mockReturnValue(undefined);
    mockResolveAlpacaMarketData.mockReturnValue({ apiKey: undefined, secretKey: undefined, source: "env" });
    mockResolveApiKeyWithSource.mockReturnValue({ key: undefined, source: "env" });
  });

  it("keeps the delayed broker quote and NEVER overlays a realtime price", async () => {
    mockGetConnectedAccount.mockReturnValue({ id: "ap-paper", broker: "alpaca", environment: "paper" });
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      connectedAccountId: "ap-paper",
      accountNumber: "PA33IDTHMFK9",
      maxQuoteAgeSec: 120
    });
    mockGetEquityQuotes.mockResolvedValue({ AAPL: liveDelayedPaperQuote() });
    mockEnrich.mockResolvedValue({});
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(new Map());

    const quotes = await fetchFreshQuotesCascade(["AAPL"], "local", "PA33IDTHMFK9");

    expect(quotes.AAPL.price).toBe(200);
    expect(quotes.AAPL.venuePriceAuthoritative).toBe(true);
    expect(quotes.AAPL.expectedDelaySec).toBe(ALPACA_PAPER_EXPECTED_DELAY_SEC);
    // No realtime source may replace the venue tape.
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).not.toHaveBeenCalled();
  });

  it("uses another source when the delayed feed prices nothing", async () => {
    mockGetConnectedAccount.mockReturnValue({ id: "ap-paper", broker: "alpaca", environment: "paper" });
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      connectedAccountId: "ap-paper",
      accountNumber: "PA33IDTHMFK9",
      maxQuoteAgeSec: 120
    });
    mockResolveAlpacaMarketData.mockReturnValue({ apiKey: "k", secretKey: "s", source: "env" });
    mockGetEquityQuotes.mockResolvedValue({});
    mockEnrich.mockResolvedValue({ AAPL: { price: 999 } });
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(new Map());

    const quotes = await fetchFreshQuotesCascade(["AAPL"], "local", "PA33IDTHMFK9");

    // Alpaca priced nothing, so the later level is allowed.  It is not labeled
    // as the delayed paper tape.
    expect(mockEnrich).toHaveBeenCalled();
    expect(quotes.AAPL?.price).toBe(999);
    expect(quotes.AAPL?.priceDelayLabel).toBeUndefined();
    expect(quotes.AAPL?.expectedDelaySec).toBeUndefined();
  });

  it("does NOT accept an UNUSABLE delayed tape as the authoritative venue price", async () => {
    // The print runs beyond expected delay + tolerance while the retrieval is
    // fresh.  The cascade must refuse to stamp it as the venue-authoritative
    // price — and it must NOT overlay a realtime source on top of it.
    mockGetConnectedAccount.mockReturnValue({ id: "ap-paper", broker: "alpaca", environment: "paper" });
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      connectedAccountId: "ap-paper",
      accountNumber: "PA33IDTHMFK9",
      maxQuoteAgeSec: 120
    });
    const now = Date.now();
    mockGetEquityQuotes.mockResolvedValue({
      AAPL: liveDelayedPaperQuote({
        asOf: new Date(
          now - (ALPACA_PAPER_EXPECTED_DELAY_SEC + ALPACA_PAPER_DELAY_TOLERANCE_SEC + 300) * 1000
        ).toISOString()
      })
    });
    mockEnrich.mockResolvedValue({ AAPL: { price: 999 } });
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(new Map());

    const quotes = await fetchFreshQuotesCascade(["AAPL"], "local", "PA33IDTHMFK9");

    // Not authoritative — the staleness gate owns the honest
    // `quote_last_print_beyond_delayed_sla` block.
    expect(quotes.AAPL?.venuePriceAuthoritative).not.toBe(true);
    // The tape metadata survives so the gate can report the excess delay.
    expect(quotes.AAPL?.expectedDelaySec).toBe(ALPACA_PAPER_EXPECTED_DELAY_SEC);
    // No realtime overlay may fill the gap on the execution path.
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).not.toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuote).not.toHaveBeenCalled();
  });

  it("leaves Alpaca LIVE on the realtime cascade (external backfill still runs)", async () => {
    mockGetConnectedAccount.mockReturnValue({ id: "ap-live", broker: "alpaca", environment: "live" });
    mockGetPolicy.mockReturnValue({
      activeBroker: "alpaca",
      connectedAccountId: "ap-live",
      accountNumber: "PA1LIVEACCT",
      maxQuoteAgeSec: 120
    });
    // A stale last print on a real-time venue: the cascade must keep going.
    mockGetEquityQuotes.mockResolvedValue({
      AAPL: { symbol: "AAPL", price: 200, asOf: iso(NOW - 900_000), provider: "alpaca", fetchedAt: iso(NOW) }
    });
    mockResolveAlpacaMarketData.mockReturnValue({ apiKey: "k", secretKey: "s", source: "env" });
    mockEnrich.mockResolvedValue({});
    mockFetchYahooFinanceQuotesBatch.mockResolvedValue(new Map());

    const quotes = await fetchFreshQuotesCascade(["AAPL"], "local", "PA1LIVEACCT");

    expect(mockEnrich).toHaveBeenCalled();
    expect(mockFetchYahooFinanceQuotesBatch).toHaveBeenCalled();
    expect(quotes.AAPL).toBeDefined();
    expect(quotes.AAPL.venuePriceAuthoritative).toBeUndefined();
  });
});
