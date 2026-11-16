/**
 * Honest strategy-run terminal statuses and UI labels (UX PR-A1).
 *
 * Pre-decision gates (budget / market closed / broker unhealthy) finish as
 * distinct skip statuses — never as "completed". That keeps Activity/Thesis chips
 * from looking like successful decision cycles, and keeps liveness / auto-tune
 * from treating pure skips as healthy completions.
 *
 * Policy of *when* to skip is unchanged; this module is presentation + status
 * taxonomy only.
 */

/** Pre-decision skip class used for UI chips. */
export type StrategyRunSkipClass =
  | "budget"
  | "market_closed"
  | "broker_unhealthy"
  | "other";

/** Terminal skip statuses persisted on strategy_runs.status. */
export type StrategyRunSkipStatus =
  | "skipped_budget"
  | "skipped_market_closed"
  | "skipped_broker_unhealthy"
  /** Generic pre-decision skip (e.g. unfunded account) or legacy rows. */
  | "skipped";

/** All statuses finishStrategyRun may write. */
export type StrategyRunFinishStatus = "completed" | "failed" | StrategyRunSkipStatus;

/** Full strategy_runs.status union including in-flight. */
export type StrategyRunStatus = "running" | StrategyRunFinishStatus;

export const STRATEGY_RUN_SKIP_STATUSES: readonly StrategyRunSkipStatus[] = [
  "skipped_budget",
  "skipped_market_closed",
  "skipped_broker_unhealthy",
  "skipped"
] as const;

const SKIP_STATUS_SET = new Set<string>(STRATEGY_RUN_SKIP_STATUSES);

/** Chip / last-run copy for each skip class (acceptance labels for PR-A1). */
export const STRATEGY_RUN_SKIP_LABELS: Record<StrategyRunSkipClass, string> = {
  budget: "Skipped — LLM budget",
  market_closed: "Skipped — market closed",
  broker_unhealthy: "Skipped — broker unhealthy",
  other: "Skipped"
};

const STATUS_TO_CLASS: Record<StrategyRunSkipStatus, StrategyRunSkipClass> = {
  skipped_budget: "budget",
  skipped_market_closed: "market_closed",
  skipped_broker_unhealthy: "broker_unhealthy",
  skipped: "other"
};

/** True when status is any pre-decision skip (including legacy `skipped`). */
export function isStrategyRunSkipStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return SKIP_STATUS_SET.has(status) || status.startsWith("skipped_");
}

/** Only a completed decision cycle counts as a healthy success for liveness/auto-tune. */
export function isStrategyRunDecisionCompletion(status: string | null | undefined): boolean {
  return status === "completed";
}

export function strategyRunSkipClassFromStatus(status: string): StrategyRunSkipClass | null {
  if (status in STATUS_TO_CLASS) return STATUS_TO_CLASS[status as StrategyRunSkipStatus];
  if (status.startsWith("skipped_")) return "other";
  if (status === "skipped") return "other";
  return null;
}

/**
 * Classify a legacy `skipped` row (or free-text summary) into a skip class so
 * historical Activity rows still get honest chips without a DB migration.
 */
export function classifyStrategyRunSkip(
  status: string,
  summary?: string | null
): StrategyRunSkipClass | null {
  const fromStatus = strategyRunSkipClassFromStatus(status);
  if (fromStatus && fromStatus !== "other") return fromStatus;
  if (!isStrategyRunSkipStatus(status) && status !== "skipped") return fromStatus;

  const text = (summary ?? "").toLowerCase();
  if (!text) return fromStatus ?? (isStrategyRunSkipStatus(status) ? "other" : null);

  if (
    text.includes("market is closed") ||
    text.includes("market closed") ||
    text.includes("holiday or weekend")
  ) {
    return "market_closed";
  }
  if (
    text.includes("broker health") ||
    text.includes("broker unhealthy") ||
    text.includes("broker is unhealthy")
  ) {
    return "broker_unhealthy";
  }
  if (
    text.includes("budget") ||
    text.includes("llm/rag") ||
    text.includes("usage budget") ||
    text.includes("spend ceiling") ||
    text.includes("reservation")
  ) {
    return "budget";
  }
  return "other";
}

/**
 * Plain-English label for a strategy run status. Prefer this over raw enums on
 * Thesis last-run and Activity run chips.
 */
export function strategyRunStatusLabel(
  status: string | null | undefined,
  summary?: string | null
): string {
  if (!status) return "";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";

  const skipClass = classifyStrategyRunSkip(status, summary);
  if (skipClass) return STRATEGY_RUN_SKIP_LABELS[skipClass];

  // Defensive Title-Case for unknown future statuses.
  return status
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map skip class → finish status for strategy.ts finishStrategyRun call sites. */
export function finishStatusForSkipClass(cls: StrategyRunSkipClass): StrategyRunSkipStatus {
  switch (cls) {
    case "budget":
      return "skipped_budget";
    case "market_closed":
      return "skipped_market_closed";
    case "broker_unhealthy":
      return "skipped_broker_unhealthy";
    default:
      return "skipped";
  }
}
