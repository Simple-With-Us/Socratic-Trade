// 2026-09-28 — retiring a playbook tag (`Analyst-Revision`) from `THESIS_PLAYBOOK`.
//
// Why this file exists. The owner ruled on the three tags the deterministic scorer could not derive:
// derive them or rule them out, do not leave them model-assigned. `Mean-Reversion` and
// `Defensive-Rotation` turned out to be derivable from evidence the scan already computes (see
// test/thesis-tag-deterministic.test.ts). `Analyst-Revision` is not: it names a DELTA in an analyst's
// rating, and every analyst field the scan computes is a LEVEL or a cross-provider snapshot with no
// timestamp and no prior value. So it is retired.
//
// Retirement is NOT a reinterpretation of history, and that claim is only worth anything if it is
// tested. The whole realized-performance mechanism keys on the tag string, so the question is not
// "does the enum still contain the name" but "what happens to a CLOSED LOT that already carries it".
// The failure mode this guards against is silently orphaning those lots: a retired tag that stopped
// being bucketed would quietly remove the size penalty and the expectancy skip from every trade ever
// filed under it, which is a far worse outcome than the self-grading problem it was retired to fix.
//
// What retirement does and does not do, and where each is pinned:
//   REMOVES the ability to SELECT the tag on anything new   → the repair filter drops it (§2)
//   LEAVES stored rows, their scorecard bucket, their sizing
//     multiplier and their negative-expectancy skip intact  → §3 and §4

import { describe, expect, it } from "vitest";
import {
  isSelectableThesisTag,
  RETIRED_THESIS_TAGS,
  THESIS_PLAYBOOK
} from "../src/lib/strategy-prompts";
import { getThesisScorecard, type ThesisStat } from "../src/lib/performance";
import { selectThesisStat } from "../src/lib/strategy-risk";
import type { PnlResult, ThesisRegimeStat } from "../src/lib/performance";
import type { TradeProposal } from "../src/lib/types";
import { filterRepairedProposals } from "../src/lib/strategy";

const RETIRED = "Analyst-Revision";

const emptyPnl = (closedLots: PnlResult["closedLots"]): PnlResult => ({
  realized: 0,
  unrealized: 0,
  closedLots,
  openLots: [],
  attribution: [],
  unmatchedClosingFills: []
});

const lot = (thesisTag: string, returnPct: number) => ({
  pnl: returnPct,
  returnPct,
  quantity: 1,
  symbol: "AAPL",
  thesisTag
});

const stat = (thesisTag: string, trades: number, avgReturnPct: number): ThesisStat => ({
  thesisTag,
  trades,
  winRate: 40,
  avgReturnPct,
  totalPnl: 0,
  shrunkWinRate: 45,
  shrunkAvgReturnPct: avgReturnPct
});

const proposal = (tradeThesisTag: string): TradeProposal =>
  ({ symbol: "AAPL", side: "buy", tradeThesisTag, confidenceScore: 70 } as unknown as TradeProposal);

describe("the retired tag is out of the playbook and says why", () => {
  it("is no longer a tag the model may pick", () => {
    expect(THESIS_PLAYBOOK as readonly string[]).not.toContain(RETIRED);
  });

  it("is still named in RETIRED_THESIS_TAGS, with a reason a reader can check", () => {
    // A retirement nobody can read is indistinguishable from a typo. The reason must state the
    // evidence that is missing, not just assert the conclusion.
    expect(RETIRED_THESIS_TAGS[RETIRED]).toBeTruthy();
    expect(RETIRED_THESIS_TAGS[RETIRED]).toMatch(/DELTA/);
    expect(RETIRED_THESIS_TAGS[RETIRED]).toMatch(/LEVEL/);
  });

  it("is not selectable, and no retired tag is", () => {
    expect(isSelectableThesisTag(RETIRED)).toBe(false);
    for (const tag of Object.keys(RETIRED_THESIS_TAGS)) expect(isSelectableThesisTag(tag)).toBe(false);
  });

  it("does not overlap the live playbook — a name cannot be both", () => {
    for (const tag of Object.keys(RETIRED_THESIS_TAGS)) {
      expect(THESIS_PLAYBOOK as readonly string[]).not.toContain(tag);
    }
  });

  it("every surviving playbook tag remains selectable", () => {
    for (const tag of THESIS_PLAYBOOK) expect(isSelectableThesisTag(tag)).toBe(true);
  });

  it("`isSelectableThesisTag` answers the SELECT question, not the scorer question", () => {
    // `Risk-Exit` is selectable (a repaired reply may carry it) but has no scorer rule, because it
    // is assigned on the de-risking path and openings are the only scored side. Conflating the two
    // questions would either drop legitimate exit tags or wrongly admit a retired one.
    expect(isSelectableThesisTag("Risk-Exit")).toBe(true);
  });
});

