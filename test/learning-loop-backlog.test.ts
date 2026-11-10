// Broader-backlog Chat B (2026-07-01). DB-backed integration tests for the composed autonomous-tuning gate
// (the paired-t E2E #300 deferred), P1-1 dry-run zero-writes, P1-3 shadow ledger, and the P2-5/P2-6 guards.
// Temp SQLite per run — never the dev app.db.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_POLICY } from "../src/lib/defaults";
import type { OOSResult } from "../src/lib/backtest";
import type { TradingPolicy } from "../src/lib/types";

// Control runWalkForwardOOS deterministically (mirrors strategy-tuning.test.ts). Default: null (no OOS data)
// so untouched paths behave as "insufficient history".
const mockRunWalkForwardOOS = vi.fn<() => Promise<OOSResult | null>>();
mockRunWalkForwardOOS.mockResolvedValue(null);
vi.mock("../src/lib/backtest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/backtest")>();
  return { ...actual, runWalkForwardOOS: mockRunWalkForwardOOS };
});

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-ll-backlog-${randomUUID()}.db`)}`;
});

afterEach(() => {
  mockRunWalkForwardOOS.mockReset();
  mockRunWalkForwardOOS.mockResolvedValue(null);
  delete process.env.OPENROUTER_API_KEY;
});

function policyFor(account: string, tuning?: TradingPolicy["tuning"]): TradingPolicy {
  return {
    ...DEFAULT_POLICY,
    accountNumber: account,
    scoringWeights: { ...DEFAULT_POLICY.scoringWeights },
    tuning
  };
}

/** Seed N closed lots (buy→sell pairs) with a slightly NEGATIVE realized return so the local-rules tuner
 *  proposes a (weakPerformance) weight patch that clears the closed-lot sample gate. */
async function seedClosedLots(account: string, userId: string, n: number): Promise<void> {
  const { insertFillEvent } = await import("../src/lib/db");
  for (let i = 0; i < n; i++) {
    const base = Date.now() + i * 120_000;
    insertFillEvent({
      userId, accountNumber: account, source: "paper", symbol: `SYM${i}`, side: "buy",
      quantity: 10, price: 100, notional: 1000, status: "filled",
      filledAt: new Date(base).toISOString()
    });
    insertFillEvent({
      userId, accountNumber: account, source: "paper", symbol: `SYM${i}`, side: "sell",
      quantity: 10, price: 99, notional: 990, status: "filled",
      filledAt: new Date(base + 60_000).toISOString()
    });
  }
}

/** A controlled OOSResult whose candidate beats baseline by `icDelta` with a paired-t of `tStat`. */
function oosResult(overrides: Partial<OOSResult> = {}): OOSResult {
  const baselineIC = 0.02;
  const icDelta = overrides.oosICCandidate != null ? overrides.oosICCandidate - baselineIC : 0.03;
  return {
    trainObservations: 40, testObservations: 30, trainDates: 7, testDates: 5,
    window: {
      trainStartDate: "2026-05-01", trainEndDate: "2026-06-01",
      embargoDates: 2, purgedTrainDates: 0,
      testStartDate: "2026-06-05", testEndDate: "2026-06-15"
    },
    trainICs: [], icWeights: { ...DEFAULT_POLICY.scoringWeights },
    oosIC: 0.03, oosICIR: 0.9, oosICDefault: 0.01,
    oosICCandidate: baselineIC + icDelta, oosICBaseline: baselineIC,
    pairedICDiff: { n: 5, meanDiff: icDelta, stdDiff: 0.01, seDiff: 0.005, tStat: 3.0 },
    candidateMaxDrawdownPct: 5, baselineMaxDrawdownPct: 5,
    equityCurve: [], annualizedReturn: null, benchmarkAnnualizedReturn: null,
    activeReturn: null, sharpeRatio: null, maxDrawdownPct: 5, note: "mock",
    ...overrides
  };
}

