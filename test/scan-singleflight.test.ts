import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING_WEIGHTS } from "../src/lib/defaults";
import {
  interactiveScanKey,
  marketScanQuotesFromAudit,
  resetScanSingleFlightForTests,
  runScanSingleFlight,
  withScanDeadline
} from "../src/lib/scan-singleflight";
import type { MarketScan } from "../src/lib/types";

function scan(generatedAt: string): MarketScan {
  return {
    source: "test",
    generatedAt,
    scannedSymbols: 0,
    returnedQuotes: 0,
    candidateLimit: 10,
    outlierReserve: 0,
    outlierCandidateCount: 0,
    topCandidates: [],
    sectorBySymbol: {},
    quotesBySymbol: {},
    cacheTtlMs: 1_000,
    cached: false,
    warnings: []
  };
}

afterEach(() => {
  resetScanSingleFlightForTests();
  vi.useRealTimers();
});

describe("interactive scan single-flight", () => {
  it("shares concurrent work for the same scan key and clears after settlement", async () => {
    let calls = 0;
    let release!: (value: MarketScan) => void;
    const deferred = new Promise<MarketScan>((resolve) => { release = resolve; });
    const factory = () => {
      calls += 1;
      return deferred;
    };

    const first = runScanSingleFlight("same", factory);
    const second = runScanSingleFlight("same", factory);
    expect(first).toBe(second);
    expect(calls).toBe(0);

    await Promise.resolve();
    expect(calls).toBe(1);
    release(scan("2026-07-15T00:00:00.000Z"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await Promise.resolve();
    const third = runScanSingleFlight("same", async () => {
      calls += 1;
      return scan("2026-07-15T00:01:00.000Z");
    });
    await expect(third).resolves.toMatchObject({ generatedAt: "2026-07-15T00:01:00.000Z" });
    expect(calls).toBe(2);
  });

  it("does not coalesce different users or policy scopes", async () => {
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return scan(String(calls));
    };
    await Promise.all([
      runScanSingleFlight("user-a", factory),
      runScanSingleFlight("user-b", factory)
    ]);
    expect(calls).toBe(2);
  });

  it("keys every input that can change ranking, filtering, or forced positions", () => {
    const base = {
      userId: "user-a",
      accountNumber: "acct-a",
      symbols: ["MSFT", "AAPL"],
      candidateLimit: 30,
      outlierReserve: 8,
      dynamicUniverses: ["sp100" as const],
      latestRunAuditId: "audit-a",
      scoringWeights: DEFAULT_SCORING_WEIGHTS,
      universeFloor: { minPrice: 2 },
      positions: [{ symbol: "AAPL", quantity: 1, averageCost: 100, marketValue: 200 }]
    };
    const key = interactiveScanKey(base);

    expect(interactiveScanKey({
      ...base,
      scoringWeights: { ...DEFAULT_SCORING_WEIGHTS, momentum: 9 }
    })).not.toBe(key);
    expect(interactiveScanKey({ ...base, universeFloor: { minPrice: 5 } })).not.toBe(key);
    expect(interactiveScanKey({
      ...base,
      positions: [{ ...base.positions[0], marketValue: 500 }]
    })).not.toBe(key);
  });

  it("aborts work when the interactive scan deadline expires", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const pending = withScanDeadline(100, (signal) => {
      observedSignal = signal;
      return new Promise<boolean>(() => undefined);
    });
    const rejection = expect(pending).rejects.toThrow("Interactive market scan deadline exceeded.");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(observedSignal?.aborted).toBe(true);
  });

  it("accepts only a full persisted strategy quote map", () => {
    const quotes = {
      FAST: { symbol: "FAST", price: 90, score: 42, peRatio: 15 }
    };
    const recent = "2026-07-15T00:00:00.000Z";
    const now = Date.parse("2026-07-15T00:00:01.000Z");
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } }, recent, now)).toBe(quotes);
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } })).toBeUndefined();
    expect(marketScanQuotesFromAudit(
      { marketScan: { quotesBySymbol: { FAST: { sym: "FAST", px: 90 } } } },
      recent,
      now
    )).toBeUndefined();
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: {} } }, recent, now)).toBeUndefined();
    expect(marketScanQuotesFromAudit(null)).toBeUndefined();
    expect(marketScanQuotesFromAudit(
      { marketScan: { quotesBySymbol: quotes } },
      "2026-07-13T00:00:00.000Z",
      Date.parse("2026-07-15T00:00:01.000Z")
    )).toBeUndefined();
  });

  // LANE A: calendar-aware seed gate. A flat 24h cutoff would reject Friday's run by Monday
  // afternoon even though nothing has traded since Friday's close — the acceptance window is
  // "back through the start of the most recent trading day" (same rule as isStaleBaseline in
  // app/console/lib/derive.ts), so Friday's audit stays a valid seed all weekend and only
  // expires once Tuesday's session starts.
  it("accepts a Friday seed on Monday but rejects it on Tuesday (calendar-aware, not a flat 24h window)", () => {
    const quotes = {
      FAST: { symbol: "FAST", price: 90, score: 42, peRatio: 15 }
    };
    // 2026-06-12 is a Friday; 2026-06-15/16 are the following Monday/Tuesday. Anchored well away
    // from local-midnight boundaries so the result doesn't depend on the runner's timezone.
    const fridayRun = "2026-06-12T16:00:00.000Z";
    const mondayMorning = Date.parse("2026-06-15T16:00:00.000Z");
    const tuesdayMorning = Date.parse("2026-06-16T16:00:00.000Z");

    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } }, fridayRun, mondayMorning)).toBe(quotes);
    expect(marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } }, fridayRun, tuesdayMorning)).toBeUndefined();
  });

  it("keeps valid seed rows when one quote in a large map is malformed", () => {
    const quotes = {
      AAPL: { symbol: "AAPL", price: 91, score: 44 },
      BAD: { symbol: "BAD", price: "x", score: 1 },
      MSFT: { symbol: "MSFT", price: 400, score: 50 }
    };
    const recent = "2026-07-15T00:00:00.000Z";
    const now = Date.parse("2026-07-15T00:00:01.000Z");
    const kept = marketScanQuotesFromAudit({ marketScan: { quotesBySymbol: quotes } }, recent, now);
    expect(kept).toEqual({
      AAPL: quotes.AAPL,
      MSFT: quotes.MSFT
    });
    expect(kept).not.toBe(quotes);
  });
});
