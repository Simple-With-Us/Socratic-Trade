// Tests for the §6 slice-3 follow-up — time-bounded (PIT) proposal evidence:
// computeOosEvidenceCutoff fold math and the closedBefore scorecard filter.
// Temp-SQLite pattern (per-run DB under the vitest-managed tmpdir).

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-pit-${randomUUID()}.db`)}`;
});

/** The 20 business days of June 2026 (Mon 06-01 .. Fri 06-26). */
const JUNE_BUSINESS_DATES = [
  "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05",
  "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12",
  "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19",
  "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"
];

async function seedSnapshots(userId: string, dates: string[]): Promise<void> {
  const { audit } = await import("../src/lib/db");
  for (const date of dates) {
    audit("signal_snapshot", {
      runId: `run-${date}`,
      asOf: `${date}T15:00:00Z`, // 11:00 ET — same market day
      signals: [{ symbol: "AAPL", refPrice: 100, factorBreakdown: { momentum: 50 } }]
    }, userId);
  }
}

describe("computeOosEvidenceCutoff", () => {
  it("returns the first surviving held-out date (fold math mirrors runWalkForwardOOS defaults)", async () => {
    const { computeOosEvidenceCutoff } = await import("../src/lib/backtest");
    const userId = `pit-fold-${randomUUID()}`;
    await seedSnapshots(userId, JUNE_BUSINESS_DATES);
    // 20 dates, trainFraction 0.7 → cutIdx 14; embargo 5 → testCutIdx 19 → cutoff = dates[19].
    const cutoff = computeOosEvidenceCutoff(userId, { now: Date.parse("2026-08-01T15:00:00Z") });
    expect(cutoff).toBeDefined();
    expect(cutoff!.cutoffDate).toBe("2026-06-26");
    expect(cutoff!.trainEndDate).toBe("2026-06-18"); // dates[13]
    expect(cutoff!.totalDates).toBe(20);
  });

  it("excludes unmatured dates whose forward window has not elapsed", async () => {
    const { computeOosEvidenceCutoff } = await import("../src/lib/backtest");
    const userId = `pit-unmatured-${randomUUID()}`;
    // 20 June dates + 3 dates inside the horizon window before "now" (2026-07-01). The 3 late-June
    // tail dates are ALSO unmatured as of 2026-07-01 (06-25's 5-business-day target is 07-02), so the
    // matured set is 06-01..06-24 = 18 dates: cutIdx 12, testCutIdx 17 → cutoff = dates[17] = 06-24.
    await seedSnapshots(userId, [...JUNE_BUSINESS_DATES, "2026-06-29", "2026-06-30", "2026-07-01"]);
    const cutoff = computeOosEvidenceCutoff(userId, { now: Date.parse("2026-07-01T15:00:00Z") });
    expect(cutoff).toBeDefined();
    expect(cutoff!.totalDates).toBe(18);
    expect(cutoff!.cutoffDate).toBe("2026-06-24");
    expect(cutoff!.trainEndDate).toBe("2026-06-16"); // dates[11]
  });

  it("returns undefined with too few dates, and when the embargo swallows the tail", async () => {
    const { computeOosEvidenceCutoff } = await import("../src/lib/backtest");
    const fewUser = `pit-few-${randomUUID()}`;
    await seedSnapshots(fewUser, JUNE_BUSINESS_DATES.slice(0, 3));
    expect(computeOosEvidenceCutoff(fewUser, { now: Date.parse("2026-08-01T15:00:00Z") })).toBeUndefined();

    const tailUser = `pit-tail-${randomUUID()}`;
    // 10 dates → cutIdx 7, testCutIdx = min(7+5, 10) = 10 ≥ 10 → no surviving test fold.
    await seedSnapshots(tailUser, JUNE_BUSINESS_DATES.slice(0, 10));
    expect(computeOosEvidenceCutoff(tailUser, { now: Date.parse("2026-08-01T15:00:00Z") })).toBeUndefined();
  });
});

describe("getFactorScorecard — closedBefore (PIT evidence cutoff)", () => {
  it("aggregates only lots whose outcome was realized before the cutoff", async () => {
    const { insertFillEvent } = await import("../src/lib/db");
    const { getFactorScorecard } = await import("../src/lib/performance");
    const userId = "local";
    const accountNumber = `PIT-SCORE-${randomUUID().slice(0, 8)}`;
    const raw = { dominantFactor: "momentum", proposal: { tradeThesisTag: "T", entryMarketRegime: "Tech-Bull" } };
    // Two lots closed in June (pre-cutoff), two closed in July (post-cutoff).
    for (const [i, exitDate] of ["2026-06-10", "2026-06-11", "2026-07-10", "2026-07-11"].entries()) {
      const sym = `P${i}`;
      insertFillEvent({ accountNumber, source: "paper", symbol: sym, side: "buy", quantity: 1, price: 100, notional: 100, status: "filled", filledAt: `${exitDate}T14:00:00.000Z`, raw, userId });
      insertFillEvent({ accountNumber, source: "paper", symbol: sym, side: "sell", quantity: 1, price: 110, notional: 110, status: "filled", filledAt: `${exitDate}T20:00:00.000Z`, raw, userId });
    }

    const all = getFactorScorecard(accountNumber, "paper", {}, userId);
    expect(all.find((r) => r.factor === "momentum")?.trades).toBe(4);

    const cut = getFactorScorecard(accountNumber, "paper", {}, userId, { closedBefore: "2026-07-01" });
    expect(cut.find((r) => r.factor === "momentum")?.trades).toBe(2);
  });
});
