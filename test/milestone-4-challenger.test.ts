import { pinRagQualityFlagsOff } from "./rag-test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeUserId, retrieveContext, retryAfterMs } from "../src/lib/vector-db";
import {
  FinnhubEnrichmentProvider,
  AlphaVantageEnrichmentProvider,
  clearEnrichmentCache,
  isTransientError
} from "../src/lib/data-providers";

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const index = vi.fn(() => ({ query }));
  return {
    query,
    index,
    listIndexes: vi.fn(),
    embed: vi.fn(),
    resolveApiKey: vi.fn()
  };
});

vi.mock("@pinecone-database/pinecone", () => ({
  Pinecone: vi.fn(function Pinecone() {
    return {
      listIndexes: mocks.listIndexes,
      Index: mocks.index
    };
  })
}));

vi.mock("voyageai", () => ({
  VoyageAIClient: vi.fn(function VoyageAIClient() {
    return {
      embed: mocks.embed
    };
  })
}));

vi.mock("../src/lib/db", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveApiKeyWithSource: vi.fn((service: string) => ({ key: mocks.resolveApiKey(service), source: "env" as const })),
  hasDataPoolConsent: vi.fn(() => false),
  reserveProviderDispatch: vi.fn(() => ({
    admitted: true as const,
    attemptId: "test-provider-attempt",
    authorityId: "test"
  })),
  markProviderDispatchStarted: vi.fn(),
  settleProviderDispatch: vi.fn(),
  cancelUndispatchedProviderReservation: vi.fn(() => true),
  audit: vi.fn(),
  setInternalSetting: vi.fn(),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(() => undefined), all: vi.fn(() => []) })) }))
}));

describe("Milestone 4 Challenger: User ID Sanitization Edge Cases", () => {
  it("handles extremely long user IDs by cutting them off at 100 characters", () => {
    const longId = "a".repeat(1000);
    const result = sanitizeUserId(longId);
    expect(result).toHaveLength(100);
    expect(result).toBe("a".repeat(100));
  });

  it("sanitizes special characters and keeps only safe characters", () => {
    // Allows alphanumeric, dashes, underscores, dots, and '@'
    const specialId = "user!@#name$_-123.test@domain.com";
    const result = sanitizeUserId(specialId);
    expect(result).toBe("user@name_-123.test@domain.com");
  });

  it("neutralizes SQL injection patterns", () => {
    const sqlInjection = "admin'; DROP TABLE users; --";
    const result = sanitizeUserId(sqlInjection);
    expect(result).toBe("adminDROPTABLEusers--");
  });

  it("neutralizes script and HTML injection tags", () => {
    const scriptInjection = "<script>alert('xss')</script>";
    const result = sanitizeUserId(scriptInjection);
    expect(result).toBe("scriptalertxssscript");
  });

  it("returns 'local' when input is empty or consists purely of invalid characters", () => {
    expect(sanitizeUserId("")).toBe("local");
    expect(sanitizeUserId(undefined)).toBe("local");
    expect(sanitizeUserId("   ")).toBe("local");
    expect(sanitizeUserId("!!!###$$$%%^&*()+=  ")).toBe("local");
  });
});

