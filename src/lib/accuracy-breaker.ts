// Accuracy breaker (nofx-style consecutive-miss safety mode, docs/oss-lessons.md §8).
//
// The drawdown breaker (risk-breaker.ts) bounds the account's BLEED; it says nothing about the
// account being WRONG. A thesis regime can degrade — every matured decision closing at a loss —
// long before a 15% drawdown would show it, especially with small positions. This module adds the
// missing accuracy brake: a rolling view over matured outcomes of REAL (placed/filled) decisions
// that fires when the recent tape is decisively adverse — a consecutive-loss streak and/or a
// rolling hit-rate below a floor — and maintains a per-account degraded marker that the strategy
// loop reacts to per `riskRules.accuracyBreakerAction` (advisory by default: receipt + one
// risk_advisory notification per degradation, no state change; opt-in close_only hard enforcement
// with a kill_switch notification and owner re-arm).
//
// `evaluateAccuracyBreaker` is pure (unit-tested in isolation). The degraded marker lives in the
// quiet internal settings KV (no audit spam), the same pattern as the drawdown breaker's
// hwm/sod markers. Counterfactual outcomes of blocked/rejected proposals never feed this
// breaker: avoiding a bad trade is a good call, not a miss (the DB helper in db-socratic.ts
// excludes them by decision status).

import { deleteInternalSetting, getInternalSetting, setInternalSetting } from "./db";

export type DecisiveOutcomeStatus = "won" | "lost" | "flat";

export interface AccuracyBreakerInputs {
  /** Matured decisive outcomes, NEWEST FIRST. */
  outcomes: DecisiveOutcomeStatus[];
  /** Consecutive-loss streak that fires the breaker. Undefined/<=0 disables the streak trigger. */
  consecutiveLosses?: number;
  /** Rolling hit-rate window size. Undefined/<=0 disables the hit-rate trigger. */
  windowSize?: number;
  /** Hit-rate floor (%) over the window; only meaningful with windowSize. */
  minHitRatePct?: number;
  /** Most-recent clean (non-loss) outcomes required to clear a degraded marker. Default 2. */
  recoveryClean?: number;
  /** Whether the degraded marker is currently set. */
  degraded: boolean;
}

export interface AccuracyBreakerEvaluation {
  /** Breaker fires NOW (new degradation). Only true when the marker was absent. */
  firing: boolean;
  trigger?: "streak" | "hit-rate";
  /** Previously degraded and the recent tape is clean — the marker should clear. */
  recovered: boolean;
  reason?: string;
  consecutiveLossStreak: number;
  decisiveCount: number;
  hitRatePct?: number;
}

const DEFAULT_RECOVERY_CLEAN = 2;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined; // unset/<=0 = disabled, never clamped up into "on"
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Pure breaker evaluation. Two independent OPT-IN triggers (either fires the breaker):
 *  - streak: the newest `consecutiveLosses` decisive outcomes are ALL "lost" (a "flat" or "won"
 *    breaks the streak — a flat is not a loss, but it is not evidence of a broken thesis either,
 *    so it still resets the adverse run);
 *  - hit-rate: over the last `windowSize` decisive outcomes the win rate is below
 *    `minHitRatePct` — evaluated only once a FULL window exists, so a tiny sample can never fire.
 * When already degraded, the breaker instead watches for recovery: the `recoveryClean`
 * most-recent decisive outcomes (default 2) showing no loss.
 */
export function evaluateAccuracyBreaker(input: AccuracyBreakerInputs): AccuracyBreakerEvaluation {
  const { outcomes, degraded } = input;
  const decisiveCount = outcomes.length;

  let consecutiveLossStreak = 0;
  for (const status of outcomes) {
    if (status === "lost") consecutiveLossStreak += 1;
    else break;
  }

  const windowSize = clampInt(input.windowSize, 3, 100);
  const minHitRatePct =
    typeof input.minHitRatePct === "number" && Number.isFinite(input.minHitRatePct) && input.minHitRatePct > 0
      ? Math.min(100, input.minHitRatePct)
      : undefined;
  let hitRatePct: number | undefined;
  if (windowSize !== undefined && minHitRatePct !== undefined && decisiveCount >= windowSize) {
    const window = outcomes.slice(0, windowSize);
    const won = window.filter((status) => status === "won").length;
    hitRatePct = (won / window.length) * 100;
  }

  if (degraded) {
    const recoveryClean = clampInt(input.recoveryClean, 1, 20) ?? DEFAULT_RECOVERY_CLEAN;
    const recent = outcomes.slice(0, recoveryClean);
    const recovered = recent.length >= recoveryClean && recent.every((status) => status !== "lost");
    return { firing: false, recovered, consecutiveLossStreak, decisiveCount, hitRatePct };
  }

  const streakLimit = clampInt(input.consecutiveLosses, 1, 50) ?? 0;  const streakFires = streakLimit > 0 && consecutiveLossStreak >= streakLimit;
  const rateFires = hitRatePct !== undefined && minHitRatePct !== undefined && hitRatePct < minHitRatePct;
  if (!streakFires && !rateFires) {
    return { firing: false, recovered: false, consecutiveLossStreak, decisiveCount, hitRatePct };
  }

  const trigger = streakFires ? "streak" : "hit-rate";
  const reason = streakFires
    ? `The last ${consecutiveLossStreak} matured trade${consecutiveLossStreak === 1 ? "" : "s"} all closed at a loss (streak limit ${streakLimit}).`
    : `Rolling hit rate ${hitRatePct!.toFixed(1)}% over the last ${windowSize} decisive outcomes is below the ${minHitRatePct}% floor.`;
  return { firing: true, trigger, recovered: false, reason, consecutiveLossStreak, decisiveCount, hitRatePct };
}

// ── Degraded-marker persistence (quiet internal settings KV) ─────────────────

export interface AccuracyDegradedMarker {
  since: string;
  reason: string;
  trigger: "streak" | "hit-rate";
  /** The action the breaker took when it fired — owner re-arm after a close_only flip clears the marker. */
  action: "advisory" | "close_only";
}

const markerKey = (userId: string, accountScope: string) => `risk:accuracy-degraded:${userId}:${accountScope}`;

export function getAccuracyDegradedMarker(userId: string, accountScope: string): AccuracyDegradedMarker | undefined {
  const raw = getInternalSetting<AccuracyDegradedMarker>(markerKey(userId, accountScope));
  if (!raw || typeof raw !== "object" || typeof raw.since !== "string") return undefined;
  return raw;
}

export function setAccuracyDegradedMarker(userId: string, accountScope: string, marker: AccuracyDegradedMarker): void {
  setInternalSetting(markerKey(userId, accountScope), marker);
}

export function clearAccuracyDegradedMarker(userId: string, accountScope: string): void {
  deleteInternalSetting(markerKey(userId, accountScope));
}
