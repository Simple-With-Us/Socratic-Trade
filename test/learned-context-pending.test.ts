// Risk-tier CONFIRMATION QUEUE tests.
//
// The deferred second slice of the crossover-learning loop: risk-tier candidates from
// autonomous/ingest producers route to a human confirmation queue instead of being audit-dropped, and
// on APPROVAL apply SAFELY. THE SAFETY LINE: an approval NEVER auto-derives or auto-writes a numeric
// policy change — setPolicy stays reachable only via the explicit human PUT /api/policy. These tests
// pin that invariant (approve-risk leaves getPolicy() byte-identical) plus the chat hard-cap,
// idempotent strategy-prompt append, reject-is-noop, and ownership isolation.
//
// We exercise the store + db helper layer directly (imported via `../src/lib/...`). The approve/reject
// API routes are thin wrappers whose ownership gate IS `getPendingLearnedContext(id, userId)` returning
// null and whose status transition IS `setPendingLearnedContextStatus(id, userId, ...)` returning false
// for the wrong user — both asserted here. (Route files import via the `@/` alias, which vitest only
// resolves when mocked; testing the underlying helpers tests the real ownership/safety logic faithfully.)

import { beforeAll, describe, expect, it } from "vitest";
import {
  getDb,
  getPolicy,
  getStrategyPrompt,
  listAudit,
  listLearnedContext,
  listPendingLearnedContext,
  getPendingLearnedContext,
  setPendingLearnedContextStatus,
  insertPendingLearnedContext,
  setStrategyPrompt,
  setPolicy,
  audit
} from "../src/lib/db";
import { randomUUID } from "crypto";
import type { LearnedContextPendingRow } from "../src/lib/types";
import { applyApprovedPending, ingestLearned, mergeStrategyDirectiveBlock } from "../src/lib/learned-context/store";
import { userIdForEmail } from "../src/lib/auth/identity";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/learned-context-pending-test-${Date.now()}.db`;
  // These tests use KEYWORD-flagged risk candidates (the keyword layer returns 'risk' before the gate
  // ever calls the LLM) and assert the pending-queue routing / approval safety invariants. Turn the LLM
  // gate OFF so the suite is fully offline; the gate's behavior is covered in test/semantic-gate.test.ts.
  process.env.LEARNED_CONTEXT_SEMANTIC_GATE = "off";
  getDb();
});

// Two distinct authenticated identities so we can assert ownership isolation.
const USER_A = userIdForEmail("alice@example.com");
const USER_B = userIdForEmail("bob@example.com");

// Faithful re-creation of the approve route's body: ownership-gate → apply per tier → resolve → audit.
// Returns the HTTP-equivalent status so ownership 404s are asserted exactly as the route returns them.
function approveAs(id: string, userId: string): number {
  const pending = getPendingLearnedContext(id, userId);
  if (!pending || pending.status !== "pending") return 404;
  applyApprovedPending(pending);
  const updated = setPendingLearnedContextStatus(id, userId, "approved");
  if (!updated) return 404;
  audit("learned_context.approve", { userId, pendingId: id, tier: pending.riskTier, subject: pending.subject }, userId);
  return 200;
}

// Faithful re-creation of the reject route's body: ownership-gate → resolve → audit. Applies NOTHING.
function rejectAs(id: string, userId: string): number {
  const pending = getPendingLearnedContext(id, userId);
  if (!pending || pending.status !== "pending") return 404;
  const updated = setPendingLearnedContextStatus(id, userId, "rejected");
  if (!updated) return 404;
  audit("learned_context.reject", { userId, pendingId: id, tier: pending.riskTier, subject: pending.subject }, userId);
  return 200;
}

const riskCandidate = { kind: "pattern" as const, subject: "max_position", value: "raise to 30%" };

// The fail-closed classifier emits only 'fact' | 'risk'; the 'strategy-directive' tier is one the
// queue can HOLD and APPROVE but that a producer sets explicitly (the classifier never auto-derives a
// prompt rewrite). So a strategy-directive pending row is seeded directly, as a producer would.
const DIRECTIVE_VALUE = "Prefer momentum names in risk-on regimes and trim into euphoria.";
function seedDirectivePending(userId: string): LearnedContextPendingRow {
  const row: LearnedContextPendingRow = {
    id: randomUUID(),
    userId,
    scope: "private",
    kind: "decision",
    subject: "strategy directive",
    symbol: null,
    value: DIRECTIVE_VALUE,
    source: "inferred",
    origin: "autonomous",
    riskTier: "strategy-directive",
    connectedAccountId: null,
    accountEnvironment: null,
    learningScope: "portfolio",
    transferState: "not_applicable",
    classifierReason: "producer-tagged strategy-directive; queued for human confirmation",
    createdAt: new Date().toISOString(),
    status: "pending",
    resolvedAt: null
  };
  return insertPendingLearnedContext(row);
}

describe("risk-tier confirmation queue — ingest routing", () => {
  it("an AUTONOMOUS risk candidate is QUEUED (pending row created, not dropped, not written)", async () => {
    const r = await ingestLearned(USER_A, riskCandidate, "autonomous");
    expect(r.written).toBeNull();
    expect(r.dropped).toBeNull();
    expect(r.pending).not.toBeNull();
    expect(r.pendingId).toBe(r.pending?.id);
    expect(r.tier).toBe("risk");

    const pending = listPendingLearnedContext(USER_A, "pending");
    expect(pending.some((p) => p.subject === "max_position" && p.status === "pending")).toBe(true);
    // It is NOT in the advisory store (not reachable by the brain yet).
    expect(listLearnedContext(USER_A).some((row) => row.subject === "max_position")).toBe(false);
    // It audited as 'pending', not 'drop'.
    expect(listAudit(50, USER_A).some((a) => a.kind === "learned_context.pending")).toBe(true);
  });

  it("a CHAT risk candidate is HARD-CAPPED: dropped, never queued", async () => {
    const before = listPendingLearnedContext(USER_A, "pending").length;
    const r = await ingestLearned(
      USER_A,
      { kind: "pattern", subject: "growth", value: "lean much harder into growth", intent: "lean much harder into growth" },
      "chat"
    );
    expect(r.written).toBeNull();
    expect(r.dropped).toBe("chat_risk_dropped");
    expect(r.pending).toBeNull();
    expect(r.pendingId).toBeNull();
    // No new pending row was created from chat.
    expect(listPendingLearnedContext(USER_A, "pending").length).toBe(before);
    expect(listAudit(50, USER_A).some((a) => a.kind === "learned_context.drop")).toBe(true);
  });
});

describe("approve — strategy-directive APPENDS an attributed prompt block (idempotent)", () => {
  it("appends a delimited AI-LEARNED block, preserving the pre-existing prompt; re-approve does not duplicate", () => {
    const basePrompt = "BASE STRATEGY PROMPT — owner-authored. Do not lose this text.";
    setStrategyPrompt(basePrompt, USER_A);

    const pending = seedDirectivePending(USER_A);
    const id = pending.id;
    expect(getPendingLearnedContext(id, USER_A)?.riskTier).toBe("strategy-directive");

    expect(approveAs(id, USER_A)).toBe(200);

    const merged = getStrategyPrompt(USER_A);
    expect(merged.startsWith(basePrompt)).toBe(true); // pre-existing text preserved
    expect(merged).toContain(`<!-- AI-LEARNED ${id}`);
    expect(merged).toContain(DIRECTIVE_VALUE);
    expect(merged).toContain("<!-- /AI-LEARNED -->");

    // status resolved to approved + audited
    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("approved");
    expect(listAudit(50, USER_A).some((a) => a.kind === "learned_context.approve")).toBe(true);

    const countBlocks = (text: string, blockId: string) =>
      (text.match(new RegExp(`<!-- AI-LEARNED ${blockId} `, "g")) ?? []).length;
    expect(countBlocks(merged, id)).toBe(1);

    // Re-approving the SAME id must NOT duplicate the block (idempotent by id): a second merge of the
    // same id replaces the block in place rather than appending a new one.
    // `source` is REQUIRED at this sink: containment and provenance happen inside the merge, so a
    // caller cannot write an unscanned directive into the trusted prompt by forgetting a helper.
    // "owner-coach" is owner-authored, so the value is preserved byte-for-byte and contained is null.
    const { prompt: remerged, contained } = mergeStrategyDirectiveBlock(
      merged,
      id,
      "UPDATED guidance text for same id",
      "2026-06-21T00:00:00.000Z",
      "owner-coach"
    );
    expect(contained).toBeNull(); // owner text is never scanned or altered
    expect(countBlocks(remerged, id)).toBe(1); // still exactly one block for this id
    expect(remerged).toContain("UPDATED guidance text for same id");
    expect(remerged).not.toContain(DIRECTIVE_VALUE); // old value replaced in-place
    expect(remerged.startsWith(basePrompt)).toBe(true);
  });
});

describe("approve — risk PROMOTES to advisory row WITHOUT mutating numeric policy", () => {
  it("creates a learned_context row AND leaves getPolicy() byte-identical", async () => {
    // Seed a known, non-default numeric policy so a mutation would be detectable.
    const seeded = { ...getPolicy(USER_A), maxOrderNotional: 12_345, maxDailyNotional: 67_890 };
    setPolicy(seeded, USER_A);

    const policyBefore = JSON.stringify(getPolicy(USER_A));
    const promptBefore = getStrategyPrompt(USER_A);

    const r = await ingestLearned(USER_A, riskCandidate, "ingest");
    const id = r.pendingId!;
    expect(r.pending?.riskTier).toBe("risk");

    expect(approveAs(id, USER_A)).toBe(200);

    // The advisory row now exists.
    expect(listLearnedContext(USER_A).some((row) => row.subject === "max_position" && row.riskTier === "risk")).toBe(true);

    // SAFETY INVARIANT: numeric policy is byte-identical — approve did NOT call setPolicy / auto-mutate.
    expect(JSON.stringify(getPolicy(USER_A))).toBe(policyBefore);
    // And the strategy prompt was untouched by a 'risk' approve (only directive approve appends).
    expect(getStrategyPrompt(USER_A)).toBe(promptBefore);

    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("approved");
  });
});

describe("reject — nothing is applied", () => {
  it("marks rejected, writes no learned_context row, leaves prompt + policy unchanged", async () => {
    const policyBefore = JSON.stringify(getPolicy(USER_A));
    const promptBefore = getStrategyPrompt(USER_A);
    const advisoryBefore = listLearnedContext(USER_A).length;

    const r = await ingestLearned(
      USER_A,
      { kind: "pattern", subject: "leverage", value: "use 2x leverage on conviction names" },
      "autonomous"
    );
    const id = r.pendingId!;

    expect(rejectAs(id, USER_A)).toBe(200);

    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("rejected");
    // Nothing applied.
    expect(listLearnedContext(USER_A).length).toBe(advisoryBefore);
    expect(listLearnedContext(USER_A).some((row) => row.subject === "leverage")).toBe(false);
    expect(JSON.stringify(getPolicy(USER_A))).toBe(policyBefore);
    expect(getStrategyPrompt(USER_A)).toBe(promptBefore);
    expect(listAudit(50, USER_A).some((a) => a.kind === "learned_context.reject")).toBe(true);
  });
});

describe("ownership isolation — user B cannot touch user A's pending row", () => {
  it("approve/reject by user B returns 404 and changes nothing; list is per-user", async () => {
    const r = await ingestLearned(USER_A, { kind: "pattern", subject: "drawdown", value: "tolerate 20% drawdown" }, "autonomous");
    const id = r.pendingId!;

    // User B's list never shows user A's row.
    expect(listPendingLearnedContext(USER_B, "pending").some((row) => row.id === id)).toBe(false);
    // User B can't even read it (ownership-scoped getter).
    expect(getPendingLearnedContext(id, USER_B)).toBeNull();

    // User B approve → 404, no change.
    expect(approveAs(id, USER_B)).toBe(404);
    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("pending");

    // User B reject → 404, no change.
    expect(rejectAs(id, USER_B)).toBe(404);
    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("pending");

    // User B did not get a stray advisory row for A's subject.
    expect(listLearnedContext(USER_B).some((row) => row.subject === "drawdown")).toBe(false);

    // The status helper itself refuses the wrong owner (changes === 0 → false).
    expect(setPendingLearnedContextStatus(id, USER_B, "approved")).toBe(false);
    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("pending");

    // Owner A can still resolve it.
    expect(approveAs(id, USER_A)).toBe(200);
    expect(getPendingLearnedContext(id, USER_A)?.status).toBe("approved");
  });
});

describe("ST-4589 — approved risk rows are stored but NOT read into the trading prompt", () => {
  it("an approved risk row exists in learned_context yet never reaches decision retrieval", async () => {
    // Approval can come from a human OR the Learning Review LLM ("decide" mode) and the row does not
    // record which, so the read stays fact-tier only until the owner decides otherwise.
    const { retrieveLearnedContext } = await import("../src/lib/learned-context/store");
    const owner = userIdForEmail(`b3-owner-${randomUUID()}@example.com`);
    const candidate = { kind: "pattern" as const, subject: `max_position_b3_${randomUUID().slice(0, 8)}`, value: "raise to 30%" };

    const r = await ingestLearned(owner, candidate, "ingest");
    expect(r.pending?.riskTier).toBe("risk");
    expect(approveAs(r.pendingId!, owner)).toBe(200);

    expect(listLearnedContext(owner).some((row) => row.subject === candidate.subject && row.riskTier === "risk")).toBe(true);
    expect(retrieveLearnedContext(owner, [], undefined, { includeShared: true }).some((line) => line.includes(candidate.subject))).toBe(false);
  });
});

describe("ST-4589 B4 — fact rows carry regime / thesisTag so relevance scoring can fire", () => {
  it("persists the producer's regime and thesisTag and ranks the in-regime, in-thesis fact first", async () => {
    const { retrieveLearnedContextDetailed } = await import("../src/lib/learned-context/store");
    const user = userIdForEmail(`b4-${randomUUID()}@example.com`);
    const tag = `T${randomUUID().slice(0, 6)}`;
    const conditioned = await ingestLearned(
      user,
      { kind: "decision", subject: `decision_lesson:AAPL:${tag}`, value: "Breakouts in this setup followed through.", symbol: "AAPL", regime: "Tech-Bull", thesisTag: tag },
      "autonomous"
    );
    expect(conditioned.written?.regime).toBe("Tech-Bull");
    expect(conditioned.written?.thesisTag).toBe(tag);
    const plain = await ingestLearned(
      user,
      { kind: "decision", subject: "decision_lesson:AAPL:untagged", value: "A neutral observation about AAPL.", symbol: "AAPL" },
      "autonomous"
    );
    expect(plain.written?.regime ?? null).toBeNull();

    // Read back from the table (not just the in-memory row).
    const stored = listLearnedContext(user).find((row) => row.subject === `decision_lesson:AAPL:${tag}`);
    expect(stored?.regime).toBe("Tech-Bull");
    expect(stored?.thesisTag).toBe(tag);

    const { rows } = retrieveLearnedContextDetailed(user, ["AAPL"], "Tech-Bull", { includeShared: false, thesisTags: new Set([tag]) });
    expect(rows[0]?.subject).toBe(`decision_lesson:AAPL:${tag}`);
  });
});