describe("Milestone 4 Challenger: Pinecone Query Merging & Deduplication Correctness", () => {
  beforeEach(() => {
  pinRagQualityFlagsOff();
    vi.clearAllMocks();
    process.env.PINECONE_API_KEY = "pinecone-key";
    process.env.VOYAGE_API_KEY = "voyage-key";
    mocks.resolveApiKey.mockImplementation((service: string) => {
      if (service === "pinecone") return process.env.PINECONE_API_KEY;
      if (service === "voyage") return process.env.VOYAGE_API_KEY;
      return undefined;
    });
  });

  it("deduplicates records by ID, keeping the instance with the higher score", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    // User query returns doc-1 with score 0.7
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.7, metadata: { text: "Doc 1 User Version", userId: "user-1", scope: "private" } },
        { id: "doc-2", score: 0.5, metadata: { text: "Doc 2 User Version", userId: "user-1", scope: "private" } }
      ]
    });
    // Local query returns doc-1 with score 0.9 (higher) and doc-3 with score 0.4
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.9, metadata: { text: "Doc 1 Local/Public Version", userId: "local", scope: "shared" } },
        { id: "doc-3", score: 0.4, metadata: { text: "Doc 3 Local Version", userId: "local", scope: "shared" } }
      ]
    });

    const results = await retrieveContext("query", "AAPL", 3, "user-1");

    // The order should be doc-1 (highest score 0.9), doc-2 (0.5), doc-3 (0.4)
    expect(results).toHaveLength(3);
    expect(results[0]).toBe("Doc 1 Local/Public Version");
    expect(results[1]).toBe("Doc 2 User Version");
    expect(results[2]).toBe("Doc 3 Local Version");
  });

  it("deduplicates records by ID, keeping the user version if user score is higher", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.95, metadata: { text: "Doc 1 User Version", userId: "user-1", scope: "private" } }
      ]
    });
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.8, metadata: { text: "Doc 1 Local/Public Version", userId: "local", scope: "shared" } }
      ]
    });

    const results = await retrieveContext("query", "AAPL", 2, "user-1");
    expect(results).toEqual(["Doc 1 User Version"]);
  });

  it("handles missing scores by sorting them as 0", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: undefined, metadata: { text: "Doc 1 User Version", userId: "user-1", scope: "private" } },
        { id: "doc-2", score: 0.5, metadata: { text: "Doc 2 User Version", userId: "user-1", scope: "private" } }
      ]
    });
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-3", score: 0.2, metadata: { text: "Doc 3 Local Version", userId: "local", scope: "shared" } }
      ]
    });

    const results = await retrieveContext("query", "AAPL", 3, "user-1");
    // Sorted order by score: doc-2 (0.5), doc-3 (0.2), doc-1 (undefined -> 0)
    expect(results).toEqual([
      "Doc 2 User Version",
      "Doc 3 Local Version",
      "Doc 1 User Version"
    ]);
  });

  it("slices output to match limit constraint", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.9, metadata: { text: "Doc 1", userId: "user-1", scope: "private" } },
        { id: "doc-2", score: 0.8, metadata: { text: "Doc 2", userId: "user-1", scope: "private" } }
      ]
    });
    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-3", score: 0.7, metadata: { text: "Doc 3", userId: "local", scope: "shared" } }
      ]
    });

    const results = await retrieveContext("query", "AAPL", 1, "user-1");
    expect(results).toEqual(["Doc 1"]);
  });

  it("skips records without metadata.text", async () => {
    mocks.listIndexes.mockResolvedValue({ indexes: [{ name: "socratic-trade" }] });
    mocks.embed.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    mocks.query.mockResolvedValueOnce({
      matches: [
        { id: "doc-1", score: 0.9, metadata: { userId: "user-1", scope: "private" } },
        { id: "doc-2", score: 0.8, metadata: { text: "Doc 2", userId: "user-1", scope: "private" } }
      ]
    });
    mocks.query.mockResolvedValueOnce({
      matches: []
    });

    const results = await retrieveContext("query", "AAPL", 2, "user-1");
    expect(results).toEqual(["Doc 2"]);
  });
});

