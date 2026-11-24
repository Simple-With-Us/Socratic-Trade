import { describe, expect, it } from "vitest";
import { deriveEvidenceRows, safeTopCandidates } from "../app/console/lib/evidence-rows";
import type { DashboardSnapshot } from "../app/dashboard-types";
import type { SocraticDecisionCase, TradeProposal } from "../src/lib/types";

describe("safeTopCandidates", () => {
  it("returns [] when scan is missing topCandidates (dashboard white-screen regression)", () => {
    // Mirrors the owner report: truthy latestScan without topCandidates → .slice threw.
    const partial = { source: "yahoo-finance", scannedSymbols: 10, returnedQuotes: 8 } as { topCandidates?: unknown };
    expect(safeTopCandidates(partial)).toEqual([]);
    expect(safeTopCandidates({})).toEqual([]);
    expect(safeTopCandidates(null)).toEqual([]);
    expect(safeTopCandidates(undefined)).toEqual([]);
    expect(safeTopCandidates({ topCandidates: undefined })).toEqual([]);
    expect(safeTopCandidates({ topCandidates: "not-an-array" })).toEqual([]);
  });

  it("keeps only candidates with a non-empty symbol string", () => {
    const result = safeTopCandidates({
      topCandidates: [
        { symbol: "AAPL", price: 100, volume: 1, intradayChangePct: 1, positionMarketValue: 0, score: 50 },
        { symbol: "  ", price: 1, volume: 1, intradayChangePct: 0, positionMarketValue: 0, score: 1 },
        { price: 1, volume: 1, intradayChangePct: 0, positionMarketValue: 0, score: 1 },
        null,
        { symbol: "MSFT", price: 200, volume: 2, intradayChangePct: -0.5, positionMarketValue: 0, score: 40 }
      ]
    });
    expect(result.map((c) => c.symbol)).toEqual(["AAPL", "MSFT"]);
  });

  it("supports empty arrays (valid scan with no candidates)", () => {
    expect(safeTopCandidates({ topCandidates: [] })).toEqual([]);
  });
});

