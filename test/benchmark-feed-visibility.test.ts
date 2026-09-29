// SPY benchmark feed visibility (2026-09-25 review, "rank 9").
//
// The review's finding was that the SPY series had been frozen since Jul 24 and the card simply went
// blank, with no market-relative result anywhere (and therefore no alpha on thesis rows, which are
// stamped from the same daily-close series in src/lib/performance.ts).
//
// These tests pin the two things benchmark.ts can fix on its own:
//   1. A series that is stale against the WALL CLOCK is refused even when the account's own equity
//      window froze the same week — the case the original account-window gate cannot see, and the
//      case that renders a dead feed as a flat 0.00% "vs SPY".
//   2. Every outcome reports machine-readable feed facts (newest close, its age, its provenance,
//      whether it came off the history module's stale-cache fallback), so a consumer can say WHY the
//      card is empty instead of printing a zero.
//
// Every assertion below is on a field or export that did not exist before this work, so each test
// fails on unmodified main.
import { describe, expect, it, vi } from "vitest";
import { fetchDailyOHLC } from "../src/lib/history";
import { assessBenchmarkSeriesAge, computeSpyBenchmarkDetailed } from "../src/lib/benchmark";
import type { EquityCurvePoint } from "../src/lib/types";

vi.mock("../src/lib/history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/history")>()),
  fetchDailyOHLC: vi.fn()
}));

const mockedFetch = vi.mocked(fetchDailyOHLC);

/** Daily bars from `startDate` to `endDate` (inclusive), one per calendar day. */
function bars(startDate: string, endDate: string, extra: Record<string, unknown> = {}) {
  const out: Array<{ time: string; close: number; source?: string; fetchedAt?: string }> = [];
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  let close = 500;
  for (let t = start; t <= end; t += 86_400_000) {
    close += 0.5;
    out.push({ time: new Date(t).toISOString().slice(0, 10), close, source: "yahoo-finance", fetchedAt: "2026-09-25T12:00:00.000Z", ...extra });
  }
  return out as never;
}

const NOW = Date.parse("2026-09-25T16:00:00Z");

/** Real-snapshot curve (cash + positionsValue present — the synthetic-curve guard requires it). */
function curve(startDate: string, endDate: string): EquityCurvePoint[] {
  return [
    { timestamp: `${startDate}T16:00:00Z`, equity: 100_000, cash: 100_000, positionsValue: 0, source: "live" },
    { timestamp: `${endDate}T16:00:00Z`, equity: 101_000, cash: 101_000, positionsValue: 0, source: "live" }
  ];
}

describe("SPY benchmark — a frozen feed can never read as a flat market", () => {
  it("refuses a series that is 63 days stale when the account window froze alongside it", async () => {
    // The exact live shape: the last SPY close is 2026-07-24 AND the last portfolio snapshot is
    // 2026-07-24, so the original gate (closes vs the account window's end) saw zero lag and
    // returned a comparison in which every sub-period is 0.00%. On main this test failed with a
    // NON-null `comparison` — the fake "we exactly matched a flat SPY" result.
    mockedFetch.mockResolvedValue(bars("2026-07-01", "2026-07-24"));
    const result = await computeSpyBenchmarkDetailed(curve("2026-07-01", "2026-07-24"), "local", NOW);

    expect(result.comparison).toBeNull();
    expect(result.status).toBe("unavailable");
    expect(result.stale).toBe(true);
    expect(result.unavailable?.reason).toBe("stale-series");
    expect(result.unavailable?.lastCloseDate).toBe("2026-07-24");
    expect(result.unavailable?.staleDays).toBe(63);
    expect(result.unavailable?.stale).toBe(true);
    expect(result.feed).toMatchObject({ symbol: "SPY", lastCloseDate: "2026-07-24", staleDays: 63, stale: true });
  });

  it("names the stale-cache fallback when every live provider failed", async () => {
    // src/lib/history.ts re-stamps the frozen local EOD cache with a fresh `fetchedAt` and
    // `source = "history-cache-eod-stale"` when its whole provider cascade returns null. That
    // re-stamp is the only in-band signal that the fetch "succeeded" while the data did not, and
    // it is what a consumer needs in order to page on the feed rather than on the account.
    mockedFetch.mockResolvedValue(
      bars("2026-07-01", "2026-07-24", { source: "history-cache-eod-stale", fetchedAt: "2026-09-25T12:00:00.000Z" })
    );
    const result = await computeSpyBenchmarkDetailed(curve("2026-07-01", "2026-09-24"), "local", NOW);

    expect(result.comparison).toBeNull();
    expect(result.feed?.fellBackToStaleCache).toBe(true);
    expect(result.feed?.source).toBe("history-cache-eod-stale");
    // Fetched today, printing a July bar — the mismatch, stated as data.
    expect(result.feed?.fetchedAt).toBe("2026-09-25T12:00:00.000Z");
    expect(result.feed?.lastCloseDate).toBe("2026-07-24");
    expect(result.unavailable?.fellBackToStaleCache).toBe(true);
    expect(result.unavailable?.detail).toContain("history-cache-eod-stale");
  });
});