describe("Milestone 4 Challenger: Voyage API Jitter Distribution Analysis", () => {
  it("verifies the exponential backoff & full jitter distribution over 100 runs", () => {
    // Set default base and batch delays
    process.env.VECTOR_EMBED_RETRY_DELAY_MS = "20000";
    process.env.VECTOR_EMBED_BATCH_DELAY_MS = "21000";

    const error = new Error("Voyage API Rate Limit 429");
    const sampleSize = 100;

    // Run for attempt 0
    const attempt0Delays: number[] = [];
    for (let i = 0; i < sampleSize; i++) {
      attempt0Delays.push(retryAfterMs(error, 0));
    }

    // Check attempt 0 distribution
    // For attempt = 0, backoff = min(60s, 20s * 2^0) = 20s = 20,000ms.
    // delay = random * 20,000ms => always <= 20,000ms.
    // Max of (batchDelay (21,000), delay (<= 20,000)) is ALWAYS 21,000ms.
    const allAttempt0AreBatchDelay = attempt0Delays.every(d => d === 21000);
    expect(allAttempt0AreBatchDelay).toBe(true);

    // Run for attempt 1
    const attempt1Delays: number[] = [];
    for (let i = 0; i < sampleSize; i++) {
      attempt1Delays.push(retryAfterMs(error, 1));
    }

    // Check attempt 1 distribution
    // For attempt = 1, backoff = min(60s, 20s * 2^1) = 40s = 40,000ms.
    // delay = random * 40,000ms.
    // If delay < 21,000, returns 21,000. Else returns delay.
    // Mathematically, the probability of returning 21,000 is 21/40 = 52.5%.
    const attempt1ClampedCount = attempt1Delays.filter(d => d === 21000).length;
    const attempt1NotClamped = attempt1Delays.filter(d => d > 21000);

    // Verify statistical range
    expect(attempt1ClampedCount).toBeGreaterThan(30); // Expect ~52, check within wide safe bound
    expect(attempt1ClampedCount).toBeLessThan(75);
    expect(attempt1NotClamped.length).toBeGreaterThan(25);
    
    // Check that all non-clamped delays are between 21,000 and 40,000 ms
    attempt1NotClamped.forEach(d => {
      expect(d).toBeGreaterThan(21000);
      expect(d).toBeLessThanOrEqual(40000);
    });

    // Run for attempt 2
    const attempt2Delays: number[] = [];
    for (let i = 0; i < sampleSize; i++) {
      attempt2Delays.push(retryAfterMs(error, 2));
    }

    // Check attempt 2 distribution
    // For attempt = 2, backoff = min(60s, 20s * 2^2) = 60s = 60,000ms.
    // delay = random * 60,000ms.
    // If delay < 21,000, returns 21,000. Else returns delay.
    // Probability of returning 21,000 is 21/60 = 35%.
    const attempt2ClampedCount = attempt2Delays.filter(d => d === 21000).length;
    const attempt2NotClamped = attempt2Delays.filter(d => d > 21000);

    expect(attempt2ClampedCount).toBeGreaterThan(15); // Expect ~35, check within wide safe bound
    expect(attempt2ClampedCount).toBeLessThan(55);
    expect(attempt2NotClamped.length).toBeGreaterThan(45);

    attempt2NotClamped.forEach(d => {
      expect(d).toBeGreaterThan(21000);
      expect(d).toBeLessThanOrEqual(60000);
    });
  });
});