describe("a proposal can no longer be SELECTED with the retired tag", () => {
  // `filterRepairedProposals` is the schema boundary a repaired model reply is re-validated against
  // (it re-checks the declared `tradeThesisTag` enum), so it is where a retired name stops being
  // reachable on the repair path. The primary path is the schema itself, which is built from
  // THESIS_PLAYBOOK (src/lib/strategy.ts).
  const complete = () => ({
    symbol: "AAPL",
    side: "buy",
    type: "market",
    rationale: "A reason the risk gate can read.",
    tradeThesisTag: "Momentum-Breakout",
    confidenceScore: 70,
    quantity: 1,
    dollarAmount: null,
    limitPrice: null,
    stopPrice: null,
    bracketStopLoss: null,
    bracketTakeProfit: null,
    exitPlan: null,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    stopPlan: null,
    autonomyOverride: null
  });

  it("drops a repaired proposal carrying the retired tag", () => {
    const { kept, dropped } = filterRepairedProposals([
      { ...complete(), tradeThesisTag: RETIRED },
      complete()
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.tradeThesisTag).toBe("Momentum-Breakout");
    expect(dropped).toBe(1);
  });
});

describe("a HISTORICAL lot carrying the retired tag keeps its full feedback mechanism", () => {
  // The additive half. `getThesisScorecard` buckets closed lots by the tag string actually stored
  // (`lot.thesisTag.trim()`, else "Untagged") and never consults the playbook, so retiring a name
  // cannot remove a bucket that already exists.
  it("still gets its own scorecard bucket", () => {
    const card = getThesisScorecard(
      "acct",
      "live",
      {},
      "local",
      undefined,
      { live: emptyPnl([lot(RETIRED, -2), lot(RETIRED, -1), lot("Momentum-Breakout", 3)]) }
    );
    const retiredBucket = card.find((s) => s.thesisTag === RETIRED);
    expect(retiredBucket).toBeDefined();
    expect(retiredBucket?.trades).toBe(2);
    // It is bucketed on its OWN, not folded into a neighbouring or "Untagged" bucket.
    expect(card.find((s) => s.thesisTag === "Untagged")).toBeUndefined();
  });

  it("is still found by the sizing/skip lookup, which is a plain string join", () => {
    // `selectThesisStat` is the single lookup BOTH `applyDeterministicSizing` and
    // `shouldSkipNegativeExpectancy` use, so covering it covers both consumers.
    const thesisScorecard = [stat(RETIRED, 24, -1.8), stat("Momentum-Breakout", 30, 0.6)];
    const found = selectThesisStat([] as ThesisRegimeStat[], thesisScorecard, proposal(RETIRED));
    expect(found?.thesisTag).toBe(RETIRED);
    expect(found?.trades).toBe(24);
    expect(found?.shrunkAvgReturnPct).toBe(-1.8);
  });

  it("still prefers the thesis×regime bucket for a retired tag when that bucket has samples", () => {
    // The combo lookup is the same exact-string join on both sides, so a retired tag keeps the
    // sharper, regime-conditional number too rather than silently falling back to the coarser one.
    const combo: ThesisRegimeStat = {
      thesisTag: RETIRED,
      regime: "risk-off",
      trades: 8,
      winRate: 25,
      avgReturnPct: -3,
      totalPnl: 0,
      shrunkWinRate: 35,
      shrunkAvgReturnPct: -2.4
    };
    const p = { ...proposal(RETIRED), entryMarketRegime: "risk-off" } as TradeProposal;
    const found = selectThesisStat([combo], [stat(RETIRED, 24, -1.8)], p);
    expect(found && "regime" in found ? found.regime : undefined).toBe("risk-off");
  });

  it("a retired tag with no history is unproven, exactly like any other unknown tag", () => {
    // The other direction, and the reason the repair filter drops unknown names: a tag with no
    // scorecard row is treated as unproven, so it must never become a way to BYPASS a skip gate.
    const found = selectThesisStat([], [stat("Momentum-Breakout", 30, 0.6)], proposal(RETIRED));
    expect(found).toBeUndefined();
  });
});