describe("applyAutonomousWeightTuning — composed paired-t gate E2E (#300 deferred)", () => {
  it("APPLIES when the candidate clears the paired-t gate; the ledger + provenance rows are written", async () => {
    const { setPolicy, getPolicy, latestAuditByKind, listLearningMutations } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning, TUNING_APPLY_PROVENANCE_AUDIT_KIND } = await import("../src/lib/strategy-tuning");
    const { LEARNING_SUBSYSTEM_SCORING_WEIGHTS } = await import("../src/lib/learning-ledger");
    const userId = `e2e-apply-${randomUUID()}`;
    const account = `E2E-APPLY`;
    // autoApplyWeights on + a nonzero paired-t requirement (2.0) that the mock's tStat=3.0 clears.
    setPolicy(policyFor(account, { autoApplyWeights: true, oosWithholdUnvalidated: true, minOosPairedTStat: 2.0 }), userId);
    await seedClosedLots(account, userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };

    mockRunWalkForwardOOS.mockResolvedValue(oosResult({ pairedICDiff: { n: 5, meanDiff: 0.03, stdDiff: 0.01, seDiff: 0.005, tStat: 3.0 } }));

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(true);
    // Weights changed and persisted.
    expect(getPolicy(userId).scoringWeights).not.toEqual(before);
    // Unified ledger row recorded (source of truth for revert).
    const ledger = listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(ledger.length).toBe(1);
    expect(ledger[0].trigger).toBe("auto_weight_apply");
    // P2-7 provenance row written with the fold shape + flags.
    const prov = latestAuditByKind(TUNING_APPLY_PROVENANCE_AUDIT_KIND, userId)?.payload as { testDates?: number; flagsInEffect?: Record<string, unknown> } | undefined;
    expect(prov?.testDates).toBe(5);
    expect(prov?.flagsInEffect).toMatchObject({ minOosPairedTStat: 2.0 });
  });

  it("does NOT apply when the paired-t is BELOW the required threshold (significance failure)", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `e2e-pt-fail-${randomUUID()}`;
    const account = `E2E-PT`;
    setPolicy(policyFor(account, { autoApplyWeights: true, oosWithholdUnvalidated: true, minOosPairedTStat: 5.0 }), userId);
    await seedClosedLots(account, userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };

    // Candidate beats baseline on point-estimate IC, but the paired t-stat (2.0) is below the 5.0 bar.
    mockRunWalkForwardOOS.mockResolvedValue(oosResult({ pairedICDiff: { n: 5, meanDiff: 0.03, stdDiff: 0.02, seDiff: 0.015, tStat: 2.0 } }));

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("autonomous_oos_gate_failed");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
  });
});

describe("P2-5 drawdown guard + P2-6 test-date floor", () => {
  it("P2-5: blocks an apply whose candidate OOS drawdown spikes above baseline beyond tolerance", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `p25-${randomUUID()}`;
    setPolicy(policyFor("P25", { autoApplyWeights: true, oosWithholdUnvalidated: true, autoApplyDrawdownGuard: true }), userId);
    await seedClosedLots("P25", userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };

    // testDates=10 (>= guard floor 8); candidate DD 20% >> baseline DD 5% + 2% tolerance → blocked.
    mockRunWalkForwardOOS.mockResolvedValue(oosResult({ testDates: 10, candidateMaxDrawdownPct: 20, baselineMaxDrawdownPct: 5 }));

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("autonomous_drawdown_guard_failed");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
  });

  it("P2-5: guard OFF (default) → the same drawdown spike still applies", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `p25-off-${randomUUID()}`;
    setPolicy(policyFor("P25OFF", { autoApplyWeights: true, oosWithholdUnvalidated: true }), userId);
    await seedClosedLots("P25OFF", userId, 22);
    mockRunWalkForwardOOS.mockResolvedValue(oosResult({ testDates: 10, candidateMaxDrawdownPct: 20, baselineMaxDrawdownPct: 5 }));
    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(true);
  });

  it("P2-6: refuses to apply below the minOosTestDates floor even when IC + paired-t pass", async () => {
    const { setPolicy, getPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `p26-${randomUUID()}`;
    setPolicy(policyFor("P26", { autoApplyWeights: true, oosWithholdUnvalidated: true, minOosTestDates: 12 }), userId);
    await seedClosedLots("P26", userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };
    // Only 5 test dates < the 12 floor → gate fails on the starvation guard.
    mockRunWalkForwardOOS.mockResolvedValue(oosResult({ testDates: 5 }));
    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toContain("autonomous_oos_gate_failed");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
  });
});

describe("P1-1 dry-run — zero writes", () => {
  it("returns the correct wouldApply decision but performs NO writes (no setPolicy, no ledger, no audit)", async () => {
    const dbMod = await import("../src/lib/db");
    const { setPolicy, getPolicy, listLearningMutations, latestAuditByKind } = dbMod;
    const { dryRunAutonomousWeightTuning, AUTO_WEIGHT_APPLY_AUDIT_KIND } = await import("../src/lib/strategy-tuning");
    const { LEARNING_SUBSYSTEM_SCORING_WEIGHTS } = await import("../src/lib/learning-ledger");
    const userId = `dryrun-${randomUUID()}`;
    // Note: autoApplyWeights is OFF here — the dry-run ignores the flag entirely.
    setPolicy(policyFor("DRY", { minOosPairedTStat: 2.0 }), userId);
    await seedClosedLots("DRY", userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };

    mockRunWalkForwardOOS.mockResolvedValue(oosResult());
    const setPolicySpy = vi.spyOn(dbMod, "setPolicy");

    const decision = await dryRunAutonomousWeightTuning(userId);
    expect(decision.wouldApply).toBe(true);
    expect(decision.after).toBeDefined();
    expect(decision.oosICCandidate).toBeGreaterThan(decision.oosICBaseline!);
    // ZERO writes: policy unchanged, no ledger row, no apply audit, setPolicy never called by the dry-run.
    expect(getPolicy(userId).scoringWeights).toEqual(before);
    expect(listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS })).toHaveLength(0);
    expect(latestAuditByKind(AUTO_WEIGHT_APPLY_AUDIT_KIND, userId)).toBeUndefined();
    expect(setPolicySpy).not.toHaveBeenCalled();
    setPolicySpy.mockRestore();
  });

  it("surfaces invariant violations that WOULD block a real apply", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { dryRunAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `dryrun-inv-${randomUUID()}`;
    // autoApplyWeights + oosWithholdUnvalidated=false and no override → an invariant violation.
    setPolicy(policyFor("DRYINV", { autoApplyWeights: true, oosWithholdUnvalidated: false }), userId);
    await seedClosedLots("DRYINV", userId, 22);
    mockRunWalkForwardOOS.mockResolvedValue(oosResult());
    const decision = await dryRunAutonomousWeightTuning(userId);
    expect(decision.invariantViolations?.some((v) => v.code === "auto_apply_without_oos_withhold")).toBe(true);
  });
});

