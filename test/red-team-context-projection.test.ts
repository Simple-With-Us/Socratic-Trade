import { describe, expect, it } from "vitest";
import {
  compactAdversaryContextForPersistence,
  parsePersistedAdversaryContext,
  projectRedTeamReviewContext,
  RED_TEAM_REVIEW_CONTEXT_KEYS,
  verifyRedTeamEvidenceParity
} from "../src/lib/red-team";
import { createEvidencePack } from "../src/lib/evidence-pack";

// `RedTeamReviewContext` documents a CURATED subset of the Green evidence: macro, limits,
// portfolio, scorecards, analogs and the candidates under review.  The run-time review projects
// the documented contract keys while dropping the full raw 40-symbol marketScan, the 20,000+ char
// full retrievedFinancialContext, allowedSymbols universe, and evidenceBudgetReceipts.
//
// Parity between the two stages is carried by `evidenceManifest.greenRedParityHash` and verified via
// `compareGreenRedParity` / `verifyRedTeamEvidenceParity`.

/** A Green userContent shaped like a real run: documented contract fields + massive Green-only bulk. */
function greenUserContent() {
  return {
    // ── documented reviewer contract ──
    currentDate: "2026-08-20",
    currentMarketRegime: "Tech-Bull",
    regimeSeverity: { severity: 0.31, inputsUsed: 6 },
    macroeconomicData: { cpiYoY: 2.4, fedFunds: 3.75, vixAsOf: "2026-09-18T12:00:00.000Z" },
    macroDerived: { curve2s10s: -0.12, vixTermStructure: 1.05 },
    macroTrends: { note: "trends", series: { VIX: { last: 18.2, d7: 1.5, spark: "▁▂▃▄" } } },
    marketSignals: { skew: 130, vvix: 90, marketBreadthPct: 48 },
    marketInternals: { advanceDeclineRatio: 1.4, newHighsLows: 32 },
    eventMarkets: { series: ["FED"], markets: ["Fed cut ~62%"] },
    predictionMarketsMacro: { markets: ["Recession 2026 Yes 18%"] },
    upcomingEconomicEvents: { events: [{ event: "CPI (YoY)", date: "2026-09-20" }] },
    limits: { maxOrderNotional: 5000, remainingDailyNotional: 12000 },
    drawdownAdvisory: { currentDrawdownPct: 1.2, maxAllowedPct: 10 },
    budgetAdvisory: { remainingDailyNotional: 12000, utilizationPct: 20 },
    strategyOverlays: { active: ["earnings-caution"] },
    socraticAuthority: { overrideMode: "off" },
    portfolio: { totalMarketValue: 100_000 },
    positions: [{ symbol: "AAPL", qty: 10 }],
    activeProtection: [{ symbol: "AAPL", stopPrice: 185 }],
    recentOrders: [{ id: "o1", symbol: "AAPL", side: "buy" }],
    sectorComposition: { Technology: 0.42 },
    thesisOutcomes: [{ tag: "momentum", winRate: 0.55 }],
    regimeOutcomes: [{ regime: "Tech-Bull", winRate: 0.6 }],
    comboOutcomes: [{ combo: "momentum/Tech-Bull", n: 18 }],
    sectorOutcomes: [{ sector: "Technology", winRate: 0.58 }],
    factorOutcomes: [{ factor: "momentum", ic: 0.07 }],
    signalEfficacy: [{ signal: "rsi", lift: 0.02 }],
    sourceValueScorecard: [{ source: "sec-filings", hitRate: 0.61 }],
    confidenceCalibration: { brierScore: 0.19, overconfidenceBias: -0.03 },
    skippedCounterfactuals: [{ symbol: "NVDA", missedReturnPct: 4.2 }],
    learnedContext: "fact:AAPL — supply chain diversified in FY26",
    reflectionSummary: "<reflection_summary>\nMomentum breakouts held in Tech-Bull.\n</reflection_summary>",
    closestHistoricalAnalogs: "2026-05-02 AAPL momentum entry, +2.1%",
    ownerCoaching: "Prefer liquid names near earnings.",
    topCandidates: [{ symbol: "AAPL", score: 0.84 }, { symbol: "MSFT", score: 0.79 }],
    redTeamEfficacy: { totalVetoes: 4, maturedVetoes: 3, savedLossRate: 0.67 },
    parityReceipt: { ok: true, greenHash: "b".repeat(64), redHash: "b".repeat(64), missingFromRed: [], extraInRed: [], mismatchedHashes: [] },
    evidenceManifest: { packHash: "a".repeat(64), greenRedParityHash: "b".repeat(64), refs: [{ id: "e1" }] },
    reviewerFilingsPack: "### RAG Dossier for AAPL\nItem 1A. Supply-chain risk.",
    // ── Green-only bulk the reviewer drops or slices ──
    marketScan: { topCandidates: Array.from({ length: 40 }, (_, i) => ({ sym: `SYM${i}`, news: "x".repeat(600) })) },
    retrievedFinancialContext: "R".repeat(36_000),
    allowedSymbols: Array.from({ length: 500 }, (_, i) => `SYM${i}`),
    evidenceBudgetReceipts: Array.from({ length: 40 }, (_, i) => ({ field: `f${i}`, originalCharacters: 5000, details: "d".repeat(200) })),
    executionMode: "broker",
    // A field that is genuinely absent this run must not appear as an explicit undefined.
    taxContext: undefined
  };
}

