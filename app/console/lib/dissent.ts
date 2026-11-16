import type { SocraticDecisionCase, SocraticEvidenceItem } from "@/lib/types";

const GENERATED_RED_TEAM_POLICY_PREFIXES = [
  /^red team approve-at-half haircut applied:\s*/i,
  /^red team review unavailable(?:\s*\([^)]*\))?:\s*/i,
  /^red_team_veto:\s*/i
];

function normalizedSummary(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isGeneratedRedTeamPolicyEcho(item: SocraticEvidenceItem, redTeamReason: string): boolean {
  if (item.kind !== "policy") return false;
  for (const prefix of GENERATED_RED_TEAM_POLICY_PREFIXES) {
    const unwrapped = item.summary.replace(prefix, "");
    if (unwrapped !== item.summary && normalizedSummary(unwrapped) === redTeamReason) return true;
  }
  return false;
}

/**
 * The decision trace renders the structured Red Team verdict as the canonical
 * card. Older case files also copied that reason into generic dissent/policy
 * rows, so remove only those generated echoes while keeping distinct objections.
 */
export function dissentItemsForDisplay(
  decision: Pick<SocraticDecisionCase, "dissent" | "redTeamVerdict">
): SocraticEvidenceItem[] {
  const redTeamReason = decision.redTeamVerdict?.reason
    ? normalizedSummary(decision.redTeamVerdict.reason)
    : "";
  const seen = new Set<string>(redTeamReason ? [redTeamReason] : []);

  return decision.dissent.filter((item) => {
    // When the Red Team verdict was overridden, the dissent item carries context
    // the canonical verdict card doesn't show ("overridden" in title) even though
    // the summary text is identical — preserve it rather than dropping it as a
    // redundant echo of the verdict reason.
    if (item.kind === "red_team" && item.title?.toLowerCase().includes("overridden")) {
      seen.add(normalizedSummary(item.summary));
      return true;
    }

    const summary = normalizedSummary(item.summary);
    if (seen.has(summary)) return false;
    if (redTeamReason && isGeneratedRedTeamPolicyEcho(item, redTeamReason)) return false;
    seen.add(summary);
    return true;
  });
}
