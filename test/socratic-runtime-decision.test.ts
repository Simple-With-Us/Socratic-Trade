import { describe, expect, it } from "vitest";
import { buildSocraticDecisionCase, ragAttributionsFromChunks, type SocraticOverrideResolution } from "../src/lib/socratic-runtime";
import { stableRagEvidenceRef } from "../src/lib/rag/evidence-consumption";
import type { PolicyDecision, TradeProposal } from "../src/lib/types";

const proposal: TradeProposal = {
  symbol: "EXE",
  side: "buy",
  type: "market",
  dollarAmount: 4.6,
  timeInForce: "gfd",
  marketHours: "regular_hours",
  rationale: "Value-quality setup.",
  tradeThesisTag: "Value Quality",
  entryMarketRegime: "Neutral",
  redTeamVerdict: {
    verdict: "reject",
    rejected: true,
    available: true,
    reason: "The catalyst is too weak.",
    overridden: true
  },
  autonomyOverride: {
    requested: true,
    thesis: "The valuation cushion warrants a small exploratory entry.",
    preferenceConflicts: ["red_team_veto: The catalyst is too weak."]
  }
};

function caseFor(decision: PolicyDecision, overrideResolution: SocraticOverrideResolution) {
  return buildSocraticDecisionCase({
    userId: "u1",
    runId: "run-1",
    proposalId: "proposal-1",
    proposal,
    status: decision.approved ? "placed" : "blocked",
    authority: "decide",
    decision,
    overrideResolution
  });
}

describe("Socratic Red Team dissent receipts", () => {
  it("does not call a requested override applied when a later hard gate refuses it", () => {
    const decision: PolicyDecision = { approved: false, reasons: ["Buying power is insufficient."] };
    const result = caseFor(decision, {
      requested: true,
      applied: false,
      routeToHuman: false,
      conflicts: ["red_team_veto: The catalyst is too weak."],
      hardReasons: ["Buying power is insufficient."],
      decision
    });

    expect(result.dissent[0]).toMatchObject({
      title: "Red Team rejection",
      summary: "The catalyst is too weak.",
      tone: "negative"
    });
  });

  it("calls the objection overridden only when the final resolution applied it", () => {
    const decision: PolicyDecision = {
      approved: true,
      reasons: [],
      socraticOverride: {
        applied: true,
        mode: "execute",
        conflicts: ["red_team_veto: The catalyst is too weak."],
        thesis: "The valuation cushion warrants a small exploratory entry."
      }
    };
    const result = caseFor(decision, {
      requested: true,
      applied: true,
      routeToHuman: false,
      conflicts: ["red_team_veto: The catalyst is too weak."],
      hardReasons: [],
      decision
    });

    expect(result.dissent[0]?.title).toBe("Red Team rejection (overridden)");
    expect(result.dissent[0]?.summary).toContain("trade allowed to proceed");
  });
});

describe("Socratic RAG attribution identity", () => {
  it("matches the prompt-consumption ref for an id-less chunk with immutable coordinates", () => {
    const chunk = {
      id: "",
      text: "Revenue grew.",
      score: 0.91,
      relevanceScore: 0.83,
      source: "sec-edgar",
      doc_type: "10-k",
      section: "MD&A",
      url: "https://www.sec.gov/example",
      as_of: "2026-02-01T00:00:00.000Z",
      scope: "shared" as const,
      metadata: {
        accession: "0001",
        chunk_ordinal: 7,
        content_hash: "content-hash",
        vector_namespace: "managed",
        tenant_scope: "tenant:shared"
      }
    };

    const expectedRef = stableRagEvidenceRef({
      symbol: "AAPL",
      source: "sec-edgar",
      docType: "10-k",
      accession: "0001",
      section: "MD&A",
      ordinal: 7,
      contentHash: "content-hash",
      vectorNamespace: "managed",
      scope: "shared",
      tenantScope: "tenant:shared",
      title: "MD&A",
      url: "https://www.sec.gov/example",
      publishedAt: "2026-02-01T00:00:00.000Z",
      score: 0.91,
      relevanceScore: 0.83
    });

    expect(ragAttributionsFromChunks("aapl", "revenue", [chunk])[0]?.evidenceRef).toBe(expectedRef);
  });
});