describe("projectRedTeamReviewContext", () => {
  it("keeps every documented contract key", () => {
    const green = { ...greenUserContent(), taxContext: { washSaleRestrictedSymbols: ["TSLA"] } };
    const projected = projectRedTeamReviewContext(green) as Record<string, unknown>;
    for (const key of RED_TEAM_REVIEW_CONTEXT_KEYS) {
      expect(projected, `documented key "${key}" must reach the reviewer`).toHaveProperty(key);
    }
  });

  it("drops the Green-only bulk the reviewer never needed", () => {
    const projected = projectRedTeamReviewContext(greenUserContent()) as Record<string, unknown>;
    for (const key of [
      "marketScan",
      "retrievedFinancialContext",
      "allowedSymbols",
      "evidenceBudgetReceipts",
      "executionMode"
    ]) {
      expect(projected, `"${key}" is Green-only and must not be re-sent per opening`).not.toHaveProperty(key);
    }
  });

  it("derives runner-up topCandidates from marketScan.topCandidates when topCandidates is not set directly", () => {
    const green = { ...greenUserContent(), topCandidates: undefined };
    const projected = projectRedTeamReviewContext(green);
    expect(Array.isArray(projected.topCandidates)).toBe(true);
    expect((projected.topCandidates as unknown[]).length).toBe(8);
  });

  it("preserves the parity manifest verbatim — that is what proves both stages saw one pack", () => {
    const green = greenUserContent();
    const projected = projectRedTeamReviewContext(green);
    expect(projected.evidenceManifest).toEqual(green.evidenceManifest);
  });

  it("omits absent fields rather than sending explicit undefined", () => {
    const projected = projectRedTeamReviewContext(greenUserContent()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(projected, "taxContext")).toBe(false);
    expect(projectRedTeamReviewContext({})).toEqual({});
  });

  it("cuts the per-review payload by an order of magnitude on a realistic evidence load", () => {
    const green = greenUserContent();
    const before = JSON.stringify(green).length;
    const after = JSON.stringify(projectRedTeamReviewContext(green)).length;
    // The saving multiplies: it is paid once per risk-adding opening, per run.
    expect(after).toBeLessThan(before / 10);
  });

  it("projects macroDerived, marketSignals, macroTrends, and event/calendar keys Green already has", () => {
    const green = greenUserContent();
    const projected = projectRedTeamReviewContext(green) as Record<string, unknown>;
    for (const key of [
      "macroDerived",
      "macroTrends",
      "marketSignals",
      "eventMarkets",
      "predictionMarketsMacro",
      "upcomingEconomicEvents"
    ]) {
      expect(projected, `regime key "${key}" must reach Red (2026-09-18 audit)`).toHaveProperty(key);
      expect(projected[key]).toEqual((green as Record<string, unknown>)[key]);
    }
  });

  it("compacts, persists, and parses adversaryContext with Zod .strip() while verifying Green/Red evidence parity", () => {
    const pack = createEvidencePack({
      decisionKey: "run-parity-test",
      evidence: []
    });
    const parity = verifyRedTeamEvidenceParity(pack, pack);
    expect(parity.matches).toBe(true);
    expect(parity.expectedParityHash).toBe(parity.actualParityHash);

    const raw = {
      ...projectRedTeamReviewContext(greenUserContent()),
      parityReceipt: parity,
      reviewerFilingsPack: "X".repeat(20_000),
      unexpectedInjectedKey: "must-be-stripped-by-zod"
    };
    const compacted = compactAdversaryContextForPersistence(raw);
    expect(compacted).toBeDefined();
    expect((compacted?.reviewerFilingsPack as string).length).toBeLessThanOrEqual(8_015);
    expect(compacted).not.toHaveProperty("unexpectedInjectedKey");

    const parsed = parsePersistedAdversaryContext({
      ...compacted,
      anotherUnknownField: 12345
    });
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty("anotherUnknownField");
    expect(parsed?.currentMarketRegime).toBe("Tech-Bull");
    expect(parsed?.parityReceipt).toEqual(parity);
  });
});
