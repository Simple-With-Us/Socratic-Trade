// Red Team veto scorecard honesty (2026-09-25 review, "rank 7").
//
// Three complaints drove this file:
//   1. 79 vetoes were counted but only 24 unique scenarios exist behind them — repeat vetoes of the
//      same setup were being scored as independent evidence.
//   2. The headline average return was carried by ONE +27.4% PYPL veto; the median told the opposite
//      story, and only the mean was published.
//   3. Counterfactual returns run a 5-trading-day window while the book holds those names far
//      longer, and nothing on the scorecard said so.
//
// Every assertion below is on a field that did not exist before this work (uniqueScenarios /
// medianReturnPct / verdict / horizon), so each test fails on unmodified main with `undefined`.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  approvedHoldStatsFromClosedLots,
  buildRedTeamEfficacySnapshot,
  getRedTeamEfficacy,
  RED_TEAM_DEDUP_WINDOW_DAYS,
  RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED,
  type ClosedLot
} from "../src/lib/performance";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-redteam-honesty-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.useRealTimers();
});

/** One Bear veto plus its matured 5-trading-day counterfactual. */
async function maturedVeto(input: {
  userId: string;
  runId: string;
  symbol: string;
  returnPct: number;
  model?: string;
  snapshotAt?: string;
  exitDate?: string;
  side?: string;
}) {
  const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
  const snapshotAt = input.snapshotAt ?? "2026-06-01T00:00:00.000Z";
  const exitDate = input.exitDate ?? "2026-06-06";
  audit(
    "proposal_rejected_by_red_team",
    {
      runId: input.runId,
      symbol: input.symbol,
      side: input.side ?? "buy",
      thesisTag: "Momentum",
      reason: "Overbought.",
      ...(input.model ? { model: input.model } : {})
    },
    input.userId
  );
  insertSkippedCounterfactualCandidate({
    userId: input.userId,
    runId: input.runId,
    symbol: input.symbol,
    snapshotAt,
    refPrice: 100,
    horizonDays: 5,
    targetDate: "2026-06-06"
  });
  markSkippedCounterfactualMatured({
    id: `${input.userId}:${input.runId}:${input.symbol}:5`,
    userId: input.userId,
    exitDate,
    exitPrice: 100 * (1 + input.returnPct / 100),
    returnPct: input.returnPct,
    checkedAt: snapshotAt
  });
}

