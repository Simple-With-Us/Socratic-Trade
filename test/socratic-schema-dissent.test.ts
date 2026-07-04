import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Wave-3 schema & dissent (composite review B/high + A/high, 2026-07-05):
//   1. Socratic first-class Bull fields ROUND-TRIP the Bear's strict schema (the confidenceScore
//      regression pattern: additionalProperties:false silently strips any unlisted field).
//   2. The Red Team verdict is structured on BOTH adversary paths (debate + inline Bear).
//   3. Bear removed[] entries persist as Socratic cases with status 'vetoed'.
//   4. Non-actions: passedOn[] cases and the run-level 'waited' case.
//   5. The debate transcript is immutable and the Bull rationale is no longer mutated in place.

vi.mock("../src/lib/vector-db", () => ({
  retrieveContext: async () => [],
  retrieveContextDetailed: async () => [],
  defaultMinScore: () => 0.3,
  defaultRelevanceFloor: () => 0.3,
  defaultDedupeSimilarity: () => 0.6,
  formatChunkWithProvenance: (chunk: { text: string }) => chunk.text,
  storeContext: async () => {},
  storeContexts: async () => ({ attempted: 1, indexed: 1 })
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-w3-schema-${randomUUID()}.db`)}`;
});

const SOCRATIC_FIELD_KEYS = [
  "belief",
  "iMayBeWrongIf",
  "reversalTriggers",
  "evidenceRefs",
  "usedEvidence",
  "strongestCounterRead"
] as const;

type SchemaObject = {
  required: string[];
  properties: Record<string, { required?: string[]; properties?: Record<string, unknown>; items?: SchemaObject } & Record<string, unknown>>;
};

function bullItem(schema: Record<string, unknown>): SchemaObject {
  return (schema as SchemaObject).properties.proposals.items as unknown as SchemaObject;
}

describe("1. Bull->Bear schema round-trip (confidenceScore regression pattern)", () => {
  it("every Bull item property is present AND required in the Bear item schema", async () => {
    const { buildBullProposalSchema, buildBearReviewSchema } = await import("../src/lib/strategy");
    const bull = bullItem(buildBullProposalSchema(["buy", "sell"], 3));
    const bear = bullItem(buildBearReviewSchema(["buy", "sell"]));

    for (const key of Object.keys(bull.properties)) {
      expect(bear.properties, `Bear schema is missing Bull field '${key}' — strict output would silently strip it`).toHaveProperty(key);
      expect(bear.required, `Bear schema does not require Bull field '${key}' — the model may drop it`).toContain(key);
    }
    // The named regression: confidenceScore and each new Socratic field, explicitly.
    for (const key of ["confidenceScore", ...SOCRATIC_FIELD_KEYS]) {
      expect(bull.required).toContain(key);
      expect(bear.required).toContain(key);
    }
  });

  it("the Bull top level requires passedOn (cap 5) and the Bear top level requires proposals+removed", async () => {
    const { buildBullProposalSchema, buildBearReviewSchema } = await import("../src/lib/strategy");
    const bull = buildBullProposalSchema(["buy", "sell"], 3) as SchemaObject;
    const bear = buildBearReviewSchema(["buy", "sell"]) as SchemaObject;
    expect(bull.required).toEqual(expect.arrayContaining(["proposals", "passedOn"]));
    expect((bull.properties.passedOn as { maxItems?: number }).maxItems).toBe(5);
    expect(bear.required).toEqual(expect.arrayContaining(["proposals", "removed"]));
    const removedItem = (bear.properties.removed as { items: SchemaObject }).items;
    expect(removedItem.required).toEqual(expect.arrayContaining(["symbol", "side", "reason", "severity"]));
  });

  it("sanitizeProposals preserves and bounds the new Socratic fields (null -> undefined)", async () => {
    const { sanitizeProposals } = await import("../src/lib/strategy");
    const [p] = sanitizeProposals(
      [
        {
          symbol: "aapl",
          side: "buy",
          type: "market",
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: "r",
          tradeThesisTag: "Momentum-Breakout",
          entryMarketRegime: "Neutral",
          confidenceScore: 70,
          belief: "  AI capex supercycle persists.  ",
          iMayBeWrongIf: ["Hyperscaler capex guides down", "", 42 as unknown as string],
          reversalTriggers: [
            { condition: "VIX spikes above 25", metric: "VIX", level: 25 },
            { condition: "Breaks support", metric: null as unknown as string, level: null as unknown as number },
            { condition: "" }
          ],
          evidenceRefs: ["chunk:abc", "fcf"],
          usedEvidence: [
            { ref: "chunk:abc", effect: "changed_view", why: "Guidance raise" },
            { ref: "senateNet", effect: "ignored", why: null as unknown as string },
            { ref: "bad", effect: "nonsense" as "used", why: "x" }
          ],
          strongestCounterRead: "Valuation is stretched; multiple compression risk.",
          autonomyOverride: null as unknown as undefined
        }
      ],
      3
    );
    expect(p.belief).toBe("AI capex supercycle persists.");
    expect(p.iMayBeWrongIf).toEqual(["Hyperscaler capex guides down"]);
    expect(p.reversalTriggers).toEqual([
      { condition: "VIX spikes above 25", metric: "VIX", level: 25 },
      { condition: "Breaks support" }
    ]);
    expect(p.evidenceRefs).toEqual(["chunk:abc", "fcf"]);
    expect(p.usedEvidence).toEqual([
      { ref: "chunk:abc", effect: "changed_view", why: "Guidance raise" },
      { ref: "senateNet", effect: "ignored" }
    ]);
    expect(p.strongestCounterRead).toContain("Valuation is stretched");
  });
});

describe("2. Structured Red Team verdict on both adversary paths", () => {
  it("RED_TEAM_VERDICT_SCHEMA carries the full structured-dissent contract", async () => {
    const { RED_TEAM_VERDICT_SCHEMA } = await import("../src/lib/red-team");
    const schema = RED_TEAM_VERDICT_SCHEMA as SchemaObject;
    for (const key of ["verdict", "keyRisks", "invalidationTriggers", "suggestedChange", "wouldApproveIf", "confidence", "reason"]) {
      expect(schema.properties).toHaveProperty(key);
      expect(schema.required).toContain(key);
    }
    expect((schema.properties.verdict as { enum: string[] }).enum).toEqual(["approve", "approve_with_changes", "reject"]);
  });

  it("the inline Bear item schema requires the same structured verdict per survivor", async () => {
    const { buildBearReviewSchema } = await import("../src/lib/strategy");
    const bearItem = bullItem(buildBearReviewSchema(["buy", "sell"]));
    expect(bearItem.required).toContain("bearVerdict");
    const verdict = bearItem.properties.bearVerdict as SchemaObject;
    for (const key of ["verdict", "keyRisks", "invalidationTriggers", "suggestedChange", "wouldApproveIf", "confidence", "reason"]) {
      expect(verdict.required).toContain(key);
    }
  });

  it("normalizeRedTeamVerdict maps verdicts, clamps confidence, and tolerates the legacy boolean", async () => {
    const { normalizeRedTeamVerdict } = await import("../src/lib/red-team");
    const full = normalizeRedTeamVerdict(
      {
        verdict: "approve_with_changes",
        keyRisks: ["Crowded trade"],
        invalidationTriggers: [{ condition: "VIX above 25", metric: "VIX", level: 25 }],
        suggestedChange: { sizeMultiplier: 0.5 },
        wouldApproveIf: "Size halved",
        confidence: 250,
        reason: "Too large for the regime."
      },
      "test-model"
    );
    expect(full.rejected).toBe(false);
    expect(full.verdict).toBe("approve_with_changes");
    expect(full.confidence).toBe(100);
    expect(full.suggestedChange).toEqual({ sizeMultiplier: 0.5 });

    const legacyReject = normalizeRedTeamVerdict({ rejected: true, reason: "flaw" });
    expect(legacyReject.rejected).toBe(true);
    expect(legacyReject.verdict).toBe("reject");

    const unrecognized = normalizeRedTeamVerdict({});
    expect(unrecognized.available).toBe(false);
    expect(unrecognized.rejected).toBe(false);
  });
});

describe("3+5. Debate annotation: verdict persisted, rationale untouched, transcript immutable", () => {
  const baseProposal = () => ({
    symbol: "AAPL",
    side: "buy" as const,
    type: "market" as const,
    timeInForce: "gfd" as const,
    marketHours: "regular_hours" as const,
    rationale: "Original bull thesis.",
    tradeThesisTag: "Momentum-Breakout",
    entryMarketRegime: "Neutral",
    confidenceScore: 85,
    belief: "Earnings momentum continues.",
    proposedByModel: "gpt-test"
  });

  it("annotateProposalWithDebate writes reviewNotes + transcript and NEVER appends to rationale", async () => {
    const { annotateProposalWithDebate } = await import("../src/lib/socratic-runtime");
    const proposal = baseProposal();
    annotateProposalWithDebate(
      proposal,
      {
        rejected: false,
        available: true,
        reason: "Thesis holds; watch the stop.",
        model: "bear-model",
        verdict: "approve_with_changes",
        keyRisks: ["Earnings gap risk"],
        invalidationTriggers: [{ condition: "Breaks 200", metric: "price", level: 200 }],
        suggestedChange: { sizeMultiplier: 0.5, stopPrice: 195 },
        wouldApproveIf: "Half size",
        confidence: 70,
        usage: { promptTokens: 900, completionTokens: 120 }
      },
      "confidence"
    );
    expect(proposal.rationale).toBe("Original bull thesis.");
    expect(proposal.rationale).not.toContain("Red Team Debate Survived");
    expect(proposal.reviewNotes?.[0]).toContain("Red Team debate survived (approve_with_changes)");
    // suggestedChange lands as an ADVISORY receipt — never applied to the proposal itself.
    expect(proposal.reviewNotes?.[1]).toContain("ADVISORY");
    expect(proposal.stopPrice).toBeUndefined();
    expect(proposal.dollarAmount).toBeUndefined();
    expect(proposal.redTeamVerdict).toMatchObject({
      rejected: false,
      available: true,
      verdict: "approve_with_changes",
      trigger: "confidence",
      keyRisks: ["Earnings gap risk"],
      suggestedChange: { sizeMultiplier: 0.5, stopPrice: 195 },
      confidence: 70
    });
    expect(proposal.debateTranscript).toMatchObject({
      bullThesis: "Original bull thesis.",
      bullBelief: "Earnings momentum continues.",
      bearResponse: "Thesis holds; watch the stop.",
      trigger: "confidence"
    });
    expect(proposal.debateTranscript?.sides).toEqual([
      { role: "bull", model: "gpt-test" },
      { role: "bear", model: "bear-model", promptTokens: 900, completionTokens: 120 }
    ]);
  });

  it("the persisted debate transcript survives case updates unchanged (immutability)", async () => {
    const { buildSocraticDecisionCase } = await import("../src/lib/socratic-runtime");
    const { annotateProposalWithDebate } = await import("../src/lib/socratic-runtime");
    const { upsertSocraticDecisionCase, getSocraticDecisionCase, appendSocraticDecisionCoachNote } = await import("../src/lib/db");
    const proposal = baseProposal();
    annotateProposalWithDebate(proposal, { rejected: false, available: true, reason: "Survives.", model: "bear-model", verdict: "approve" }, "live_opening");
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const caseFile = {
      ...buildSocraticDecisionCase({
        userId: "u-w3",
        runId: "run-w3",
        proposalId,
        proposal,
        status: "placed",
        authority: "decide",
        decision: { approved: true, reasons: [] }
      }),
      createdAt: now,
      updatedAt: now
    };
    upsertSocraticDecisionCase(caseFile);
    const before = getSocraticDecisionCase(proposalId, "u-w3");
    expect(before?.debateTranscript?.bearResponse).toBe("Survives.");
    expect(before?.belief).toBe("Earnings momentum continues.");
    expect(before?.reviewNotes?.[0]).toContain("Red Team debate survived");

    appendSocraticDecisionCoachNote(proposalId, "Coach: good discipline.", "u-w3");
    const after = getSocraticDecisionCase(proposalId, "u-w3");
    expect(after?.coachNotes).toContain("Coach: good discipline.");
    expect(after?.debateTranscript).toEqual(before?.debateTranscript);
    expect(after?.belief).toBe(before?.belief);
    expect(after?.rationale).toBe("Original bull thesis.");
  });
});

describe("3. Vetoed cases + 4. non-action cases persist and index", () => {
  it("a 'vetoed' case persists via buildSocraticDecisionCase and reads back with status vetoed", async () => {
    const { buildSocraticDecisionCase } = await import("../src/lib/socratic-runtime");
    const { upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const proposalId = randomUUID();
    const now = new Date().toISOString();
    const caseFile = {
      ...buildSocraticDecisionCase({
        userId: "u-w3",
        runId: "run-veto",
        proposalId,
        proposal: {
          symbol: "TSLA",
          side: "buy",
          type: "market",
          timeInForce: "gfd",
          marketHours: "regular_hours",
          rationale: "Momentum entry.",
          tradeThesisTag: "Momentum-Breakout",
          entryMarketRegime: "Risk-Off",
          confidenceScore: 66,
          belief: "Squeeze continues."
        },
        status: "vetoed",
        authority: "decide",
        decision: { approved: false, reasons: ["Red Team (inline Bear) veto [severity=high]: Overextended into a risk-off tape."] }
      }),
      createdAt: now,
      updatedAt: now
    };
    upsertSocraticDecisionCase(caseFile);
    const persisted = getSocraticDecisionCase(proposalId, "u-w3");
    expect(persisted?.status).toBe("vetoed");
    expect(persisted?.policyDecision?.reasons[0]).toContain("severity=high");
    expect(persisted?.belief).toBe("Squeeze continues.");
  });

  it("passed + waited non-action cases persist with deterministic ids and read back", async () => {
    const { buildSocraticNonActionCase } = await import("../src/lib/socratic-runtime");
    const { upsertSocraticDecisionCase, getSocraticDecisionCase } = await import("../src/lib/db");
    const now = new Date().toISOString();

    const passed = {
      ...buildSocraticNonActionCase({
        userId: "u-w3",
        runId: "run-na",
        kind: "passed",
        symbol: "nvda",
        reason: "Already at sector exposure cap; no incremental edge.",
        wouldReconsiderIf: "Sector exposure drops below 20%.",
        regime: "Neutral",
        authority: "decide"
      }),
      createdAt: now,
      updatedAt: now
    };
    upsertSocraticDecisionCase(passed);
    const passedBack = getSocraticDecisionCase(passed.id, "u-w3");
    expect(passedBack?.status).toBe("passed");
    expect(passedBack?.symbol).toBe("NVDA");
    expect(passedBack?.wouldReconsiderIf).toContain("drops below 20%");

    const waited = {
      ...buildSocraticNonActionCase({
        id: "run-na",
        userId: "u-w3",
        runId: "run-na",
        kind: "waited",
        reason: "model-declined: the strategy model reviewed the evidence and proposed nothing.",
        regime: "Neutral",
        authority: "decide"
      }),
      createdAt: now,
      updatedAt: now
    };
    upsertSocraticDecisionCase(waited);
    const waitedBack = getSocraticDecisionCase("run-na", "u-w3");
    expect(waitedBack?.status).toBe("waited");
    expect(waitedBack?.action).toBe("WAITED");
    expect(waitedBack?.rationale).toContain("model-declined");
  });

  it("the memory vector text renders the new Socratic fields for retrieval", async () => {
    const { buildSocraticMemoryDocument } = await import("../src/lib/socratic-memory");
    const now = new Date().toISOString();
    const doc = buildSocraticMemoryDocument({
      id: "case-1",
      userId: "u-w3",
      createdAt: now,
      updatedAt: now,
      symbol: "AAPL",
      side: "buy",
      status: "placed",
      authority: "decide",
      thesis: "Momentum-Breakout",
      rationale: "Bull thesis.",
      action: "BUY AAPL $1,000",
      evidence: [],
      ragAttributions: [],
      dissent: [],
      lessons: [],
      coachNotes: [],
      belief: "Earnings momentum continues.",
      iMayBeWrongIf: ["Guide-down"],
      reversalTriggers: [{ condition: "VIX above 25", metric: "VIX", level: 25 }],
      evidenceRefs: ["chunk:abc"],
      usedEvidence: [{ ref: "chunk:abc", effect: "changed_view", why: "guidance" }],
      strongestCounterRead: "Multiple compression risk.",
      reviewNotes: ["Red Team debate survived: fine."],
      debateTranscript: {
        bullThesis: "Bull thesis.",
        bearResponse: "Fine.",
        trigger: "confidence",
        sides: [{ role: "bull" }, { role: "bear", model: "bear-model" }],
        at: now
      },
      redTeamVerdict: { rejected: false, available: true, reason: "fine", keyRisks: ["gap risk"] }
    });
    expect(doc.text).toContain("belief: Earnings momentum continues.");
    expect(doc.text).toContain("i_may_be_wrong_if: Guide-down");
    expect(doc.text).toContain("reversal_triggers: VIX above 25 [VIX @ 25]");
    expect(doc.text).toContain("evidence_refs: chunk:abc");
    expect(doc.text).toContain("used_evidence: chunk:abc=changed_view (guidance)");
    expect(doc.text).toContain("strongest_counter_read: Multiple compression risk.");
    expect(doc.text).toContain("key_risks: gap risk");
    expect(doc.text).toContain("debate: trigger=confidence");
  });
});
