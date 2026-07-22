/** Shared client-side helpers for rendering the Red Team (adversarial review) verdict —
 *  including the FAILURE states that were previously persisted but never shown. Label text
 *  reuses describeRedTeamFailureKind (src/lib/red-team-routing.ts, a pure leaf module) so the
 *  chip wording matches the "(provider error)"-style suffixes already stamped into proposal
 *  rationales by the policy-aware routing path. Pure module: safe for console AND mobile. */

import { isModelRotationSentinel } from "@/lib/llm-request";
import { describeRedTeamFailureKind } from "@/lib/red-team-routing";
import type { TradeProposal } from "@/lib/types";

export type RedTeamVerdict = NonNullable<TradeProposal["redTeamVerdict"]>;

/** A FAILED review (verdict.available === false) is a snapshot of the moment the review couldn't
 *  run — it says nothing about what happened afterward. `redTeamVerdictLabel` needs the LATER
 *  deterministic/broker outcome status (e.g. the persisted `SocraticDecisionStatus` /
 *  `RecentProposal.status`) so it can stop asserting "held for human approval" once that approval
 *  has already happened (or the proposal was otherwise resolved) — the live thesis used to show
 *  the stale claim right next to a deterministic-outcome section reading "Order filled"
 *  simultaneously. Undefined/unrecognized status values are treated as "still pending" — the
 *  honest default when the outcome isn't known yet. */
function subsequentOutcomePhrase(outcomeStatus?: string): string | undefined {
  switch (outcomeStatus) {
    case "filled":
    case "placed":
      return "subsequently approved and executed";
    case "placing":
      return "subsequently approved; execution pending confirmation";
    case "blocked":
      return "subsequently blocked by policy before placement";
    case "rejected":
      return "subsequently rejected by the user";
    case "rejected_by_broker":
      return "subsequently approved, but rejected by the broker";
    case "not_placed":
    case "placing_failed":
    case "error":
    case "failed":
      return "subsequently approved, but never placed";
    case "expired":
      return "left pending until it expired, unreviewed";
    case "withdrawn":
      return "subsequently withdrawn before a decision";
    // "proposed" | "pending" | "planned" | "observed" | undefined | anything else: no resolved
    // outcome exists yet — the original "held for human approval" framing is still accurate.
    default:
      return undefined;
  }
}

/** Plain-language outcome of the review itself — deliberately distinct from the later deterministic
 * policy/broker outcome. "Approved" means the reviewer found no reason to shrink/veto the thesis;
 * it does not claim the order was placed. A model-requested override is only called overridden when
 * the final policy decision confirms it was applied.
 *
 * `outcomeStatus` (optional) is the deterministic decision/proposal status recorded AFTER the
 * review — pass it whenever it's in scope. It only changes the output when the verdict itself is
 * unavailable: a FAILED review that was nonetheless followed by an approval/execution must say so
 * in the past tense instead of leaving a live "held for human approval" claim standing. */
export function redTeamVerdictLabel(verdict: RedTeamVerdict, overrideApplied?: boolean, outcomeStatus?: string): string {
  if (verdict.humanOverrideApplied) {
    if (!verdict.available) return "Review unavailable — approved by user";
    if (verdict.verdict === "approve-at-half") return "Half-size advice overridden by user";
    if (verdict.rejected || verdict.verdict === "reject") return "Objection overridden by user";
  }
  if (!verdict.available) {
    const subsequent = subsequentOutcomePhrase(outcomeStatus);
    return subsequent ? `Review unavailable; ${subsequent}` : "Review unavailable — held for human approval";
  }
  if (verdict.rejected && overrideApplied === true) return "Objection overridden";
  if (verdict.rejected && verdict.overridden && overrideApplied === undefined) return "Rejected — override requested";
  // The reviewer verdict and the deterministic/broker outcome are separate sections. A Red reject
  // may be queued for an owner decision, overridden by policy, or ultimately blocked, so do not
  // claim the later outcome here.
  if (verdict.rejected || verdict.verdict === "reject") return "Rejected by Red Team";
  if (verdict.verdict === "approve-at-half") return "Approved at half size";
  return "Approved at full size";
}

export function redTeamFailureMeta(failureKind: RedTeamVerdict["failureKind"]): { label: string; title: string } {
  const label = describeRedTeamFailureKind(failureKind);
  switch (failureKind) {
    case "not_configured":
      return { label, title: "No adversarial-review model/key is configured, so no Red Team verdict exists for this decision." };
    case "timeout":
      return { label, title: "The adversarial reviewer did not answer within the time limit, so no verdict exists — the proposal was routed per policy instead of silently passing." };
    case "provider_error":
      return { label, title: "The reviewer model's provider returned an error, so no adversarial verdict exists for this decision." };
    case "rate_limited":
      return { label, title: "The reviewer model's provider rate-limited the call, so no adversarial verdict exists for this decision." };
    case "malformed_response":
      return { label, title: "The reviewer model answered, but not in the required structured format — its verdict could not be trusted or used." };
    default:
      return { label, title: "The adversarial review could not run, so no verdict exists for this decision." };
  }
}

/** Which ONE of the three mutually-exclusive Red Team sections an approval card renders, given
 *  whether a structured verdict is present and the legacy `adversaryUnavailable` decision flag.
 *  Total by construction — exactly one state is returned — so the "review unavailable" note can
 *  never render alongside the verdict panel again. (Regression guard: a FAILED verdict used to
 *  satisfy both the verdict panel AND a separate unavailable callout, rendering the same
 *  provider-error text twice — the adversary-review-duplication bug.)
 *
 *  - "verdict-panel":      a structured verdict exists (available OR failed). The panel owns it,
 *                          including the failure state and its "sole adversary" framing.
 *  - "legacy-unavailable": no structured verdict, but the legacy flag says the review could not run
 *                          (proposals persisted before the single-adversary consolidation).
 *  - "no-review":          no verdict and no unavailable flag — the review simply never triggered. */
export type RedTeamCardState = "verdict-panel" | "legacy-unavailable" | "no-review";

export function redTeamCardState(hasVerdict: boolean, adversaryUnavailable: boolean): RedTeamCardState {
  if (hasVerdict) return "verdict-panel";
  if (adversaryUnavailable) return "legacy-unavailable";
  return "no-review";
}

/** The model to attribute a FAILED review to, without fabricating one: the verdict's own
 *  persisted model first; when the failure was "not configured" there IS no model — return
 *  null rather than blaming a configured/default model that never ran. A configured
 *  "__rotate__" sentinel is likewise never a model that ran (it is a rotation marker the run
 *  resolves to a concrete pick), so it must never be displayed as the failed reviewer. */
export function redTeamFailureModel(verdict: RedTeamVerdict, configuredRedTeamModel?: string | null): string | null {
  const persisted = verdict.model?.trim();
  if (persisted) return persisted;
  if (verdict.failureKind === "not_configured") return null;
  if (isModelRotationSentinel(configuredRedTeamModel)) return null;
  return configuredRedTeamModel?.trim() || null;
}