describe("Milestone 4 Challenger: Finnhub Cache Poisoning Protection", () => {
  beforeEach(() => {
    clearEnrichmentCache();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("prevents cache writes on Finnhub when a transient error occurs in at least one promise", async () => {
    let callIndex = 0;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      callIndex++;
      // Return transient error on the 3rd request (e.g. analyst recs)
      if (url.includes("recommendation")) {
        return new Response("Rate limit", { status: 429 });
      }
      // Sector/Profile
      if (url.includes("profile2")) {
        return new Response(JSON.stringify({ name: "Apple Inc.", finnhubIndustry: "Technology" }));
      }
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new FinnhubEnrichmentProvider("test-key");
    // coveredFields hint suppresses the /calendar/earnings daysToEarnings fallback (added
    // 2026-08-02) so it doesn't perturb the exact fetch counts this test asserts on.
    const skipCalendar = { coveredFields: { AAPL: new Set(["daysToEarnings"]) } };
    const res1 = await provider.enrich(["AAPL"], skipCalendar);

    // We expect some fields to still map (like companyName/sector from the succeeded profile2 call)
    expect(res1.AAPL).toEqual({ companyName: "Apple Inc.", sector: "Technology", industry: "Technology" });
    // Verify that the fetch happened 6 times (5 calls plus 1 retry on HTTP 429 on recommendation)
    expect(mockFetch).toHaveBeenCalledTimes(6);

    // Call it a second time. If it was NOT cached, it should call fetch 6 more times.
    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({ companyName: "Apple Inc.", sector: "Technology", industry: "Technology" });
    expect(mockFetch).toHaveBeenCalledTimes(12); // Cache was bypassed!
  });

  it("caches normally on Finnhub when all queries are successful or have non-transient errors", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("recommendation")) {
        // Return a non-transient 404 (e.g. recommendation mean not found for this symbol)
        return new Response("Not Found", { status: 404 });
      }
      if (url.includes("profile2")) {
        return new Response(JSON.stringify({ name: "Apple Inc.", finnhubIndustry: "Technology" }));
      }
      return new Response(JSON.stringify({}));
    });
    vi.stubGlobal("fetch", mockFetch);

    const provider = new FinnhubEnrichmentProvider("test-key");
    // coveredFields hint suppresses the /calendar/earnings daysToEarnings fallback (added
    // 2026-08-02) so it doesn't perturb the exact fetch counts this test asserts on.
    const skipCalendar = { coveredFields: { AAPL: new Set(["daysToEarnings"]) } };
    const res1 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res1.AAPL).toEqual({ companyName: "Apple Inc.", sector: "Technology", industry: "Technology" });
    expect(mockFetch).toHaveBeenCalledTimes(5);

    // Call second time. It should be cached, so fetch count remains 5.
    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({ companyName: "Apple Inc.", sector: "Technology", industry: "Technology" });
    expect(mockFetch).toHaveBeenCalledTimes(5); // Cache worked!
  });
});

describe("Milestone 4 Challenger: Alpha Vantage Warning Detection & Cache Bypass", () => {
  beforeEach(() => {
    clearEnrichmentCache();
  });

  // Every enrich() call below passes a coveredFields hint marking daysToEarnings already
  // covered upstream — these tests are specifically about the NEWS_SENTIMENT warning/cache-bypass
  // contract, not the EARNINGS_CALENDAR fallback (2026-08-02, separately covered in
  // test/data-providers.test.ts's "EARNINGS_CALENDAR fallback" describe block), so this keeps
  // that fallback's own fetch from firing and perturbing the exact mockFetch call counts here.
  const skipCalendar = { coveredFields: { AAPL: new Set(["daysToEarnings"]) } };

  it("throws error and bypasses cache when Alpha Vantage returns Note warning", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Note: "Thank you for using Alpha Vantage! Standard rate limit is 5 requests per minute..."
    })));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res1.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(2); // Cache was bypassed!
  });

  it("throws error and bypasses cache when Alpha Vantage returns Information warning", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Information: "Standard rate limit exceeded..."
    })));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res1.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(2); // Cache was bypassed!
  });

  it("throws error and bypasses cache when Alpha Vantage returns Error Message", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      "Error Message": "Invalid API key"
    })));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res1.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(2); // Cache was bypassed!
  });

  it("caches normally when response does not contain warnings", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      feed: [
        {
          title: "Great AAPL news",
          ticker_sentiment: [{ ticker: "AAPL", ticker_sentiment_score: "0.3" }]
        }
      ]
    })));
    vi.stubGlobal("fetch", mockFetch);

    const provider = new AlphaVantageEnrichmentProvider("test-key");
    const res1 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res1.AAPL).toEqual({ headlines: ["Great AAPL news"], sentiment: 80 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const res2 = await provider.enrich(["AAPL"], skipCalendar);
    expect(res2.AAPL).toEqual({ headlines: ["Great AAPL news"], sentiment: 80 });
    expect(mockFetch).toHaveBeenCalledTimes(1); // Cached!
  });
});
