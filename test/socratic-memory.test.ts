import { describe, expect, it } from "vitest";
import {
  buildSocraticMemoryDocument,
  fmpDerivedSocraticMemoryVectorId
} from "../src/lib/socratic-memory";
import type { SocraticDecisionCase } from "../src/lib/types";

describe("Socratic institutional memory documents", () => {
  it("derives the licensed provider identity with edge-safe SHA-256", async () => {
    await expect(fmpDerivedSocraticMemoryVectorId({ id: "case-1", userId: "u1" }, 3))
      .resolves.toBe(
        "fmp-derived-socratic:v1:9ecf2499f591755a3bc8ca29a428cd4ee583ba779a5619c3185124b6640c9cc6"
      );
  });

  it("maps a decision case into a dense RAG memory document", () => {
    const decision: SocraticDecisionCase = {
      id: "case-1",
      userId: "u1",
      connectedAccountId: "acct-1",
      runId: "run-1",
      proposalId: "proposal-1",
      createdAt: "2026-07-03T15:00:00.000Z",
      updatedAt: "2026-07-03T15:00:00.000Z",
      symbol: "AMD",
      side: "buy",
      status: "blocked",
      authority: "decide",
      thesis: "Flash crash selling is overdone.",
      rationale: "Cloud capex demand is intact. Red Team review — stale legacy objection text.",
      greenTeamRationale: "Cloud capex demand is intact and liquidity stress looks temporary.",
      action: "BUY AMD $50000",
      thesisTag: "Mean-Reversion",
      regime: "High-Vol",
      confidenceScore: 84,
      notional: 50_000,
      redTeamVerdict: {
        available: true,
        rejected: true,
        reason: "Inventory buildup in the latest filing weakens the rebound thesis.",
        model: "critic-model"
      },
      policyDecision: {
        approved: false,
        reasons: ["Daily notional limit exceeded."]
      },
      evidence: [
        {
          kind: "policy",
          title: "Policy block",
          summary: "Daily notional limit exceeded.",
          tone: "warning"
        }
      ],
      ragAttributions: [
        {
          symbol: "AMD",
          query: "AMD flash crash memory",
          source: "memory-rag",
          docType: "socratic-decision",
          score: 0.82,
          text: "Prior semiconductor rebound failed after inventory buildup.",
          contribution: "Prior AMD-like memory reduced confidence."
        }
      ],
      dissent: [],
      autonomyOverride: {
        requested: true,
        applied: false,
        thesis: "Crash rebound can justify overriding caps.",
        conflicts: ["Daily notional limit exceeded."]
      },
      lessons: ["Check inventory before buying chip selloffs."],
      coachNotes: ["Prefer a basket during broad semiconductor crashes."]
    };

    const document = buildSocraticMemoryDocument(decision);

    expect(document.metadata).toMatchObject({
      symbol: "AMD",
      source: "socratic-memory",
      doc_type: "socratic-decision",
      decision_id: "case-1",
      proposal_id: "proposal-1",
      final_action: "BLOCKED",
      side: "buy",
      thesis_tag: "Mean-Reversion",
      entry_market_regime: "High-Vol"
    });
    expect(document.text).toContain("broker_argument: Flash crash selling is overdone.");
    expect(document.text).toContain("Cloud capex demand is intact and liquidity stress looks temporary.");
    expect(document.text).not.toContain("stale legacy objection text");
    expect(document.text).toContain("critic_counter_argument: Inventory buildup");
    expect(document.text).toContain("policy_outcome: blocked: Daily notional limit exceeded.");
    expect(document.text).toContain("rag_contribution: memory-rag score=0.820");
    expect(document.text).toContain("coach_notes: Prefer a basket");
  });
});