describe("Red Team efficacy — unique scenarios (dedup)", () => {
  it("collapses repeat vetoes of one setup into a single scored scenario and reports both counts", async () => {
    const userId = `redteam-dedup-${randomUUID()}`;
    // The Bear blocked AAPL on three consecutive scans — one decision, three audit rows. On main
    // this reported totalVetoes 3, maturedVetoes 3 and averaged all three returns.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-dedup-1", symbol: "AAPL", returnPct: -10, model: "openai/gpt-4.1-mini" });
    vi.setSystemTime(new Date("2026-06-02T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-dedup-2", symbol: "AAPL", returnPct: 20, model: "openai/gpt-4.1-mini" });
    vi.setSystemTime(new Date("2026-06-03T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-dedup-3", symbol: "AAPL", returnPct: -5, model: "openai/gpt-4.1-mini" });
    vi.useRealTimers();

    const efficacy = getRedTeamEfficacy(userId);

    // Raw pipeline counts are unchanged in meaning — all three vetoes resolved.
    expect(efficacy.totalVetoes).toBe(3);
    expect(efficacy.maturedVetoes).toBe(3);
    // The honest sample is one scenario: on main every one of these fields was undefined.
    expect(efficacy.uniqueScenarios).toBe(1);
    expect(efficacy.duplicateVetoes).toBe(2);
    expect(efficacy.maturedUniqueScenarios).toBe(1);
    // EARLIEST veto survives, so the scored outcome is the first decision's, not the last one's.
    expect(efficacy.records).toHaveLength(1);
    expect(efficacy.records[0]).toMatchObject({ runId: "rt-dedup-1", returnPct: -10, duplicatesCollapsed: 2 });
    expect(efficacy.avgReturnPct).toBe(-10);
    expect(efficacy.medianReturnPct).toBe(-10);
    // The repeat vetoes are still visible in the prose disclosure, never silently dropped.
    expect(efficacy.coverage).toContain("scored on 1 unique scenario");
    expect(efficacy.coverage).toContain("2 repeat vetoes collapsed");
  });

  it("keeps the same symbol as separate scenarios once the dedup window has passed", async () => {
    const userId = `redteam-window-${randomUUID()}`;
    // Same name, same side, 19 days apart — two independent decisions, not one repeated call.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-win-1", symbol: "AAPL", returnPct: -10, model: "openai/gpt-4.1-mini" });
    vi.setSystemTime(new Date("2026-06-20T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-win-2", symbol: "AAPL", returnPct: -4, model: "openai/gpt-4.1-mini" });
    vi.useRealTimers();

    const efficacy = getRedTeamEfficacy(userId);
    expect(RED_TEAM_DEDUP_WINDOW_DAYS).toBe(7);
    expect(efficacy.totalVetoes).toBe(2);
    expect(efficacy.uniqueScenarios).toBe(2);
    expect(efficacy.duplicateVetoes).toBe(0);
    expect(efficacy.records).toHaveLength(2);
  });

  it("treats a buy block and a short block on one name as two different scenarios", async () => {
    const userId = `redteam-sides-${randomUUID()}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T15:00:00Z"));
    await maturedVeto({ userId, runId: "rt-side-buy", symbol: "TSLA", side: "buy", returnPct: -10, model: "openai/gpt-4.1-mini" });
    await maturedVeto({ userId, runId: "rt-side-short", symbol: "TSLA", side: "short", returnPct: -6, model: "openai/gpt-4.1-mini" });
    vi.useRealTimers();

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.uniqueScenarios).toBe(2);
    expect(efficacy.maturedUniqueScenarios).toBe(2);
  });
});

describe("Red Team efficacy — median beside the mean", () => {
  it("reports a median that survives the single outlier the mean cannot", async () => {
    const userId = `redteam-median-${randomUUID()}`;
    // The review's shape: one +27.4% PYPL buy carried the average; the median said something else.
    await maturedVeto({ userId, runId: "rt-med-1", symbol: "PYPL", returnPct: 27.4, model: "openai/gpt-4.1-mini" });
    await maturedVeto({ userId, runId: "rt-med-2", symbol: "AAPL", returnPct: -10, model: "openai/gpt-4.1-mini" });
    await maturedVeto({ userId, runId: "rt-med-3", symbol: "MSFT", returnPct: -5, model: "openai/gpt-4.1-mini" });
    await maturedVeto({ userId, runId: "rt-med-4", symbol: "NVDA", returnPct: 2, model: "openai/gpt-4.1-mini" });

    const efficacy = getRedTeamEfficacy(userId);
    // Mean (14.4 / 4) reads "the Bear let +3.6% through"; median ((-5 + 2) / 2) reads slightly negative.
    expect(efficacy.avgReturnPct).toBe(3.6);
    expect(efficacy.medianReturnPct).toBe(-1.5);
    const perModel = efficacy.byModel.find((m) => m.model === "gpt-mini-latest");
    expect(perModel?.avgReturnPct).toBe(3.6);
    expect(perModel?.medianReturnPct).toBe(-1.5);
    expect(perModel?.duplicateVetoes).toBe(0);
  });

  it("reports a median of 0 (never a fabricated figure) for an account with no matured vetoes", async () => {
    const efficacy = getRedTeamEfficacy(`redteam-empty-${randomUUID()}`);
    expect(efficacy.totalVetoes).toBe(0);
    expect(efficacy.uniqueScenarios).toBe(0);
    expect(efficacy.maturedUniqueScenarios).toBe(0);
    expect(efficacy.medianReturnPct).toBe(0);
    expect(efficacy.coverage).toBe("no vetoes observed");
  });
});

describe("Red Team efficacy — is the sample big enough to decide yet?", () => {
  it("refuses to call the Red Team effective below 50 unique matured scenarios", async () => {
    const userId = `redteam-sufficiency-${randomUUID()}`;
    for (let i = 0; i < 3; i += 1) {
      await maturedVeto({ userId, runId: `rt-suff-${i}`, symbol: `S${i}`, returnPct: -10, model: "openai/gpt-4.1-mini" });
    }

    const efficacy = getRedTeamEfficacy(userId);
    expect(RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED).toBe(50);
    expect(efficacy.maturedUniqueScenarios).toBe(3);
    // On main: the console's own 20/50 gate is fed `maturedVetoes`, so three repeat vetoes of ONE
    // name could read as a 3-veto sample and the only sample question asked was "raw count >= 20".
    expect(efficacy.sampleSufficient).toBe(false);
    expect(efficacy.verdict).toBe("insufficient-sample");
    expect(efficacy.minUniqueMaturedForVerdict).toBe(50);
  });

  it("keeps a repeat-heavy account below the bar even when its raw matured count is large", async () => {
    const userId = `redteam-repeats-${randomUUID()}`;
    // 60 matured vetoes, all the same symbol inside the dedup window: the review's exact failure
    // mode (a big raw count hiding a small scenario count).
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 60; i += 1) {
      vi.setSystemTime(new Date(Date.parse("2026-06-01T15:00:00Z") + i * 60_000));
      await maturedVeto({ userId, runId: `rt-rep-${i}`, symbol: "PYPL", returnPct: 27.4, model: "openai/gpt-4.1-mini" });
    }
    vi.useRealTimers();

    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.maturedVetoes).toBe(60);
    expect(efficacy.maturedUniqueScenarios).toBe(1);
    expect(efficacy.sampleSufficient).toBe(false);
    expect(efficacy.avgReturnPct).toBe(27.4);
  });
});

describe("Red Team efficacy — horizon disclosure", () => {
  it("puts the measured counterfactual window next to the approved book's holding period", async () => {
    const userId = `redteam-horizon-${randomUUID()}`;
    await maturedVeto({
      userId,
      runId: "rt-hz-1",
      symbol: "AAPL",
      returnPct: -10,
      model: "openai/gpt-4.1-mini",
      snapshotAt: "2026-06-01T00:00:00.000Z",
      exitDate: "2026-06-08"
    });

    const withoutBook = getRedTeamEfficacy(userId);
    // On main there is no `horizon` object at all, so a reader could not tell the counterfactual
    // was measured over 5 trading days while the book holds the name for weeks.
    expect(withoutBook.horizon).toMatchObject({
      counterfactualHorizonDays: 5,
      medianMeasuredHoldDays: 7,
      horizonMatched: false
    });
    expect(withoutBook.horizon?.disclosure).toContain("NOT horizon-matched");
    expect(withoutBook.records[0]).toMatchObject({ horizonDays: 5, measuredHoldDays: 7 });

    // A caller that holds closed lots can quantify the mismatch instead of only naming it.
    const withBook = getRedTeamEfficacy(userId, { approvedHoldMedianDays: 30, approvedHoldSampleSize: 42 });
    expect(withBook.horizon?.medianApprovedHoldDays).toBe(30);
    expect(withBook.horizon?.approvedHoldSampleSize).toBe(42);
    expect(withBook.horizon?.horizonMatched).toBe(false);
    expect(withBook.horizon?.disclosure).toContain("30");
    expect(withBook.horizon?.disclosure).toContain("42 closed lots");

    // Within a week of the measured window the comparison is honestly called matched.
    const closeBook = getRedTeamEfficacy(userId, { approvedHoldMedianDays: 8, approvedHoldSampleSize: 42 });
    expect(closeBook.horizon?.horizonMatched).toBe(true);
    expect(closeBook.horizon?.disclosure).toContain("approximately horizon-matched");
  });
});

describe("ST-4653 exactly-one side adjustment", () => {
  it("does not re-invert a short counterfactual that already matured side-adjusted", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-sign-${randomUUID()}`;
    audit("proposal_rejected_by_red_team",
      { runId: "rt-sign-1", symbol: "TSLA", side: "short", thesisTag: "Momentum", reason: "Crowded." }, userId);
    insertSkippedCounterfactualCandidate({
      userId, runId: "rt-sign-1", symbol: "TSLA", side: "short",
      snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06"
    });
    // Price rose 100 -> 106: maturation already stored the side-adjusted -6 for the short.
    markSkippedCounterfactualMatured({
      id: `${userId}:rt-sign-1:TSLA:5`, userId,
      exitDate: "2026-06-06", exitPrice: 106, returnPct: -6, checkedAt: "2026-06-06T00:00:00.000Z"
    });
    const efficacy = getRedTeamEfficacy(userId);
    // A double inversion would read +6 ("the veto missed a winner"); the veto in fact avoided a loser.
    expect(efficacy.records[0]?.returnPct).toBe(-6);
    expect(efficacy.avgReturnPct).toBe(-6);
  });

  it("still inverts a legacy side-less short row (pre-ST-4653 long-sign storage)", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-sign-legacy-${randomUUID()}`;
    audit("proposal_rejected_by_red_team",
      { runId: "rt-sign-legacy", symbol: "TSLA", side: "short", thesisTag: "Momentum", reason: "Crowded." }, userId);
    insertSkippedCounterfactualCandidate({
      userId, runId: "rt-sign-legacy", symbol: "TSLA",
      snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06"
    });
    // Legacy storage kept the raw long-sign +6 for the same 100 -> 106 rise.
    markSkippedCounterfactualMatured({
      id: `${userId}:rt-sign-legacy:TSLA:5`, userId,
      exitDate: "2026-06-06", exitPrice: 106, returnPct: 6, checkedAt: "2026-06-06T00:00:00.000Z"
    });
    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.records[0]?.returnPct).toBe(-6);
  });

  it("converts an opposite-side persisted row to the veto direction exactly once", async () => {
    const { audit, insertSkippedCounterfactualCandidate, markSkippedCounterfactualMatured } = await import("../src/lib/db");
    const userId = `redteam-sign-mismatch-${randomUUID()}`;
    audit("proposal_rejected_by_red_team",
      { runId: "rt-sign-mismatch", symbol: "TSLA", side: "short", thesisTag: "Momentum", reason: "Crowded." }, userId);
    // Only a BUY-side row exists for this run+symbol (price rose 100 -> 115, stored +15
    // buy-adjusted). Reading it for the short veto must invert once, not read as-is.
    insertSkippedCounterfactualCandidate({
      userId, runId: "rt-sign-mismatch", symbol: "TSLA", side: "buy",
      snapshotAt: "2026-06-01T00:00:00.000Z", refPrice: 100, horizonDays: 5, targetDate: "2026-06-06"
    });
    markSkippedCounterfactualMatured({
      id: `${userId}:rt-sign-mismatch:TSLA:5`, userId,
      exitDate: "2026-06-06", exitPrice: 115, returnPct: 15, checkedAt: "2026-06-06T00:00:00.000Z"
    });
    const efficacy = getRedTeamEfficacy(userId);
    expect(efficacy.records[0]?.returnPct).toBe(-15);
  });
});

// ST-4678: the Red-context efficacy snapshot omitted the approved-hold arguments and dropped the
// `horizon` disclosure, so Red always saw "not horizon-matched" regardless of the book's real hold.
// The snapshot now carries the horizon and is built from the same closed lots Green grades.
describe("ST-4678: horizon-matched Red efficacy passed to the Red context", () => {
  it("approvedHoldStatsFromClosedLots derives the median hold and sample size from the approved book", () => {
    const lot = (entryAt: string, exitAt: string): ClosedLot => ({ pnl: 0, returnPct: 0, entryAt, exitAt });
    const stats = approvedHoldStatsFromClosedLots([
      lot("2026-06-01T00:00:00.000Z", "2026-06-08T00:00:00.000Z"), // 7 days
      lot("2026-06-01T00:00:00.000Z", "2026-06-15T00:00:00.000Z"), // 14 days
      lot("2026-06-01T00:00:00.000Z", "2026-06-29T00:00:00.000Z"), // 28 days
      { pnl: 0, returnPct: 0 }, // no dates — skipped
      lot("2026-06-10T00:00:00.000Z", "2026-06-01T00:00:00.000Z") // exit before entry — skipped
    ]);
    expect(stats.approvedHoldSampleSize).toBe(3);
    expect(stats.approvedHoldMedianDays).toBe(14);
    // No usable lots => no median, sample 0 (today's "not supplied" default is preserved).
    expect(approvedHoldStatsFromClosedLots([])).toEqual({ approvedHoldSampleSize: 0 });
    expect(approvedHoldStatsFromClosedLots([{ pnl: 0, returnPct: 0 }])).toEqual({ approvedHoldSampleSize: 0 });
  });

  it("the efficacy snapshot passed to Red equals a direct getRedTeamEfficacy call with the same horizon", async () => {
    const userId = `redteam-horizon-match-${randomUUID()}`;
    await maturedVeto({
      userId, runId: "rt-hm-1", symbol: "AAPL", returnPct: -10,
      snapshotAt: "2026-06-01T00:00:00.000Z", exitDate: "2026-06-08"
    });
    const closedLots: ClosedLot[] = [
      { pnl: 0, returnPct: 0, entryAt: "2026-06-01T00:00:00.000Z", exitAt: "2026-06-08T00:00:00.000Z" }, // 7
      { pnl: 0, returnPct: 0, entryAt: "2026-06-01T00:00:00.000Z", exitAt: "2026-06-09T00:00:00.000Z" }  // 8
    ];
    const options = { limit: 10, ...approvedHoldStatsFromClosedLots(closedLots) };

    const snapshot = buildRedTeamEfficacySnapshot(userId, options);
    const direct = getRedTeamEfficacy(userId, options);
    expect(snapshot).toBeDefined();
    // The snapshot Red sees equals a direct call with the same horizon-matched approved-hold args.
    expect(snapshot).toEqual({
      totalVetoes: direct.totalVetoes,
      maturedVetoes: direct.maturedVetoes,
      vetoValueAddRate: direct.vetoValueAddRate,
      survivorRiskHitRate: direct.survivorRiskHitRate,
      avgReturnPct: direct.avgReturnPct,
      verdict: direct.verdict,
      coverage: direct.coverage,
      horizon: direct.horizon
    });
    // The horizon disclosure now travels to Red (the #5466 snapshot dropped it) and is matched:
    // measured 7 calendar days vs a 7.5-day approved median hold.
    expect(snapshot?.horizon?.medianApprovedHoldDays).toBe(7.5);
    expect(snapshot?.horizon?.approvedHoldSampleSize).toBe(2);
    expect(snapshot?.horizon?.horizonMatched).toBe(true);
    expect(snapshot?.horizon?.disclosure).toContain("approximately horizon-matched");
  });

  it("keeps today's not-supplied disclosure when the holding horizon is unknown (no closed lots)", async () => {
    const userId = `redteam-horizon-unknown-${randomUUID()}`;
    await maturedVeto({ userId, runId: "rt-hu-1", symbol: "MSFT", returnPct: -5 });
    const options = { limit: 10, ...approvedHoldStatsFromClosedLots([]) };
    const snapshot = buildRedTeamEfficacySnapshot(userId, options);
    const direct = getRedTeamEfficacy(userId, { limit: 10 });
    expect(snapshot?.horizon).toEqual(direct.horizon);
    expect(snapshot?.horizon?.medianApprovedHoldDays).toBeUndefined();
    expect(snapshot?.horizon?.disclosure).toContain("NOT horizon-matched");
  });
});
