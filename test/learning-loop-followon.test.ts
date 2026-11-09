// Follow-on Workstream B — P0-2 (paired-t significance), P0-3 (fail-closed tuning-config guard),
// P0-4 (unified learning-mutation ledger + revert). Temp SQLite per run; never the dev app.db.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import { validateTuningInvariants } from "../src/lib/tuning-invariants";
import {
  recordLearningMutation,
  revertLearningMutation,
  LEARNING_SUBSYSTEM_SCORING_WEIGHTS
} from "../src/lib/learning-ledger";
import { applyAutonomousWeightTuning, revertAutonomousWeightTuning, autonomousOosThresholds } from "../src/lib/strategy-tuning";
import type { ScoringWeights, TradingPolicy } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ll-followon-${randomUUID()}.db`)}`;
});

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning
  };
}

// ── P0-3: fail-closed tuning-config invariant guard (pure validator) ────────────────────────────
describe("validateTuningInvariants — P0-3", () => {
  it("undefined / empty tuning is valid (all defaults)", () => {
    expect(validateTuningInvariants(undefined).ok).toBe(true);
    expect(validateTuningInvariants({}).ok).toBe(true);
  });

  it("flags a non-positive sample gate", () => {
    const r = validateTuningInvariants({ minClosedLotsForWeightShift: 0 });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "min_closed_lots_nonpositive")).toBe(true);
  });

  it("flags an inverted sizing band (floor > ceiling)", () => {
    const r = validateTuningInvariants({ sizingFloorPct: 80, sizingCeilingPct: 20 });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "sizing_floor_above_ceiling")).toBe(true);
  });

  it("flags autoApplyWeights with oosWithholdUnvalidated=false and no override", () => {
    const r = validateTuningInvariants({ autoApplyWeights: true, oosWithholdUnvalidated: false });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "auto_apply_without_oos_withhold")).toBe(true);
  });

  it("the explicit override clears the auto-apply / oos-withhold coupling", () => {
    const r = validateTuningInvariants({ autoApplyWeights: true, oosWithholdUnvalidated: false, autoApplyOverrideUnvalidated: true });
    expect(r.ok).toBe(true);
  });

  it("autoApplyWeights with oosWithholdUnvalidated left default (true) is valid", () => {
    expect(validateTuningInvariants({ autoApplyWeights: true }).ok).toBe(true);
  });

  // Codex finding #1: shrinkPrior=0 is a VALID "no shrinkage" setting (resolveShrinkPrior accepts v>=0).
  it("shrinkPrior=0 is VALID (no shrinkage); only a negative prior is flagged", () => {
    expect(validateTuningInvariants({ shrinkPrior: 0 }).ok).toBe(true);
    const neg = validateTuningInvariants({ shrinkPrior: -1 });
    expect(neg.ok).toBe(false);
    expect(neg.violations.some((v) => v.code === "shrink_prior_negative")).toBe(true);
  });

  // Codex finding #4: a truthy NON-boolean override must NOT bypass the fail-closed guard.
  it("a non-boolean truthy override (e.g. the string \"false\") does NOT clear the violation", () => {
    const r = validateTuningInvariants({
      autoApplyWeights: true,
      oosWithholdUnvalidated: false,
      // Simulate a mis-serialized config value that is truthy but not the real boolean true.
      autoApplyOverrideUnvalidated: "false" as unknown as boolean
    });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "auto_apply_without_oos_withhold")).toBe(true);
  });
});

// ── P0-3: fail-closed at the AUTONOMOUS apply path (skip + audit, never throw) ───────────────────
describe("applyAutonomousWeightTuning — P0-3 fail-closed", () => {
  it("an invariant violation SKIPS the apply, writes a skip audit row, does not throw, weights untouched", async () => {
    const { setPolicy, getPolicy, latestAuditByKind } = await import("../src/lib/db");
    const userId = `p03-${randomUUID()}`;
    // autoApplyWeights on + oosWithholdUnvalidated=false + no override → invariant violation.
    setPolicy(policyFor("P03-A", { autoApplyWeights: true, oosWithholdUnvalidated: false }), userId);
    const before = { ...getPolicy(userId).scoringWeights };

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("invariant_violation");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
    expect(latestAuditByKind("auto_weight_apply_skipped", userId)).toBeTruthy();
  });
});

