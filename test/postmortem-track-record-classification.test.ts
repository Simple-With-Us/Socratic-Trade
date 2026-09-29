// Regression tests for the post-mortem TRACK-RECORD misclassification (P0, 2026-09-28).
//
// The bug: `writeThesisTrackRecordFacts` (src/lib/post-mortem.ts) emits one learned_context candidate
// per well-sampled thesis whose value ends in the bucket's closed-lot count. Written as a bare
// "(23 lots)" that count matches the bare-count clause of NUMERIC_RISK_PATTERN
// (src/lib/learned-context/classify.ts), so the KEYWORD layer — which runs first and is
// authoritative — forced every track-record fact to the 'risk' tier and routed it into
// learned_context_pending instead of the brain. In production that queue held 421 rows, 100% of them
// at 'risk' tier: the gate was not occasionally queueing lessons, it was queueing essentially
// everything the system learns. Separately the same text was being UPGRADED fact->risk by the LLM
// layer, which PR #3914 already bypassed for provenance-stamped candidates — but only on the OTHER
// producer (outcome-engine), not this one.
//
// The fix is deliberately PRODUCER-side, not classifier-side. The function's own contract already
// promised "carries NO numeric percent/size token"; the lot count violated that contract. A bare
// "23 lots" and an order instruction "500 shares" are lexically identical to a keyword blocklist, so
// the only honest disambiguation is at the producer, where the distinction is actually known. Weakening
// NUMERIC_RISK_PATTERN would be the change that risks a human's real sizing guidance slipping through.
//
// The invariants pinned here:
//   1. The producer's real value shape is keyword-'fact' and lands in the BRAIN.
//   2. A BARE "(N lots)" is still 'risk' and still queues — the pre-fix regression stays pinned.
//   3. A provenance-stamped candidate naming a risk knob, or carrying a real sizing/price numeric, is
//      still 'risk' — the #3914 LLM bypass is a cost/semantics skip, never a safety hole.
//   4. The provenance marker really does suppress the LLM upgrade end-to-end: with the gate ON and a
//      risk-responding model, the STAMPED candidate lands in the brain while the UNSTAMPED equivalent
//      is queued. Without the stamp the fix would be half a fix.
//   5. The confirmation queue is auditable by producer (pendingLearnedContextProvenanceBreakdown), so
//      an owner can tell legitimate human risk content from app-authored track-record text.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, listLearnedContext, listPendingLearnedContext } from "../src/lib/db";
import { pendingLearnedContextProvenanceBreakdown } from "../src/lib/db-learning";
import { classifyRiskTier } from "../src/lib/learned-context/classify";
import { ingestLearned } from "../src/lib/learned-context/store";
import type { ChatLLM, LlmResult } from "../src/lib/chat/types";
import type { LearnedContextCandidate } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/postmortem-track-record-test-${Date.now()}.db`;
  getDb();
});

beforeEach(() => {
  // Default OFF so the keyword layer alone decides. The one gate-ON test sets it explicitly.
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
});

/** Deterministic model stand-in that always answers "risk" — the hostile case for the LLM layer. */
class AlwaysRiskLLM implements ChatLLM {
  public calls = 0;
  async run(): Promise<LlmResult> {
    this.calls += 1;
    return { text: '{"tier":"risk"}', toolCalls: [], citations: [] };
  }
}

/** The exact value shape `writeThesisTrackRecordFacts` emits after the fix (src/lib/post-mortem.ts). */
const POST_FIX_VALUE =
  'The "momentum" thesis worked across pooled closed trades from all accounts ' +
  "(sample_size=23 closed lots). This beats a random-bucket label-permutation baseline " +
  "(p=0.012, 2000 permutations over the pooled closed-trade history) — unlikely to be luck. " +
  "source_accounts: 123456789 environment_breakdown: paper=12,live=11";

/** The value shape the SAME function emitted before the fix: a bare "(23 lots)". */
const PRE_FIX_VALUE =
  'The "momentum" thesis worked across pooled closed trades from all accounts (23 lots). ' +
  "This beats a random-bucket label-permutation baseline (p=0.012, 2000 permutations over the " +
  "pooled closed-trade history) — unlikely to be luck. source_accounts: 123456789 " +
  "environment_breakdown: paper=12,live=11";

function trackRecord(overrides: Partial<LearnedContextCandidate> = {}): LearnedContextCandidate {
  return {
    kind: "pattern",
    subject: "track_record:momentum",
    value: POST_FIX_VALUE,
    source: "inferred",
    confidence: 0.7,
    provenance: "system-postmortem",
    ...overrides
  };
}

describe("post-mortem track-record keyword classification", () => {
  it("1. the producer's real value shape is a FACT, not risk", () => {
    expect(classifyRiskTier(trackRecord({ provenance: undefined }))).toBe("fact");
    expect(classifyRiskTier(trackRecord())).toBe("fact");
  });

  it("2. a BARE '(N lots)' is still risk — the pre-fix shape stays pinned in the regressing direction", () => {
    expect(classifyRiskTier(trackRecord({ value: PRE_FIX_VALUE }))).toBe("risk");
    expect(classifyRiskTier(trackRecord({ value: "Add 500 shares of this thesis.", provenance: undefined }))).toBe("risk");
  });

  it("3. a provenance-stamped candidate naming a risk knob is still risk", () => {
    expect(classifyRiskTier(trackRecord({ value: `${POST_FIX_VALUE} On a win, double down on the next one.` }))).toBe("risk");
    expect(classifyRiskTier(trackRecord({ value: `${POST_FIX_VALUE} Raise the max position for this bucket.` }))).toBe("risk");
  });

  it("3b. a provenance-stamped candidate carrying a real sizing/price numeric is still risk", () => {
    expect(classifyRiskTier(trackRecord({ value: `${POST_FIX_VALUE} Size it at 5% of the book.` }))).toBe("risk");
    expect(classifyRiskTier(trackRecord({ value: `${POST_FIX_VALUE} Cap the clip at 500 shares.` }))).toBe("risk");
    expect(classifyRiskTier(trackRecord({ value: `${POST_FIX_VALUE} Treat it as a 3x multiplier.` }))).toBe("risk");
  });
});

describe("ingestLearned routing for a post-mortem track-record fact", () => {
  it("1b. lands in the BRAIN, not the confirmation queue", async () => {
    const result = await ingestLearned("pm-user-brain", trackRecord(), "autonomous");
    expect(result.tier).toBe("fact");
    expect(result.pending).toBeNull();
    expect(result.written).not.toBeNull();
    expect(listLearnedContext("pm-user-brain").some((r) => r.subject === "track_record:momentum")).toBe(true);
    expect(listPendingLearnedContext("pm-user-brain")).toHaveLength(0);
  });

  it("2b. still queues the BARE-count candidate — the misclassification stays visible if it returns", async () => {
    const result = await ingestLearned("pm-user-brain", trackRecord({ subject: "track_record:legacy", value: PRE_FIX_VALUE }), "autonomous");
    expect(result.tier).toBe("risk");
    expect(result.written).toBeNull();
    expect(result.pendingId).not.toBeNull();
  });
});

describe("provenance marker suppresses the LLM gate upgrade end to end (gate ON)", () => {
  it("4. stamped → brain (no LLM call); unstamped twin → queue", async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";

    const stampedLlm = new AlwaysRiskLLM();
    const stamped = await ingestLearned("pm-user-gate", trackRecord(), "autonomous", { llm: stampedLlm });
    expect(stamped.tier).toBe("fact");
    expect(stampedLlm.calls).toBe(0); // the LLM layer was skipped entirely
    expect(stamped.written).not.toBeNull();

    // The identical text WITHOUT the marker is the #3914 bug exactly: the model says "risk" and the
    // lesson is parked. This is the assertion that makes the marker load-bearing rather than cosmetic.
    const unstampedLlm = new AlwaysRiskLLM();
    const unstamped = await ingestLearned("pm-user-gate", trackRecord({ subject: "track_record:unmarked", provenance: undefined }), "autonomous", { llm: unstampedLlm });
    expect(unstampedLlm.calls).toBe(1);
    expect(unstamped.tier).toBe("risk");
    expect(unstamped.written).toBeNull();
    expect(unstamped.pendingId).not.toBeNull();
  });

  it("3c. a stamped candidate that IS risk still queues — the marker never substitutes for the keyword layer", async () => {
    process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "on";
    const llm = new AlwaysRiskLLM();
    const result = await ingestLearned("pm-user-gate", trackRecord({ subject: "track_record:knob", value: `${POST_FIX_VALUE} Double down on the next one.` }), "autonomous", { llm });
    expect(llm.calls).toBe(0); // keyword already said risk; the gate is never reached
    expect(result.tier).toBe("risk");
    expect(result.pendingId).not.toBeNull();
  });
});

describe("confirmation-queue provenance audit", () => {
  it("5. splits the pending queue by producer and counts pre-migration track-record rows", async () => {
    const user = "pm-user-audit";
    // Unstamped risk row (a human risk lesson) → provenance NULL.
    await ingestLearned(user, { kind: "pattern", subject: "manual risk note", value: "Keep the stop at 2x the ATR.", source: "user" }, "autonomous");
    // Stamped risk row that survived (still names a risk knob) → provenance recorded.
    await ingestLearned(user, trackRecord({ subject: "track_record:sized", value: `${POST_FIX_VALUE} Double down.` }), "autonomous");
    // Stamped fact row → never reaches the queue at all.
    await ingestLearned(user, trackRecord({ subject: "track_record:ok" }), "autonomous");

    const queued = listPendingLearnedContext(user);
    const breakdown = pendingLearnedContextProvenanceBreakdown();

    // This user queued exactly the two risk rows; the stamped "ok" fact never reached the queue.
    expect(queued).toHaveLength(2);

    // The breakdown is deliberately process-wide (the production question is a fleet-wide one), so it
    // also counts the rows the earlier describes left behind. Assert on the BUCKETS, not on equality
    // with a single user's list.
    const stamped = breakdown.byProvenance.find((b) => b.provenance === "system-postmortem");
    const unstamped = breakdown.byProvenance.find((b) => b.provenance === "(unstamped)");
    // 3 stamped: this test's `track_record:sized`, plus `track_record:legacy` (bare count) and
    // `track_record:knob` from the routing/gate suites above.
    expect(stamped?.count).toBe(3);
    expect(stamped?.riskTier).toBe("risk");
    // 2 unstamped: this test's `manual risk note`, plus the deliberately unmarked `track_record:unmarked`.
    expect(unstamped?.count).toBe(2);
    expect(breakdown.totalPending).toBe(5);

    // The pre-migration backlog has no provenance column, so the subject is the only honest handle.
    expect(breakdown.trackRecordSubjectCount).toBe(4);

    // The queue row itself carries the producer marker in its forensic reason.
    expect(queued.find((r) => r.subject === "track_record:sized")?.classifierReason).toContain("producer=system-postmortem");
  });

  it("5b. leaves an unstamped row's provenance null rather than inventing one", async () => {
    const queued = listPendingLearnedContext("pm-user-audit").find((r) => r.subject === "manual risk note");
    expect(queued?.provenance ?? null).toBeNull();
    expect(queued?.classifierReason).not.toContain("producer=");
  });
});