describe("SPY benchmark — feed facts on every outcome", () => {
  it("reports a healthy series as ok with its feed diagnostic attached", async () => {
    mockedFetch.mockResolvedValue(bars("2026-09-01", "2026-09-24"));
    const result = await computeSpyBenchmarkDetailed(curve("2026-09-01", "2026-09-24"), "local", NOW);

    expect(result.status).toBe("ok");
    expect(result.stale).toBe(false);
    expect(result.comparison).not.toBeNull();
    expect(result.feed).toMatchObject({ symbol: "SPY", lastCloseDate: "2026-09-24", staleDays: 1, stale: false, fellBackToStaleCache: false });
  });

  it("surfaces a thrown provider failure as fetch-failed rather than a silent blank", async () => {
    mockedFetch.mockRejectedValue(new Error("upstream 502"));
    const result = await computeSpyBenchmarkDetailed(curve("2026-09-01", "2026-09-24"), "local", NOW);

    expect(result.comparison).toBeNull();
    expect(result.status).toBe("unavailable");
    expect(result.stale).toBe(false);
    expect(result.unavailable?.reason).toBe("fetch-failed");
    expect(result.unavailable?.detail).toContain("upstream 502");
  });

  it("counts the bars an empty cascade returned instead of reporting a bare null", async () => {
    mockedFetch.mockResolvedValue([] as never);
    const result = await computeSpyBenchmarkDetailed(curve("2026-09-01", "2026-09-24"), "local", NOW);

    expect(result.comparison).toBeNull();
    expect(result.status).toBe("unavailable");
    expect(result.unavailable?.reason).toBe("no-bars");
    expect(result.feed).toMatchObject({ symbol: "SPY", bars: 0, stale: false });
  });
});

describe("assessBenchmarkSeriesAge — pure wall-clock gate", () => {
  it("passes a series inside the grace window and fails one past it", () => {
    const fresh = [
      { date: "2026-09-22", close: 500 },
      { date: "2026-09-24", close: 505 }
    ];
    const frozen = [
      { date: "2026-07-22", close: 500 },
      { date: "2026-07-24", close: 505 }
    ];
    expect(assessBenchmarkSeriesAge(fresh, NOW)).toBeNull();
    const verdict = assessBenchmarkSeriesAge(frozen, NOW);
    expect(verdict?.reason).toBe("stale-series");
    expect(verdict?.staleDays).toBe(63);
    expect(verdict?.stale).toBe(true);
    expect(verdict?.lastCloseDate).toBe("2026-07-24");
  });

  it("leaves a short series to the no-bars verdict instead of calling it stale", () => {
    // Fewer than two usable closes is "no-bars", a different failure with a different owner action.
    expect(assessBenchmarkSeriesAge([{ date: "2026-07-24", close: 500 }], NOW)).toBeNull();
    expect(assessBenchmarkSeriesAge([], NOW)).toBeNull();
  });
});
