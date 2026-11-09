// tuning-invariants.ts — PURE, always-on validator of a small set of HARD safety couplings in the
// tuning config (panel P0-3). It gates NOTHING on its own; callers decide what to do with the result:
//   - the AUTONOMOUS apply path fails CLOSED on any violation (skip the apply, write an audited
//     "skipped: invariant violation" row) — it must NEVER throw, or a throw would wedge the scheduler tick;
//   - the manual tune route surfaces the same violations as WARNINGS, not blocks.
//
// Scope is intentionally minimal: only couplings whose violation could make an AUTONOMOUS weight apply
// unsafe. It does not re-validate every field (defaults.ts / clamps already do bounds work) — it checks
// the invariants that the auto-apply path RELIES ON being true.

import type { TuningSettings } from "./types";

export interface TuningInvariantViolation {
  /** Stable machine code for tests/telemetry. */
  code: string;
  /** Human-readable explanation. */
  message: string;
}

export interface TuningInvariantResult {
  ok: boolean;
  violations: TuningInvariantViolation[];
}

/**
 * PURE. Validate a small set of hard safety couplings in the tuning settings. Never throws.
 *
 * Checks:
 *  - sample-count gates are strictly positive when set (`minClosedLotsForWeightShift`,
 *    `recurringFactorMinCount`): a non-positive gate would let a zero-evidence apply through;
 *  - `shrinkPrior` is NON-NEGATIVE when set: 0 is a VALID "no shrinkage" setting (mirrors
 *    `resolveShrinkPrior`, which accepts `v >= 0`), so only a negative prior is invalid here;
 *  - `sizingFloorPct <= sizingCeilingPct` when both set (an inverted band is an unsafe sizer config);
 *  - `autoApplyWeights ⇒ oosWithholdUnvalidated` (unless the explicit `autoApplyOverrideUnvalidated`
 *    override is set — which must be the real boolean `true`): autonomy must not run while the OOS gate
 *    is configured to KEEP unvalidated weight moves — that would defeat the very gate autonomy leans on;
 *  - `calibrationSizing ⇒ a valid per-band sample gate` (`minClosedLotsForWeightShift > 0`): calibrated
 *    sizing without a band gate can size off a 1-lot band.
 *
 * @param tuning the `policy.tuning` settings (may be undefined → treated as all-defaults, which is valid).
 */
export function validateTuningInvariants(tuning: TuningSettings | undefined): TuningInvariantResult {
  const violations: TuningInvariantViolation[] = [];
  const t = tuning ?? {};

  const positiveIfSet = (value: number | undefined, code: string, label: string): void => {
    if (typeof value === "number" && !(value > 0)) {
      violations.push({ code, message: `${label} must be > 0 when set (got ${value}).` });
    }
  };
  positiveIfSet(t.minClosedLotsForWeightShift, "min_closed_lots_nonpositive", "minClosedLotsForWeightShift");
  positiveIfSet(t.recurringFactorMinCount, "recurring_factor_min_nonpositive", "recurringFactorMinCount");
  // shrinkPrior: 0 is a valid "no shrinkage" setting (resolveShrinkPrior accepts v>=0) — only a NEGATIVE
  // prior is invalid. Do NOT treat 0 as invalid or the autonomous path fails closed on a valid config.
  if (typeof t.shrinkPrior === "number" && t.shrinkPrior < 0) {
    violations.push({ code: "shrink_prior_negative", message: `shrinkPrior must be >= 0 when set (got ${t.shrinkPrior}).` });
  }

  if (
    typeof t.sizingFloorPct === "number" &&
    typeof t.sizingCeilingPct === "number" &&
    t.sizingFloorPct > t.sizingCeilingPct
  ) {
    violations.push({
      code: "sizing_floor_above_ceiling",
      message: `sizingFloorPct (${t.sizingFloorPct}) must be <= sizingCeilingPct (${t.sizingCeilingPct}).`
    });
  }

  // The override must be the REAL boolean `true` to clear this violation — a truthy non-boolean (e.g. the
  // JSON string "false", or 1) must NOT bypass the fail-closed guard.
  if (t.autoApplyWeights && t.oosWithholdUnvalidated === false && t.autoApplyOverrideUnvalidated !== true) {
    violations.push({
      code: "auto_apply_without_oos_withhold",
      message:
        "autoApplyWeights requires oosWithholdUnvalidated=true (or autoApplyOverrideUnvalidated===true) — " +
        "autonomy must not run while unvalidated weight moves are kept."
    });
  }

  if (t.calibrationSizing && typeof t.minClosedLotsForWeightShift === "number" && !(t.minClosedLotsForWeightShift > 0)) {
    violations.push({
      code: "calibration_without_band_gate",
      message: "calibrationSizing requires a positive minClosedLotsForWeightShift (per-band sample gate)."
    });
  }

  return { ok: violations.length === 0, violations };
}
