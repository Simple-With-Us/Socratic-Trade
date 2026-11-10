/**
 * Unified ProposalScorecard (external-repo lessons r3). Verifies:
 *   1. buildProposalScorecard populates every section DETERMINISTICALLY from already-computed
 *      state, and OMITS fields whose source data is absent (never a fabricated 0).
 *   2. computeSignalAttribution maps the quote's factor scores into four integer buckets summing
 *      to exactly 100 (largest-remainder rounding), and is undefined without factor scores.
 *   3. The action checklist is a RENDERING of gate state (entry-drift reason, wash-sale audit,
 *      daily-cap escalations, red-team verdict, dataAdjustments) — mirrored, never invented; the
 *      entry-drift PASS row exists only when the gate's full predicate (opening + gated order
 *      shape + entry anchor + current scan price) says the guard actually evaluated the proposal.
 *   4. appendDecisionStep seeds "proposed", dedups consecutive steps, and buildProposalScorecard
 *      preserves an accumulated chain; validateDecisionChain flags override_applied without a
 *      preceding override_requested (and repeated/unknown steps).
 *   5. Persistence round-trip: the scorecard survives the trade_proposals JSON round trip, and a
 *      malformed chain logs an audit receipt while the proposal is still stored (never dropped).
 *   6. gradeSniperAccuracy grades stop/take levels against synthetic daily closes, side-aware,
 *      undefined when no bars cover the window.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { computeSignalAttribution } from "../src/lib/market";
import { gradeSniperAccuracy } from "../src/lib/outcome-engine";
import { appendDecisionStep, buildProposalScorecard, scorecardIndicatorsFromBars } from "../src/lib/strategy";
import type { MarketFactorBreakdown, MarketQuote, PolicyDecision, TradeProposal, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-scorecard-${randomUUID()}.db`)}`;
});

const THESIS = "Momentum-Breakout";
const REGIME = "Tech-Bull";

function buyProposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    symbol: "NVDA",
    side: "buy",
    type: "market",
    dollarAmount: 500,
    timeInForce: "gfd",
    marketHours: "regular_hours",
    rationale: "Strong momentum with improving fundamentals.",
    tradeThesisTag: THESIS,
    entryMarketRegime: REGIME,
    ...over
  };
}

function policyWith(over: Partial<TradingPolicy> = {}): TradingPolicy {
  return { ...DEFAULT_POLICY, accountNumber: "ACCT", scoringWeights: { ...DEFAULT_POLICY.scoringWeights }, ...over };
}

function factorBreakdown(over: Partial<Record<keyof Omit<MarketFactorBreakdown, "weightedTotal">, number>> = {}): MarketFactorBreakdown {
  return {
    liquidity: 0,
    momentum: 0,
    value: 0,
    quality: 0,
    volatility: 0,
    sentiment: 0,
    positioning: 0,
    diversification: 0,
    weightedTotal: 0,
    ...over
  };
}

function quoteWith(partial: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: "NVDA",
    price: 100,
    volume: 5_000_000,
    intradayChangePct: 0,
    positionMarketValue: 0,
    score: 50,
    ...partial
  } as MarketQuote;
}

const APPROVED: PolicyDecision = { approved: true, reasons: [] };

describe("computeSignalAttribution", () => {
  it("maps the factor buckets and sums to exactly 100", () => {
    const attribution = computeSignalAttribution({
      factorBreakdown: factorBreakdown({ liquidity: 60, momentum: 40, sentiment: 55, value: 20, quality: 30, positioning: 10, volatility: 50, diversification: 80 })
    });
    expect(attribution).toBeDefined();
    const { technical, news, fundamentals, market } = attribution!;
    expect(technical + news + fundamentals + market).toBe(100);
    for (const value of [technical, news, fundamentals, market]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // technical (100) carries the largest raw share of the 345 total.
    expect(technical).toBeGreaterThan(news);
    expect(technical).toBeGreaterThan(fundamentals);
  });

  it("splits an even four-way tie 25/25/25/25", () => {
    const attribution = computeSignalAttribution({
      factorBreakdown: factorBreakdown({ liquidity: 25, sentiment: 25, value: 25, positioning: 25 })
    });
    expect(attribution).toEqual({ technical: 25, news: 25, fundamentals: 25, market: 25 });
  });

  it("largest-remainder rounding still sums to 100 on thirds", () => {
    const attribution = computeSignalAttribution({
      factorBreakdown: factorBreakdown({ liquidity: 1, sentiment: 1, value: 1 })
    });
    expect(attribution).toBeDefined();
    const { technical, news, fundamentals, market } = attribution!;
    expect(technical + news + fundamentals + market).toBe(100);
    expect(market).toBe(0);
  });

  it("is undefined without a factor breakdown or with all-zero factors — never fabricated", () => {
    expect(computeSignalAttribution({ factorBreakdown: undefined })).toBeUndefined();
    expect(computeSignalAttribution({ factorBreakdown: factorBreakdown() })).toBeUndefined();
  });
});

describe("buildProposalScorecard population", () => {
  it("populates every section when the source data exists", () => {
    const proposal = buyProposal({
      referencePrice: 100,
      bracketStopLoss: 92,
      bracketTakeProfit: 118,
      sizingSnapshot: { portfolioValue: 10_000, estimatedNotional: 500, remainingDailyNotional: 1_234.56 },
      redTeamVerdict: { verdict: "approve", rejected: false, available: true, reason: "No fatal flaw." }
    });
    const scorecard = buildProposalScorecard({
      proposal,
      decision: APPROVED,
      policy: policyWith({ secondaryBuyPullbackPct: 5, maxEntryDriftPct: 3 }),
      quote: quoteWith({ factorBreakdown: factorBreakdown({ liquidity: 50, momentum: 50, sentiment: 40, value: 30, quality: 30, positioning: 20, volatility: 20, diversification: 10 }) }),
      indicators: { sma50: 90, sma200: 80, avgVolume20d: 4_000_000 }
    });

    expect(scorecard.coreConclusion?.thesis).toBe("Strong momentum with improving fundamentals.");
    expect(scorecard.coreConclusion?.noPositionAdvice).toContain("Entry anchor $100.00.");
    expect(scorecard.coreConclusion?.noPositionAdvice).toContain("Secondary entry on a pullback to $95.00.");
    expect(scorecard.coreConclusion?.hasPositionAdvice).toContain("above the $92.00 stop");
    expect(scorecard.dataPerspective?.maAlignment).toBe("above_both");
    expect(scorecard.dataPerspective?.priceVsMa).toEqual({ price: 100, sma50: 90, sma200: 80 });
    expect(scorecard.dataPerspective?.volume).toEqual({ current: 5_000_000, avg20d: 4_000_000 });
    expect(scorecard.sniperPoints).toEqual({ idealBuy: 100, secondaryBuy: 95, secondaryBuyBasis: "owner-set", stopLoss: 92, takeProfit: 118 });
    const attribution = scorecard.signalAttribution!;
    expect(attribution.technical + attribution.news + attribution.fundamentals + attribution.market).toBe(100);
    expect(scorecard.decisionChain).toEqual(["proposed"]);

    const byId = Object.fromEntries((scorecard.actionChecklist ?? []).map((item) => [item.id, item]));
    expect(byId.entry_drift?.status).toBe("pass");
    expect(byId.wash_sale?.status).toBe("pass");
    expect(byId.daily_cap?.status).toBe("pass");
    expect(byId.daily_cap?.label).toContain("$1234.56");
    expect(byId.red_team?.status).toBe("pass");
    expect(byId.data_adjustments?.status).toBe("pass");
  });

  it("omits fields whose source data is absent — never a fake 0", () => {
    const proposal = buyProposal();
    const scorecard = buildProposalScorecard({ proposal, decision: APPROVED, policy: policyWith() });
    expect(scorecard.dataPerspective).toBeUndefined(); // no price anywhere
    expect(scorecard.sniperPoints).toBeUndefined(); // no reference/brackets
    expect(scorecard.signalAttribution).toBeUndefined(); // no quote
    expect(scorecard.coreConclusion?.noPositionAdvice).toBe("No deterministic entry level is attached to this proposal.");
    expect(scorecard.coreConclusion?.hasPositionAdvice).toBe("No deterministic exit level is attached to this proposal.");
    // Entry-drift guard unset and no wash/daily/red-team state: only the always-run receipts rows.
    const ids = (scorecard.actionChecklist ?? []).map((item) => item.id);
    expect(ids).toEqual(["wash_sale", "data_adjustments"]);
  });

  it("secondaryBuy is omitted with neither an ATR read nor the owner knob, and the knob mirrors for a short", () => {
    const base = { referencePrice: 200 };
    const withoutEither = buildProposalScorecard({ proposal: buyProposal(base), decision: APPROVED, policy: policyWith() });
    expect(withoutEither.sniperPoints?.secondaryBuy).toBeUndefined();
    expect(withoutEither.sniperPoints?.secondaryBuyBasis).toBeUndefined();
    const shortSide = buildProposalScorecard({
      proposal: buyProposal({ ...base, side: "short" }),
      decision: APPROVED,
      policy: policyWith({ secondaryBuyPullbackPct: 10 })
    });
    expect(shortSide.sniperPoints?.secondaryBuy).toBe(220); // adverse-entry direction for a short is UP
    expect(shortSide.sniperPoints?.secondaryBuyBasis).toBe("owner-set");
    expect(shortSide.coreConclusion?.noPositionAdvice).toContain("rally to $220.00");
  });

  describe("secondaryBuy pullback: ATR-derived by default, owner knob overrides", () => {
    it("derives the pullback from ATR14 (half of ATR as a % of entry) when no knob is set", () => {
      // atr14=4 on a $100 entry -> raw ATR% is 4%; half of that (2%) sits inside the 1-4% clamp band.
      const scorecard = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith(),
        indicators: { atr14: 4 }
      });
      expect(scorecard.sniperPoints?.secondaryBuy).toBe(98);
      expect(scorecard.sniperPoints?.secondaryBuyBasis).toBe("atr-derived");
    });

    it("the owner knob OVERRIDES the ATR derivation outright when both are available", () => {
      const scorecard = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith({ secondaryBuyPullbackPct: 7 }),
        indicators: { atr14: 4 } // would derive 2% unassisted — the knob's 7% must win instead
      });
      expect(scorecard.sniperPoints?.secondaryBuy).toBe(93);
      expect(scorecard.sniperPoints?.secondaryBuyBasis).toBe("owner-set");
    });

    it("is honestly omitted when neither a usable ATR read nor the knob exists", () => {
      const noIndicators = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith()
      });
      expect(noIndicators.sniperPoints).toEqual({ idealBuy: 100 }); // idealBuy still renders; no secondary basis exists
      const zeroAtr = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith(),
        indicators: { atr14: 0 }
      });
      expect(zeroAtr.sniperPoints?.secondaryBuy).toBeUndefined();
      expect(zeroAtr.sniperPoints?.secondaryBuyBasis).toBeUndefined();
    });

    it("clamps to the 1% floor for a near-zero ATR read", () => {
      // atr14=1 on a $100 entry -> raw ATR% 1%; half (0.5%) is below the 1% floor, so it clamps up.
      const scorecard = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith(),
        indicators: { atr14: 1 }
      });
      expect(scorecard.sniperPoints?.secondaryBuy).toBe(99);
      expect(scorecard.sniperPoints?.secondaryBuyBasis).toBe("atr-derived");
    });

    it("clamps to the 4% cap for a large ATR read, and mirrors direction for a short", () => {
      // atr14=20 on a $100 entry -> raw ATR% 20%; half (10%) is far above the 4% cap.
      const long = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100 }),
        decision: APPROVED,
        policy: policyWith(),
        indicators: { atr14: 20 }
      });
      expect(long.sniperPoints?.secondaryBuy).toBe(96);
      const short = buildProposalScorecard({
        proposal: buyProposal({ referencePrice: 100, side: "short" }),
        decision: APPROVED,
        policy: policyWith(),
        indicators: { atr14: 20 }
      });
      expect(short.sniperPoints?.secondaryBuy).toBe(104); // adverse-entry direction for a short is UP
      expect(short.sniperPoints?.secondaryBuyBasis).toBe("atr-derived");
    });
  });

  it("maAlignment is honestly unknown with only one MA, and mixed between them", () => {
    const only50 = buildProposalScorecard({
      proposal: buyProposal({ referencePrice: 100 }),
      decision: APPROVED,
      policy: policyWith(),
      indicators: { sma50: 90 }
    });
    expect(only50.dataPerspective?.maAlignment).toBe("unknown");
    expect(only50.dataPerspective?.priceVsMa).toEqual({ price: 100, sma50: 90 });
    const between = buildProposalScorecard({
      proposal: buyProposal({ referencePrice: 100 }),
      decision: APPROVED,
      policy: policyWith(),
      indicators: { sma50: 110, sma200: 90 }
    });
    expect(between.dataPerspective?.maAlignment).toBe("mixed");
  });

  it("entry-drift pass row exists ONLY when the guard actually evaluated the proposal", () => {
    const policy = policyWith({ maxEntryDriftPct: 3 });
    const quote = quoteWith();
    const hasDriftRow = (scorecard: ReturnType<typeof buildProposalScorecard>) =>
      (scorecard.actionChecklist ?? []).some((item) => item.id === "entry_drift");
    // Whole-share limit entries are deliberately excluded from the gate (the broker's limit caps
    // the fill) — no row, never a fabricated pass.
    const wholeShareLimit = buildProposalScorecard({
      proposal: buyProposal({ referencePrice: 100, type: "limit", limitPrice: 99, quantity: 5, dollarAmount: undefined }),
      decision: APPROVED,
      policy,
      quote
    });
    expect(hasDriftRow(wholeShareLimit)).toBe(false);
    // Exits can carry a referencePrice but the gate only guards openings.
    const exit = buildProposalScorecard({
      proposal: buyProposal({ side: "sell", referencePrice: 100, quantity: 5, dollarAmount: undefined }),
      decision: APPROVED,
      policy,
      quote
    });
    expect(hasDriftRow(exit)).toBe(false);
    // No current scan price means the gate never evaluated drift — the row is omitted honestly.
    const noQuote = buildProposalScorecard({
      proposal: buyProposal({ referencePrice: 100 }),
      decision: APPROVED,
      policy
    });
    expect(hasDriftRow(noQuote)).toBe(false);
    // A Robinhood FRACTIONAL limit IS gated (that adapter routes fractional entries as market
    // orders) — the pass row exists.
    const rhFractional = buildProposalScorecard({
      proposal: buyProposal({ referencePrice: 100, type: "limit", limitPrice: 99, quantity: 1.5, dollarAmount: undefined }),
      decision: APPROVED,
      policy: policyWith({ maxEntryDriftPct: 3, activeBroker: "robinhood" }),
      quote
    });
    expect(rhFractional.actionChecklist?.find((item) => item.id === "entry_drift")?.status).toBe("pass");
  });

  it("checklist mirrors failing gate state (entry drift, daily cap, red-team reject, receipts)", () => {
    const proposal = buyProposal({
      referencePrice: 100,
      dataAdjustments: ["bracket_stop_fallback_atr: repriced", "session_phrase_mismatch: noted"],
      redTeamVerdict: { verdict: "reject", rejected: true, available: true, reason: "Crowded trade." }
    });
    const decision: PolicyDecision = {
      approved: false,
      reasons: ["entry_drift: NVDA moved 4.2% from the proposed entry $100.00 (now $104.20), exceeding the 3% max entry drift."],
      escalations: [{ kind: "daily_notional_cap", reason: "Daily notional limit would be exceeded.", symbol: "NVDA" }]
    };
    const scorecard = buildProposalScorecard({ proposal, decision, policy: policyWith({ maxEntryDriftPct: 3 }) });
    const byId = Object.fromEntries((scorecard.actionChecklist ?? []).map((item) => [item.id, item]));
    expect(byId.entry_drift?.status).toBe("fail");
    expect(byId.daily_cap?.status).toBe("fail");
    expect(byId.red_team?.status).toBe("fail");
    expect(byId.data_adjustments?.status).toBe("warn");
    expect(byId.data_adjustments?.label).toContain("2 deterministic corrections");
  });

  it("wash-sale row reflects the gate audit: annotated proceed = warn, blocking lockout = fail", () => {
    const annotated = buildProposalScorecard({
      proposal: buyProposal(),
      decision: { approved: true, reasons: [], washSale: { handling: "auto", symbol: "NVDA", outcome: "ira_disregarded", note: "IRA wash sale disregarded per your Tax rules." } },
      policy: policyWith()
    });
    expect(annotated.actionChecklist?.find((item) => item.id === "wash_sale")?.status).toBe("warn");
    const blocked = buildProposalScorecard({
      proposal: buyProposal(),
      decision: { approved: false, reasons: ["NVDA is in a 30-day wash-sale lockout (loss on 2026-08-01); rebuying now would disallow that loss."] },
      policy: policyWith()
    });
    expect(blocked.actionChecklist?.find((item) => item.id === "wash_sale")?.status).toBe("fail");
  });

  it("red-team unavailable and approve-at-half render as warn rows", () => {
    const unavailable = buildProposalScorecard({
      proposal: buyProposal({ redTeamVerdict: { rejected: false, available: false, reason: "timeout", failureKind: "timeout" } }),
      decision: APPROVED,
      policy: policyWith()
    });
    expect(unavailable.actionChecklist?.find((item) => item.id === "red_team")?.status).toBe("warn");
    const half = buildProposalScorecard({
      proposal: buyProposal({ redTeamVerdict: { verdict: "approve-at-half", rejected: false, available: true, reason: "Half only." } }),
      decision: APPROVED,
      policy: policyWith()
    });
    expect(half.actionChecklist?.find((item) => item.id === "red_team")?.status).toBe("warn");
  });
});

describe("scorecardIndicatorsFromBars", () => {
  it("computes SMA50/SMA200 and the 20-day average volume from a full series", () => {
    const bars = Array.from({ length: 200 }, (_, i) => ({ time: `2026-01-${(i % 28) + 1}`, close: i + 1, volume: 1_000 }));
    const indicators = scorecardIndicatorsFromBars(bars);
    expect(indicators.sma50).toBe(175.5); // mean of 151..200
    expect(indicators.sma200).toBe(100.5); // mean of 1..200
    expect(indicators.avgVolume20d).toBe(1_000);
    expect(indicators.atr14).toBe(1); // close-only fallback: |close - prevClose| is 1 every bar
  });

  it("computes ATR14 from high/low/close bars, and omits it below period+1 bars", () => {
    const bars = Array.from({ length: 15 }, () => ({ high: 105, low: 95, close: 100 }));
    expect(scorecardIndicatorsFromBars(bars).atr14).toBe(10); // trueRange = max(10, 5, 5) every bar
    const tooFew = Array.from({ length: 10 }, () => ({ high: 105, low: 95, close: 100 }));
    expect(scorecardIndicatorsFromBars(tooFew).atr14).toBeUndefined();
  });

  it("omits what the series cannot support (short series, missing volumes)", () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ close: 100 + i }));
    const indicators = scorecardIndicatorsFromBars(bars);
    expect(indicators.sma50).toBeDefined();
    expect(indicators.sma200).toBeUndefined();
    expect(indicators.avgVolume20d).toBeUndefined();
  });

  it("avg volume window is the trailing 20 BARS — a hole inside it omits the field, one outside does not", () => {
    // A missing volume INSIDE the last 20 bars would silently stretch a "20d" average across more
    // than 20 sessions — omit instead.
    const holeInside = Array.from({ length: 40 }, (_, i) => ({ close: 100, volume: i === 30 ? undefined : 1_000 }));
    expect(scorecardIndicatorsFromBars(holeInside).avgVolume20d).toBeUndefined();
    const holeOutside = Array.from({ length: 40 }, (_, i) => ({ close: 100, volume: i === 5 ? undefined : 1_000 }));
    expect(scorecardIndicatorsFromBars(holeOutside).avgVolume20d).toBe(1_000);
  });
});

describe("decision chain: appendDecisionStep + validateDecisionChain", () => {
  it("seeds 'proposed', appends in order, and skips consecutive duplicates", () => {
    const proposal = buyProposal();
    appendDecisionStep(proposal, "red_team_reject");
    appendDecisionStep(proposal, "red_team_reject"); // consecutive duplicate — dropped
    appendDecisionStep(proposal, "override_requested");
    appendDecisionStep(proposal, "override_applied");
    expect(proposal.scorecard?.decisionChain).toEqual(["proposed", "red_team_reject", "override_requested", "override_applied"]);
  });

  it("a socratic override WITHOUT a red-team rejection still validates clean (request precedes apply)", async () => {
    // Mirrors the strategy loop's overrideResolution.applied branch: on a plain soft-policy block
    // the red-team pre-veto never appended override_requested, so the branch records the request
    // step itself right before override_applied.
    const proposal = buyProposal();
    appendDecisionStep(proposal, "override_requested");
    appendDecisionStep(proposal, "override_applied");
    expect(proposal.scorecard?.decisionChain).toEqual(["proposed", "override_requested", "override_applied"]);
    const { validateDecisionChain } = await import("../src/lib/db");
    expect(validateDecisionChain(proposal.scorecard?.decisionChain)).toEqual({ ok: true, problems: [] });
  });

  it("buildProposalScorecard preserves an accumulated chain", () => {
    const proposal = buyProposal();
    appendDecisionStep(proposal, "red_team_reject");
    appendDecisionStep(proposal, "override_requested");
    const scorecard = buildProposalScorecard({ proposal, decision: APPROVED, policy: policyWith() });
    expect(scorecard.decisionChain).toEqual(["proposed", "red_team_reject", "override_requested"]);
  });

  it("validateDecisionChain accepts valid chains and flags structural problems", async () => {
    const { validateDecisionChain } = await import("../src/lib/db");
    expect(validateDecisionChain(undefined).ok).toBe(true);
    expect(validateDecisionChain(["proposed", "final"]).ok).toBe(true);
    expect(validateDecisionChain(["proposed", "red_team_reject", "override_requested", "override_applied", "final"]).ok).toBe(true);
    expect(validateDecisionChain(["proposed", "override_applied"]).problems).toContain("override_applied_without_request");
    expect(validateDecisionChain(["proposed", "proposed"]).problems).toContain("repeated_step:proposed");
    expect(validateDecisionChain(["proposed", "nonsense"]).problems).toContain("unknown_step:nonsense");
    expect(validateDecisionChain("proposed").problems).toContain("not_an_array");
  });
});

describe("persistence round-trip", () => {
  it("the scorecard survives the trade_proposals JSON round trip unchanged", async () => {
    const { insertProposal, getProposal } = await import("../src/lib/db");
    const proposal = buyProposal({ referencePrice: 100, bracketStopLoss: 92, bracketTakeProfit: 118 });
    proposal.scorecard = buildProposalScorecard({
      proposal,
      decision: APPROVED,
      policy: policyWith({ secondaryBuyPullbackPct: 5 }),
      indicators: { sma50: 90, sma200: 80 }
    });
    const id = randomUUID();
    insertProposal({ userId: "local", id, runId: "run-1", accountNumber: "ACCT", proposal, decision: APPROVED, status: "proposed" });
    const row = getProposal(id, "local");
    expect(row?.proposal.scorecard).toEqual(proposal.scorecard);
  });

  it("a malformed chain logs an audit receipt but the proposal is still stored", async () => {
    const { insertProposal, getProposal, getDb } = await import("../src/lib/db");
    const proposal = buyProposal();
    proposal.scorecard = { decisionChain: ["override_applied"] as never };
    const id = randomUUID();
    insertProposal({ userId: "local", id, runId: "run-2", accountNumber: "ACCT", proposal, decision: APPROVED, status: "proposed" });
    const row = getProposal(id, "local");
    expect(row).toBeDefined(); // never thrown away
    expect(row?.proposal.scorecard?.decisionChain).toEqual(["override_applied"]);
    const receipts = getDb()
      .prepare("SELECT payload FROM audit_events WHERE kind = 'proposal_decision_chain_malformed'")
      .all() as Array<{ payload: string }>;
    expect(receipts.length).toBe(1);
    const payload = JSON.parse(receipts[0].payload) as { proposalId: string; problems: string[] };
    expect(payload.proposalId).toBe(id);
    expect(payload.problems).toContain("override_applied_without_request");
  });
});

describe("gradeSniperAccuracy", () => {
  const bars = [
    { date: "2026-08-03", close: 100 },
    { date: "2026-08-04", close: 91 },
    { date: "2026-08-05", close: 120 }
  ];

  it("grades a long's stop and take-profit against post-basis daily closes", () => {
    const receipt = gradeSniperAccuracy({ side: "buy", stopLoss: 92, takeProfit: 118, bars, basisDate: "2026-08-03" });
    expect(receipt).toEqual({ stopHit: true, takeProfitHit: true, priceBasis: "daily_close" });
  });

  it("reports honest false when neither level was reached", () => {
    const receipt = gradeSniperAccuracy({ side: "buy", stopLoss: 85, takeProfit: 130, bars, basisDate: "2026-08-03" });
    expect(receipt).toEqual({ stopHit: false, takeProfitHit: false, priceBasis: "daily_close" });
  });

  it("mirrors the breach directions for a short", () => {
    const receipt = gradeSniperAccuracy({ side: "short", stopLoss: 105, takeProfit: 95, bars, basisDate: "2026-08-03" });
    expect(receipt).toEqual({ stopHit: true, takeProfitHit: true, priceBasis: "daily_close" });
  });

  it("grades only one level when only one exists", () => {
    const receipt = gradeSniperAccuracy({ side: "buy", stopLoss: 92, bars, basisDate: "2026-08-03" });
    expect(receipt).toEqual({ stopHit: true, priceBasis: "daily_close" });
  });

  it("is undefined without levels or without post-basis bars — never fabricated", () => {
    expect(gradeSniperAccuracy({ side: "buy", bars, basisDate: "2026-08-03" })).toBeUndefined();
    expect(gradeSniperAccuracy({ side: "buy", stopLoss: 92, bars, basisDate: "2026-08-05" })).toBeUndefined();
    expect(gradeSniperAccuracy({ side: "buy", stopLoss: 92, bars: null, basisDate: "2026-08-03" })).toBeUndefined();
  });
});
