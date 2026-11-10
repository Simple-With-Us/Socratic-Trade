// Per-stage remaining-vs-deadline policy for the Coach tool loop.
// First step always runs. Later steps skip when remaining time is below the
// owner-adjustable minimum useful-work budget (default 15s).

export const DEFAULT_CHAT_STAGE_MIN_BUDGET_MS = 15_000;

export type StageBudgetDecision =
  | { action: "run"; remainingMs: number; minStageMs: number }
  | { action: "skip"; remainingMs: number; minStageMs: number; reason: string };

export function decideStageBudget(input: {
  stepIndex: number;
  deadlineMs: number;
  nowMs?: number;
  minStageBudgetMs?: number;
}): StageBudgetDecision {
  const now = typeof input.nowMs === "number" ? input.nowMs : Date.now();
  const remainingMs = input.deadlineMs - now;
  const minStageMs =
    typeof input.minStageBudgetMs === "number" && Number.isFinite(input.minStageBudgetMs)
      ? Math.max(0, Math.floor(input.minStageBudgetMs))
      : DEFAULT_CHAT_STAGE_MIN_BUDGET_MS;
  if (input.stepIndex <= 0) {
    return { action: "run", remainingMs, minStageMs };
  }
  if (remainingMs < minStageMs) {
    return {
      action: "skip",
      remainingMs,
      minStageMs,
      reason: remainingMs <= 0 ? "deadline_exhausted" : "remaining_below_min_stage"
    };
  }
  return { action: "run", remainingMs, minStageMs };
}
