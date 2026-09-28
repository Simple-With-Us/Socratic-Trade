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
import { getRedTeamEfficacy, RED_TEAM_DEDUP_WINDOW_DAYS, RED_TEAM_EFFICACY_MIN_UNIQUE_MATURED } from "../src/lib/performance";

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