// ── P0-2: policy-driven thresholds thread the margin + paired-t through ──────────────────────────
describe("autonomousOosThresholds — P0-2", () => {
  it("defaults keep the env margin and a no-op paired-t (0)", () => {
    const th = autonomousOosThresholds(undefined);
    expect(th.minPairedTStat).toBe(0);
    expect(th.minICDelta).toBeGreaterThanOrEqual(0);
  });

  it("policy minOosICImprovement raises the IC-delta margin above the env floor", () => {
    const th = autonomousOosThresholds({ minOosICImprovement: 0.5 });
    expect(th.minICDelta).toBe(0.5); // 0.5 > env default 0.005
  });

  it("policy minOosPairedTStat is surfaced for the significance gate", () => {
    expect(autonomousOosThresholds({ minOosPairedTStat: 2 }).minPairedTStat).toBe(2);
  });
});

// ── P0-4: unified learning-mutation ledger + revert ─────────────────────────────────────────────
describe("learning-mutation ledger + revert — P0-4", () => {
  it("records a mutation and reverts it, restoring the prior weights via setPolicy", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-${randomUUID()}`;
    setPolicy(policyFor("P04-A"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;

    // Simulate an apply: bump momentum, persist, and record the ledger row (capturing `before` = prior).
    const bumped: ScoringWeights = { ...prior, momentum: prior.momentum + 0.05 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    const entryId = recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: bumped },
      evidence: { candidateIC: 0.05 }
    });
    expect(entryId).toBeTruthy();
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum + 0.05, 5);

    const result = revertLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId });
    expect(result.reverted).toBe(true);
    expect(result.entryId).toBe(entryId);
    // Restored via setPolicy → getPolicy (which reads through the active-profile mirror) reflects the prior.
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum, 5);
  });

  it("revert is idempotent: a second revert of the same latest row reports no prior mutation", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-idem-${randomUUID()}`;
    setPolicy(policyFor("P04-IDEM"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: { ...prior, value: prior.value + 0.03 } }
    });

    expect(revertLearningMutation({ userId }).reverted).toBe(true);
    // The row is now marked reverted, so it's no longer the "latest non-reverted" → nothing to revert.
    expect(revertLearningMutation({ userId }).reverted).toBe(false);
  });

  it("revert is a no-op when the ledger is empty", () => {
    const userId = `p04-empty-${randomUUID()}`;
    const r = revertLearningMutation({ userId, subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(r.reverted).toBe(false);
    expect(r.reason).toBe("no_prior_mutation");
  });

  it("subsystem scoping: reverting scoring_weights ignores a different subsystem's row", () => {
    const userId = `p04-scope-${randomUUID()}`;
    recordLearningMutation({ subsystem: "some_other_subsystem", userId, before: {}, after: {} });
    // Only an other-subsystem row exists → the scoring_weights revert finds nothing.
    expect(revertLearningMutation({ userId, subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS }).reverted).toBe(false);
  });

  it("listLearningMutations returns rows newest-first, filterable by subsystem", async () => {
    const { listLearningMutations } = await import("../src/lib/db");
    const userId = `p04-list-${randomUUID()}`;
    recordLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId, before: { scoringWeights: { a: 1 } }, after: { scoringWeights: { a: 2 } } });
    const rows = listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(rows.length).toBe(1);
    expect(rows[0].subsystem).toBe(LEARNING_SUBSYSTEM_SCORING_WEIGHTS);
    expect(rows[0].beforeState).toEqual({ scoringWeights: { a: 1 } });
  });

  it("revertAutonomousWeightTuning uses the unified ledger when a ledger row exists", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-auto-${randomUUID()}`;
    setPolicy(policyFor("P04-AUTO"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    const bumped: ScoringWeights = { ...prior, quality: prior.quality + 0.04 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: bumped }
    });

    const result = revertAutonomousWeightTuning(userId);
    expect(result.reverted).toBe(true);
    expect(getPolicy(userId).scoringWeights.quality).toBeCloseTo(prior.quality, 5);
  });

  // Codex finding #5: an entryId from ANOTHER account must not restore/mutate that other account.
  it("entryId revert rejects a row belonging to a different account (account_mismatch)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const userId = `p04-acctmix-${randomUUID()}`;
    setPolicy(policyFor("P04-ACCT"), userId);
    // Record a mutation tagged to account "OTHER-ACCT".
    const entryId = recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      connectedAccountId: "OTHER-ACCT",
      before: { scoringWeights: { a: 1 } },
      after: { scoringWeights: { a: 2 } }
    });
    // Request the revert for the DEFAULT account (connectedAccountId undefined → ""), by the other account's id.
    const result = revertLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId, entryId });
    expect(result.reverted).toBe(false);
    expect(result.reason).toBe("account_mismatch");
  });

  // Codex finding #6: reverting an OLDER entryId while a NEWER unreverted row exists must be rejected.
  it("entryId revert rejects a non-latest row (not_latest_mutation) so a newer mutation isn't discarded", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const userId = `p04-nonlatest-${randomUUID()}`;
    setPolicy(policyFor("P04-NL"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    // Older mutation (record with a distinct created_at by inserting first).
    const olderId = recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: prior },
      after: { scoringWeights: { ...prior, momentum: prior.momentum + 0.03 } }
    });
    // Newer mutation on the same (account, subsystem).
    recordLearningMutation({
      subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS,
      userId,
      before: { scoringWeights: { ...prior, momentum: prior.momentum + 0.03 } },
      after: { scoringWeights: { ...prior, momentum: prior.momentum + 0.06 } }
    });
    // Attempting to revert the OLDER row by id is rejected (the newer unreverted row would be silently lost).
    const result = revertLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId, entryId: olderId });
    expect(result.reverted).toBe(false);
    expect(result.reason).toBe("not_latest_mutation");
  });

  // Codex finding #2: after a ledger revert, a 2nd revertAutonomousWeightTuning must NOT clobber a later
  // MANUAL weight change via the stale legacy audit-row fallback.
  it("2nd revertAutonomousWeightTuning after a ledger revert does NOT restore a stale legacy snapshot", async () => {
    const { setPolicy, getPolicy, audit } = await import("../src/lib/db");
    const userId = `p04-noclobber-${randomUUID()}`;
    setPolicy(policyFor("P04-NC"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    const bumped: ScoringWeights = { ...prior, sentiment: prior.sentiment + 0.05 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    // Both a ledger row AND a legacy audit row exist (as the real apply path writes both).
    recordLearningMutation({ subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS, userId, before: { scoringWeights: prior }, after: { scoringWeights: bumped } });
    audit("auto_weight_apply", { userId, previousWeights: prior, newWeights: bumped, changedFactors: ["sentiment"] }, userId);

    // 1st revert (via ledger) restores prior.
    expect(revertAutonomousWeightTuning(userId).reverted).toBe(true);
    expect(getPolicy(userId).scoringWeights.sentiment).toBeCloseTo(prior.sentiment, 5);

    // Now the operator makes a MANUAL weight change.
    const manual: ScoringWeights = { ...getPolicy(userId).scoringWeights, sentiment: prior.sentiment + 0.1 };
    setPolicy({ ...getPolicy(userId), scoringWeights: manual }, userId);
    const manualSentiment = getPolicy(userId).scoringWeights.sentiment;

    // 2nd revert must be a NO-OP (the ledger row is reverted; the stale legacy audit snapshot must NOT apply).
    const second = revertAutonomousWeightTuning(userId);
    expect(second.reverted).toBe(false);
    expect(second.reason).toBe("no_unreverted_ledger_mutation");
    // The manual change survives — the stale legacy snapshot did NOT clobber it.
    expect(getPolicy(userId).scoringWeights.sentiment).toBeCloseTo(manualSentiment, 5);
  });

  // A genuine PRE-LEDGER apply (only a legacy audit row, NO ledger row) still reverts via the fallback.
  it("legacy fallback still reverts a genuine pre-ledger apply (only an audit row, no ledger row)", async () => {
    const { setPolicy, getPolicy, audit } = await import("../src/lib/db");
    const userId = `p04-legacy-${randomUUID()}`;
    setPolicy(policyFor("P04-LEG"), userId);
    const prior = { ...getPolicy(userId).scoringWeights } as ScoringWeights;
    const bumped: ScoringWeights = { ...prior, momentum: prior.momentum + 0.05 };
    setPolicy({ ...getPolicy(userId), scoringWeights: bumped }, userId);
    // ONLY a legacy audit row (no ledger row) — mirrors an apply made before P0-4 landed.
    audit("auto_weight_apply", { userId, previousWeights: prior, newWeights: bumped, changedFactors: ["momentum"] }, userId);

    const result = revertAutonomousWeightTuning(userId);
    expect(result.reverted).toBe(true);
    expect(getPolicy(userId).scoringWeights.momentum).toBeCloseTo(prior.momentum, 5);
  });
});
