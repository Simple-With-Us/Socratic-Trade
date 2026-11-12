import type { HoldReasonCode, HumanReviewReasonCode } from "./types";

// Root cause (2026-09-25, board 687a5fb4, lane G3): the owner's performance report found 4
// Autopilot ("decide") proposals landing "Awaiting approval" on 2026-09-23 with no structured way
// to tell why — every hold rendered the same generic status with only free-text `reasons` to read.
// This module gives every held proposal a small, aggregable cause bucket instead.

/** Owner-facing label for each `HoldReasonCode`, sentence case (matches this app's copy rules). */
export const HOLD_REASON_LABELS: Record<HoldReasonCode, string> = {
  red_team_unavailable: "Red Team review needed",
  funding_sell: "Funding sell",
  policy_revert: "Policy hold",
  other: "Other"
};

/**
 * Classifies the `HumanReviewReasonCode`s already stamped onto a held proposal
 * (`TradeProposal.humanReviewReasons`, see strategy.ts's `stampHumanReviewReasons`) into the
 * coarser `HoldReasonCode` bucket. Used at the two strategy.ts insertion sites whose hold can
 * carry ANY of the five underlying codes (the "propose" authority branch and the
 * `requiresHumanReview` fail-closed branch); the other two sites (sell-to-fund, the escalation
 * framework) set their own `HoldReasonCode` directly since neither is expressed as a
 * `HumanReviewReasonCode` at all.
 *
 * "initial_red_team" and "final_size_red_team" both mean "the Red Team side of this decision
 * needs a human call" — either the review could not run, or it ran and its own verdict (reject /
 * an unplaceable half-size) requires owner sign-off — so both map to "red_team_unavailable".
 * "pre_veto_override" and "override_resolution" both mean an app policy/preference override
 * request needs a decision, so both map to "policy_revert". Anything else (e.g. a standalone
 * "rationale_collapse" hold, or no codes at all) maps to "other" — the safe default.
 *
 * `authorityRevertedInRun` (the "propose" authority branch only): the account was on Autopilot
 * when the run started and a cap breach demoted it to Ask-first mid-run (autoRevertOnCapBreach), so
 * every later proposal in the run is held BECAUSE of that policy revert even though it carries no
 * review code.  It outranks the catch-all "other" but never a Red Team code.
 */
export function classifyHoldReasonFromCodes(
  codes: HumanReviewReasonCode[],
  opts: { authorityRevertedInRun?: boolean } = {}
): HoldReasonCode {
  if (codes.some((code) => code === "initial_red_team" || code === "final_size_red_team")) {
    return "red_team_unavailable";
  }
  if (opts.authorityRevertedInRun || codes.some((code) => code === "pre_veto_override" || code === "override_resolution")) {
    return "policy_revert";
  }
  return "other";
}

/**
 * The "Awaiting approval" clause of the persisted run summary (`strategy_runs.summary`, the text
 * the owner reads on the Runs page and that GET /api/ops/performance links to), broken down by
 * `holdReason` so the summary itself says WHY — "Awaiting approval: 4 (Red Team review needed: 3,
 * Policy hold: 1)." — instead of a bare count.  Returns "" when nothing is awaiting approval.  A
 * held result with no `holdReason` (should not happen after this change) counts as Other so the
 * parts always sum to the total.  Biggest bucket first, ties by label.
 */
export function formatAwaitingApprovalSummary(
  results: ReadonlyArray<{ status: string; proposal?: { holdReason?: HoldReasonCode } }>
): string {
  const held = results.filter((result) => result.status === "proposed");
  if (held.length === 0) return "";
  const counts = new Map<HoldReasonCode, number>();
  for (const result of held) {
    const reason = result.proposal?.holdReason ?? "other";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .map(([reason, count]) => ({ label: HOLD_REASON_LABELS[reason], count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(({ label, count }) => `${label}: ${count}`);
  return `Awaiting approval: ${held.length} (${parts.join(", ")}).`;
}