describe("deriveEvidenceRows cross-contamination fix (ST-4648)", () => {
  it("uses the passed proposal #2..#N instead of cross-contaminating with proposal #0", () => {
    const proposal0 = {
      symbol: "NVDA",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      dollarAmount: 5000,
      rationale: "NVDA momentum thesis",
      tradeThesisTag: "momentum",
      entryMarketRegime: "Risk-On",
      proposedByModel: "claude-3-5-sonnet",
      redTeamVerdict: {
        available: true,
        model: "gpt-4o",
        reason: "NVDA valuation extended beyond reasonable forward multiple",
        rejected: true
      }
    } as unknown as TradeProposal;

    const proposal1 = {
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      dollarAmount: 3000,
      rationale: "AAPL breakout thesis",
      tradeThesisTag: "breakout",
      entryMarketRegime: "Risk-On",
      proposedByModel: "gemini-2.5-flash",
      redTeamVerdict: {
        available: true,
        model: "deepseek-r1",
        reason: "AAPL solid margin expansion and capital return",
        rejected: false
      }
    } as unknown as TradeProposal;

    const proposal2 = {
      symbol: "MSFT",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      dollarAmount: 4000,
      rationale: "MSFT cloud growth thesis",
      tradeThesisTag: "growth",
      entryMarketRegime: "Risk-On",
      proposedByModel: "o3-mini",
      redTeamVerdict: {
        available: true,
        model: "claude-3-7-sonnet",
        reason: "MSFT enterprise AI monetization confirmed",
        rejected: false
      }
    } as unknown as TradeProposal;

    const snapshot = {
      pendingProposals: [
        { id: "p-0", proposal: proposal0 },
        { id: "p-1", proposal: proposal1 },
        { id: "p-2", proposal: proposal2 }
      ]
    } as unknown as DashboardSnapshot;

    // When rendering Proposal #1, pass proposal1:
    const rows1 = deriveEvidenceRows(snapshot, undefined, undefined, proposal1);
    const modelRow1 = rows1.find((r) => r.title === "Model attribution");
    const redRow1 = rows1.find((r) => r.title === "Adversarial review");

    expect(modelRow1?.meta).toBe("gemini-2.5-flash");
    expect(modelRow1?.meta).not.toBe("claude-3-5-sonnet");
    expect(redRow1?.meta).toBe("deepseek-r1");
    expect(redRow1?.meta).not.toBe("gpt-4o");
    expect(redRow1?.body).toBe("AAPL solid margin expansion and capital return");
    expect(redRow1?.tone).toBe("warn"); // not rejected -> warn

    // When rendering Proposal #2, pass proposal2:
    const rows2 = deriveEvidenceRows(snapshot, undefined, undefined, proposal2);
    const modelRow2 = rows2.find((r) => r.title === "Model attribution");
    const redRow2 = rows2.find((r) => r.title === "Adversarial review");

    expect(modelRow2?.meta).toBe("o3-mini");
    expect(modelRow2?.meta).not.toBe("claude-3-5-sonnet");
    expect(redRow2?.meta).toBe("claude-3-7-sonnet");
    expect(redRow2?.meta).not.toBe("gpt-4o");
    expect(redRow2?.body).toBe("MSFT enterprise AI monetization confirmed");
  });

  it("falls back to proposal #0 when proposal argument is omitted (backwards compatibility)", () => {
    const proposal0 = {
      symbol: "NVDA",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      dollarAmount: 5000,
      rationale: "NVDA thesis",
      tradeThesisTag: "momentum",
      entryMarketRegime: "Risk-On",
      proposedByModel: "claude-3-5-sonnet",
      redTeamVerdict: {
        available: true,
        model: "gpt-4o",
        reason: "NVDA risk note",
        rejected: true
      }
    } as unknown as TradeProposal;

    const snapshot = {
      pendingProposals: [{ id: "p-0", proposal: proposal0 }]
    } as unknown as DashboardSnapshot;

    const rows = deriveEvidenceRows(snapshot, undefined, undefined, undefined);
    const modelRow = rows.find((r) => r.title === "Model attribution");
    const redRow = rows.find((r) => r.title === "Adversarial review");

    expect(modelRow?.meta).toBe("claude-3-5-sonnet");
    expect(redRow?.meta).toBe("gpt-4o");
    expect(redRow?.tone).toBe("neg"); // rejected -> neg
  });

  it("formats adversarial review failure accurately without blaming unrun fallbacks", () => {
    const proposal = {
      symbol: "GOOGL",
      side: "buy",
      type: "limit",
      timeInForce: "gfd",
      marketHours: "regular_hours",
      dollarAmount: 2500,
      rationale: "Search defensibility",
      tradeThesisTag: "moat",
      entryMarketRegime: "Risk-On",
      proposedByModel: "gemini-2.5-pro",
      redTeamVerdict: {
        available: false,
        rejected: false,
        model: "deepseek-r1",
        failureKind: "timeout",
        reason: "Review provider timed out after 30000ms"
      }
    } as unknown as TradeProposal;

    const snapshot = { pendingProposals: [] } as unknown as DashboardSnapshot;
    const rows = deriveEvidenceRows(snapshot, undefined, undefined, proposal);
    const failureRow = rows.find((r) => r.title === "Adversarial review FAILED");

    expect(failureRow).toBeDefined();
    expect(failureRow?.meta).toContain("deepseek-r1");
    expect(failureRow?.meta).toContain("timeout");
    expect(failureRow?.body).toBe("Review provider timed out after 30000ms");
    expect(failureRow?.tone).toBe("warn");
  });

  it("appends per-proposal model attribution and red-team review when a decision is present", () => {
    const decision = {
      evidence: [
        { title: "CPI Print", kind: "macro", summary: "Headline CPI rose 0.1% MoM.", tone: "positive", source: "bls" },
        { title: "Bond Yields", kind: "rates", summary: "10y Treasury fell 6 bps.", tone: "positive", source: "treasury" }
      ],
      ragAttributions: [
        { contribution: "FOMC minutes highlight balance sheet flexibility.", docType: "fomc_minutes", score: 0.88, source: "sec" }
      ]
    } as unknown as SocraticDecisionCase;

    const proposalA = {
      symbol: "NVDA",
      side: "buy",
      dollarAmount: 5000,
      proposedByModel: "claude-3-7-sonnet",
      redTeamVerdict: {
        available: true,
        model: "deepseek-r1",
        reason: "NVDA datacenter supply chain execution confirmed.",
        rejected: false
      }
    } as unknown as TradeProposal;

    const proposalB = {
      symbol: "AMD",
      side: "buy",
      dollarAmount: 4000,
      proposedByModel: "gemini-2.5-pro",
      redTeamVerdict: {
        available: true,
        model: "o3-mini",
        reason: "AMD client segment valuation headwinds.",
        rejected: true
      }
    } as unknown as TradeProposal;

    const snapshot = {
      latestScan: null,
      pendingProposals: []
    } as unknown as DashboardSnapshot;

    const rowsA = deriveEvidenceRows(snapshot, undefined, decision, proposalA);
    const rowsB = deriveEvidenceRows(snapshot, undefined, decision, proposalB);

    // Both retain decision evidence rows:
    expect(rowsA.some((r) => r.title === "CPI Print")).toBe(true);
    expect(rowsB.some((r) => r.title === "CPI Print")).toBe(true);

    // Proposal A receives its own model and red team attribution:
    const modelA = rowsA.find((r) => r.title === "Model attribution");
    const redA = rowsA.find((r) => r.title === "Adversarial review");
    expect(modelA?.meta).toBe("claude-3-7-sonnet");
    expect(redA?.meta).toBe("deepseek-r1");
    expect(redA?.tone).toBe("warn");

    // Proposal B receives its own model and red team attribution:
    const modelB = rowsB.find((r) => r.title === "Model attribution");
    const redB = rowsB.find((r) => r.title === "Adversarial review");
    expect(modelB?.meta).toBe("gemini-2.5-pro");
    expect(redB?.meta).toBe("o3-mini");
    expect(redB?.tone).toBe("neg");
  });
});