describe("P1-2 / P2-4 flags thread into the OOS run", () => {
  it("passes oosPurgeEmbargo + icWeightShrinkage to runWalkForwardOOS on the autonomous path", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `flags-${randomUUID()}`;
    setPolicy(policyFor("FLAGS", { autoApplyWeights: true, oosWithholdUnvalidated: true, oosPurgeEmbargo: true, icWeightShrinkage: 0.5 }), userId);
    await seedClosedLots("FLAGS", userId, 22);
    mockRunWalkForwardOOS.mockResolvedValue(oosResult());

    await applyAutonomousWeightTuning(userId);
    // The autonomous re-validation call (last call) must carry the two opt-in options.
    const calls = mockRunWalkForwardOOS.mock.calls as unknown[][];
    const lastOpts = calls[calls.length - 1]?.[1] as { purgeEmbargo?: boolean; icWeightShrinkage?: number } | undefined;
    expect(lastOpts?.purgeEmbargo).toBe(true);
    expect(lastOpts?.icWeightShrinkage).toBe(0.5);
  });

  it("DEFAULT: the OOS run receives purgeEmbargo=false + icWeightShrinkage=0 (byte-identical)", async () => {
    const { setPolicy } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const userId = `flags-off-${randomUUID()}`;
    setPolicy(policyFor("FLAGSOFF", { autoApplyWeights: true, oosWithholdUnvalidated: true }), userId);
    await seedClosedLots("FLAGSOFF", userId, 22);
    mockRunWalkForwardOOS.mockResolvedValue(oosResult());
    await applyAutonomousWeightTuning(userId);
    const calls = mockRunWalkForwardOOS.mock.calls as unknown[][];
    const lastOpts = calls[calls.length - 1]?.[1] as { purgeEmbargo?: boolean; icWeightShrinkage?: number } | undefined;
    expect(lastOpts?.purgeEmbargo).toBe(false);
    expect(lastOpts?.icWeightShrinkage).toBe(0);
  });
});

describe("P1-3 shadow ledger", () => {
  it("DEFAULT (shadow off, autoApply off): no shadow row and no policy change", async () => {
    const { setPolicy, getPolicy, listLearningMutations } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning } = await import("../src/lib/strategy-tuning");
    const { LEARNING_SUBSYSTEM_SCORING_WEIGHTS } = await import("../src/lib/learning-ledger");
    const userId = `shadow-off-${randomUUID()}`;
    setPolicy(policyFor("SHOFF"), userId);
    await seedClosedLots("SHOFF", userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };
    mockRunWalkForwardOOS.mockResolvedValue(oosResult());

    const result = await applyAutonomousWeightTuning(userId);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("autoApplyWeights_off");
    expect(getPolicy(userId).scoringWeights).toEqual(before);
    expect(listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS })).toHaveLength(0);
  });

  it("shadow ON, autoApply OFF: records a passive shadow ledger row WITHOUT touching policy", async () => {
    const { setPolicy, getPolicy, listLearningMutations } = await import("../src/lib/db");
    const { applyAutonomousWeightTuning, AUTO_WEIGHT_SHADOW_TRIGGER } = await import("../src/lib/strategy-tuning");
    const { LEARNING_SUBSYSTEM_SCORING_WEIGHTS } = await import("../src/lib/learning-ledger");
    const userId = `shadow-on-${randomUUID()}`;
    setPolicy(policyFor("SHON", { shadowWeightLedger: true }), userId);
    await seedClosedLots("SHON", userId, 22);
    const before = { ...getPolicy(userId).scoringWeights };
    mockRunWalkForwardOOS.mockResolvedValue(oosResult());

    const result = await applyAutonomousWeightTuning(userId);
    // No real apply (autoApply off), but a shadow row is written.
    expect(result.applied).toBe(false);
    expect(getPolicy(userId).scoringWeights).toEqual(before); // policy UNCHANGED
    const rows = listLearningMutations(userId, { subsystem: LEARNING_SUBSYSTEM_SCORING_WEIGHTS });
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(AUTO_WEIGHT_SHADOW_TRIGGER);
    expect((rows[0].evidence as { shadow?: boolean; wouldApply?: boolean }).shadow).toBe(true);
    expect((rows[0].evidence as { wouldApply?: boolean }).wouldApply).toBe(true);
  });
});
