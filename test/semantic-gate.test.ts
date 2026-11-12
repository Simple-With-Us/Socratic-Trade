// Tests for the SECOND-LAYER learned-context classifier: the semantic gate + templated-fact allowlist
// (src/lib/learned-context/semantic-gate.ts) and its async integration through ingestLearned
// (src/lib/learned-context/store.ts).
//
// The gate is STRICTLY ADDITIVE. These tests pin the four invariants that make it safe:
//   1. It UPGRADES keyword-dodging paraphrases (keyword 'fact') to 'risk' when the LLM says 'risk'.
//   2. It NEVER spends an LLM call on a templated fact or on a keyword-flagged risk (call-count = 0).
//   3. It FAILS SAFE: an LLM that throws falls back to the keyword result ('fact' stays 'fact').
//   4. With the flag OFF it never calls the LLM — behavior is keyword + allowlist only.
// Plus an end-to-end ingest check: an autonomous candidate the gate upgrades lands in the PENDING
// queue (human confirmation), not the advisory fact store.
// Plus the P0-1 provenance bypass (2026-09-27): a candidate stamped `provenance: "system-postmortem"`
// skips the LLM layer and lands in the brain, while the keyword layer, the PII gate, and the gate for
// every unmarked candidate are all unchanged.
//
// All offline: we inject a deterministic, call-counting MockLLM (the same injectable-LLM approach the
// chat tests use) so no API key or network is touched.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, listLearnedContext, listPendingLearnedContext } from "../src/lib/db";
import { classifyRiskTier } from "../src/lib/learned-context/classify";
import { classifyWithSemanticGate, matchesTemplatedFact } from "../src/lib/learned-context/semantic-gate";
import { ingestLearned } from "../src/lib/learned-context/store";
import type { ChatLLM, LlmResult } from "../src/lib/chat/types";
import type { LearnedContextCandidate } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/semantic-gate-test-${Date.now()}.db`;
  getDb();
});

// Default the flag ON for this suite; individual tests override as needed and beforeEach restores it.
beforeEach(() => {
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";
});
afterEach(() => {
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";
});

/**
 * Deterministic, call-counting LLM stand-in. `verdict`:
 *   - "risk"/"fact" → returns the strict JSON the gate parses.
 *   - "garbage"     → returns unparseable text (exercises the fail-safe).
 *   - "throw"       → throws (exercises the LLM-unavailable fail-safe).
 */
class CountingMockLLM implements ChatLLM {
  public calls = 0;
  constructor(private verdict: "risk" | "fact" | "garbage" | "throw") {}
  async run(): Promise<LlmResult> {
    this.calls += 1;
    if (this.verdict === "throw") throw new Error("LLM unavailable");
    if (this.verdict === "garbage") return { text: "I think maybe this could be risky?", toolCalls: [], citations: [] };
    return { text: `{"tier":"${this.verdict}"}`, toolCalls: [], citations: [] };
  }
}

const cand = (overrides: Partial<LearnedContextCandidate>): LearnedContextCandidate => ({
  kind: "pattern",
  subject: "obs",
  value: "",
  ...overrides
});

// Keyword-DODGING paraphrases: classifyRiskTier returns 'fact' for these (no blocklist hit), yet they
// clearly touch risk tolerance / sizing — exactly what the semantic gate must catch. (Each is asserted
// to be keyword-'fact' first, so the gate's LLM call is genuinely the thing being exercised.)
const PARAPHRASES = [
  "comfortable with much bigger swings now",
  "let the winners run a good while longer",
  "no need to be cautious on this one"
];

describe("semantic gate — UPGRADES keyword-dodging paraphrases to 'risk'", () => {
  for (const phrase of PARAPHRASES) {
    it(`"${phrase}" → 'risk' when the LLM says risk`, async () => {
      // Guard: prove the KEYWORD layer alone misses this (returns 'fact') — so the upgrade to 'risk'
      // is genuinely the semantic gate's doing, not the blocklist's.
      expect(classifyRiskTier(cand({ subject: "tone", value: phrase, intent: phrase }))).toBe("fact");
      const llm = new CountingMockLLM("risk");
      const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: phrase, intent: phrase }), { llm });
      expect(tier).toBe("risk");
      expect(llm.calls).toBe(1); // the gate DID consult the LLM for this non-allowlisted fact
    });
  }

  it("keeps 'fact' when the LLM says fact (no spurious upgrade)", async () => {
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "obs", value: "the CEO has been in the role 12 years" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1);
  });
});

describe("templated-fact ALLOWLIST — definitively 'fact', LLM NOT called", () => {
  const TEMPLATED = [
    { subject: "fact:ASML", value: "ASML is the sole EUV supplier" },
    { subject: "fact:NVDA", value: "NVDA is in the S&P 500" },
    { subject: "fact:AAPL", value: "AAPL is a member of the Nasdaq 100" },
    { subject: "fact:MSFT", value: "MSFT reports earnings on the 24th" },
    { subject: "fact:TSLA", value: "TSLA is headquartered in Austin" }
  ];
  for (const t of TEMPLATED) {
    it(`"${t.value}" → 'fact' WITHOUT an LLM call`, async () => {
      expect(matchesTemplatedFact(cand(t))).toBe(true);
      const llm = new CountingMockLLM("risk"); // even if the LLM WOULD say risk, it must not be consulted
      const tier = await classifyWithSemanticGate(cand(t), { llm });
      expect(tier).toBe("fact");
      expect(llm.calls).toBe(0);
    });
  }
});

describe("keyword-flagged RISK — short-circuits, LLM NOT called", () => {
  it('"back up the truck on tech" → \'risk\' without consulting the LLM', async () => {
    const llm = new CountingMockLLM("fact"); // even a 'fact' verdict must NOT downgrade a keyword risk
    const tier = await classifyWithSemanticGate(
      cand({ subject: "tech", value: "back up the truck on tech", intent: "back up the truck on tech" }),
      { llm }
    );
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });

  it("a numeric sizing knob ('raise to 30%') stays 'risk' without an LLM call", async () => {
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "max_position", value: "raise to 30%" }), { llm });
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });
});

describe("FAIL-SAFE — LLM error/garbage falls back to the keyword result", () => {
  it("LLM throws → falls back to keyword 'fact' (ingestion NOT blocked)", async () => {
    const llm = new CountingMockLLM("throw");
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "comfortable with much bigger swings now" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1); // it tried, then degraded gracefully
  });

  it("LLM returns unparseable output → falls back to keyword 'fact'", async () => {
    const llm = new CountingMockLLM("garbage");
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "let the winners run a good while longer" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(1);
  });
});

describe("FLAG OFF — gate disabled, LLM never called", () => {
  it('LEARNED_CONTEXT_SEMANTIC_GATE="off" → keyword+allowlist only, no LLM call', async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
    const llm = new CountingMockLLM("risk");
    // A paraphrase the keyword layer calls 'fact' stays 'fact' because the gate is off.
    const tier = await classifyWithSemanticGate(cand({ subject: "tone", value: "no need to be cautious on this one" }), { llm });
    expect(tier).toBe("fact");
    expect(llm.calls).toBe(0);
  });

  it('with the flag off a keyword risk is still \'risk\' (allowlist + keyword preserved)', async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
    const llm = new CountingMockLLM("fact");
    const tier = await classifyWithSemanticGate(cand({ subject: "tech", value: "back up the truck on tech" }), { llm });
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(0);
  });
});

describe("end-to-end ingest — gate-upgraded autonomous candidate lands in the PENDING queue", () => {
  it("an autonomous paraphrase the gate upgrades is QUEUED, not written to the fact store", async () => {
    const userId = "semgate-e2e-autonomous";
    const llm = new CountingMockLLM("risk");
    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "risk_tone", value: "comfortable with much bigger swings now" },
      "autonomous",
      { llm }
    );
    // Routed to the human confirmation queue, NOT written as an advisory fact and NOT dropped.
    expect(r.tier).toBe("risk");
    expect(r.written).toBeNull();
    expect(r.dropped).toBeNull();
    expect(r.pendingId).not.toBeNull();
    expect(listPendingLearnedContext(userId, "pending").some((p) => p.subject === "risk_tone")).toBe(true);
    // It is NOT reachable by the brain as a fact.
    expect(listLearnedContext(userId).some((row) => row.subject === "risk_tone")).toBe(false);
  });

  it("CHAT hard-cap holds: a gate-upgraded CHAT candidate is DROPPED, never queued", async () => {
    const userId = "semgate-e2e-chat";
    const llm = new CountingMockLLM("risk");
    const before = listPendingLearnedContext(userId, "pending").length;
    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "risk_tone", value: "comfortable with much bigger swings now" },
      "chat",
      { llm }
    );
    // The gate upgraded it to 'risk', but chat origin is hard-capped → dropped, NOT queued, NOT written.
    expect(r.tier).toBe("risk");
    expect(r.dropped).toBe("chat_risk_dropped");
    expect(r.pending).toBeNull();
    expect(r.pendingId).toBeNull();
    expect(r.written).toBeNull();
    expect(listPendingLearnedContext(userId, "pending").length).toBe(before);
    expect(listLearnedContext(userId).some((row) => row.subject === "risk_tone")).toBe(false);
  });
});

// ── P0-1: autonomous post-mortem provenance bypass (2026-09-27) ────────────────────────────────────
// The app's own post-mortem lessons used to be written as ordinary candidates, read by the semantic
// gate, graded 'risk' (a sizing lesson literally answers the gate's question "yes"), and parked in
// learned_context_pending — a queue nothing reads until a human clicks or a nightly LLM pass runs.
// So the system's highest-quality learning artifact was gated behind manual work. These pin the fix
// and, just as importantly, pin the three things the bypass must NOT be allowed to do.

describe("AUTONOMOUS POSTMORTEM PROVENANCE — LLM gate skipped for system-derived lessons", () => {
  // Keyword-'fact' lessons (the exact shape outcome-engine.ts writes) that the LLM would upgrade to
  // 'risk'. Each is asserted keyword-'fact' first, so the LLM is genuinely the only thing that could
  // have upgraded them — which is what the bypass removes.
  const POSTMORTEM_LESSONS = [
    "size down after failed breakouts",
    "avoid chasing extended names",
    "momentum theses did not survive the reversal"
  ];

  for (const lesson of POSTMORTEM_LESSONS) {
    it(`"${lesson}" → 'fact' with NO LLM call when provenance is system-postmortem`, async () => {
      expect(classifyRiskTier(cand({ subject: "obs", value: lesson }))).toBe("fact"); // gate would be the only upgrade
      const llm = new CountingMockLLM("risk"); // even a 'risk' verdict must not be consulted
      const tier = await classifyWithSemanticGate(
        cand({ subject: "obs", value: lesson, provenance: "system-postmortem" }),
        { llm }
      );
      expect(tier).toBe("fact");
      expect(llm.calls).toBe(0);
    });
  }

  it("the SAME text WITHOUT provenance is still gated (bypass is opt-in, not automatic)", async () => {
    const llm = new CountingMockLLM("risk");
    const tier = await classifyWithSemanticGate(cand({ subject: "obs", value: "size down after failed breakouts" }), { llm });
    expect(tier).toBe("risk");
    expect(llm.calls).toBe(1);
  });

  it("origin 'autonomous' alone does NOT bypass the gate (marker is not inferred from origin)", async () => {
    const userId = "prov-origin-only";
    const llm = new CountingMockLLM("risk");
    const r = await ingestLearned(
      userId,
      { kind: "pattern", subject: "not_a_postmortem", value: "comfortable with much bigger swings now" },
      "autonomous",
      { llm }
    );
    expect(r.tier).toBe("risk");
    expect(r.pendingId).not.toBeNull(); // still queued — only an explicit provenance marker changes this
    expect(listLearnedContext(userId).some((row) => row.subject === "not_a_postmortem")).toBe(false);
  });
});

describe("AUTONOMOUS PROVENANCE — end-to-end: the lesson lands in the readable brain, NOT in pending", () => {
  it("a system-postmortem lesson is WRITTEN to learned_context and is not queued", async () => {
    const userId = "prov-e2e-write";
    const llm = new CountingMockLLM("risk");
    const before = listPendingLearnedContext(userId, "pending").length;

    const r = await ingestLearned(
      userId,
      {
        kind: "decision",
        subject: "decision_lesson:AAPL:Momentum",
        value: "size down after failed breakouts (direction: avoid; from the AAPL filled decision, outcome loss)",
        symbol: "AAPL",
        source: "postmortem-outcome",
        confidence: 0.55,
        provenance: "system-postmortem"
      },
      "autonomous",
      { llm, learningScope: "portfolio" }
    );

    // THE POINT OF THE FIX: readable by the brain, not parked in the human queue.
    expect(r.tier).toBe("fact");
    expect(r.written).not.toBeNull();
    expect(r.dropped).toBeNull();
    expect(r.pending).toBeNull();
    expect(r.pendingId).toBeNull();
    expect(listPendingLearnedContext(userId, "pending").length).toBe(before); // nothing queued
    expect(llm.calls).toBe(0); // no LLM spend on our own outcomes

    const written = listLearnedContext(userId).find((row) => row.subject === "decision_lesson:AAPL:Momentum");
    expect(written).toBeDefined();
    expect(written?.riskTier).toBe("fact");
    expect(written?.origin).toBe("autonomous");
    expect(written?.source).toBe("postmortem-outcome");

    // Actually reachable by retrieval — the brain it "was" read from, not merely the same table.
    const { retrieveLearnedContext } = await import("../src/lib/learned-context/store");
    const lines = retrieveLearnedContext(userId, ["AAPL"], undefined, { includeShared: false });
    expect(lines.some((line) => line.includes("decision_lesson:AAPL:Momentum"))).toBe(true);

    // The bypass is recorded in the audit trail, so it is verifiable after the fact.
    const { listAudit } = await import("../src/lib/db");
    const writeReceipt = listAudit(50, userId).find((e) => e.kind === "learned_context.write");
    expect((writeReceipt?.payload as { provenance?: string }).provenance).toBe("system-postmortem");
  });

  it("a system-postmortem lesson that names a risk knob is STILL queued (keyword layer is authoritative)", async () => {
    const userId = "prov-e2e-keyword-risk";
    const llm = new CountingMockLLM("fact");
    const r = await ingestLearned(
      userId,
      {
        kind: "decision",
        subject: "decision_lesson:MSFT:Value",
        value: "we should raise max position size after the loss (direction: repeat; outcome loss)",
        symbol: "MSFT",
        source: "postmortem-outcome",
        provenance: "system-postmortem"
      },
      "autonomous",
      { llm, learningScope: "portfolio" }
    );
    // "max position" is a RISK_SUBJECTS keyword → step 1 returns 'risk' BEFORE the provenance bypass
    // is even reached. The bypass skips the LLM layer; it does not skip the risk layer.
    expect(r.tier).toBe("risk");
    expect(r.written).toBeNull();
    expect(r.pendingId).not.toBeNull();
    expect(listPendingLearnedContext(userId, "pending").some((p) => p.subject === "decision_lesson:MSFT:Value")).toBe(true);
    expect(llm.calls).toBe(0);
    expect(listLearnedContext(userId).some((row) => row.subject === "decision_lesson:MSFT:Value")).toBe(false);
  });

  it("PII still wins over provenance — a stamped lesson carrying an SSN is dropped", async () => {
    const userId = "prov-e2e-pii";
    const r = await ingestLearned(
      userId,
      {
        kind: "decision",
        subject: "decision_lesson:TSLA:Momentum",
        value: "post-mortem note referencing 123-45-6789 on the account",
        source: "postmortem-outcome",
        provenance: "system-postmortem"
      },
      "autonomous",
      { learningScope: "portfolio" }
    );
    expect(r.dropped).toBe("pii");
    expect(r.written).toBeNull();
    expect(r.pendingId).toBeNull();
    expect(listLearnedContext(userId).some((row) => row.subject === "decision_lesson:TSLA:Momentum")).toBe(false);
  });
});
