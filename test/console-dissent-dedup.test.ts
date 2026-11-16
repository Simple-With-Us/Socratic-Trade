import { describe, expect, it } from "vitest";
import { dissentItemsForDisplay } from "../app/console/lib/dissent";
import { redTeamVerdictLabel } from "../app/console/lib/red-team";
import type { SocraticDecisionCase, SocraticEvidenceItem } from "../src/lib/types";

const REASON = "approve-at-half: Strong fundamentals, but execution risk warrants half size.";

function item(kind: SocraticEvidenceItem["kind"], title: string, summary: string): SocraticEvidenceItem {
  return { kind, title, summary, tone: "warning" };
}

function decision(
  dissent: SocraticEvidenceItem[],
  reason: string | null = REASON,
  verdict: "approve" | "approve-at-half" | "reject" = "approve-at-half"
) {
  return {
    dissent,
    ...(reason
      ? {
          redTeamVerdict: {
            verdict,
            rejected: verdict === "reject",
            available: true,
            reason,
            model: "gpt-5.6-terra",
            trigger: "all_openings" as const
          }
        }
      : {})
  } satisfies Pick<SocraticDecisionCase, "dissent" | "redTeamVerdict">;
}

describe("dissentItemsForDisplay", () => {
  it("renders the Red Team reasoning once and keeps a distinct policy objection", () => {
    const distinct = item("policy", "Policy counterargument", "Sector exposure would exceed 35% of NAV.");
    const visible = dissentItemsForDisplay(
      decision([
        item("red_team", "Red Team objection", REASON),
        item("policy", "Policy counterargument", `Red Team approve-at-half haircut applied: ${REASON}`),
        distinct
      ])
    );

    expect(visible).toEqual([distinct]);
  });

  it("keeps the half-size verdict explicit while suppressing its duplicate policy rationale", () => {
    const caseWithHalfSizeVerdict = decision([
      item("policy", "Policy counterargument", `Red Team approve-at-half haircut applied: ${REASON}`)
    ]);

    expect(dissentItemsForDisplay(caseWithHalfSizeVerdict)).toEqual([]);
    expect(redTeamVerdictLabel(caseWithHalfSizeVerdict.redTeamVerdict!)).toBe("Approved at half size");
  });

  it("keeps the rejection status explicit while suppressing its duplicate Red Team rationale", () => {
    const rejectionReason = "Execution risk makes the downside asymmetric.";
    const rejectedCase = decision(
      [item("red_team", "Red Team rejection", rejectionReason)],
      rejectionReason,
      "reject"
    );

    expect(dissentItemsForDisplay(rejectedCase)).toEqual([]);
    expect(redTeamVerdictLabel(rejectedCase.redTeamVerdict!)).toBe("Rejected by Red Team");
  });

  it("also removes generated failure and veto wrappers around the shown verdict reason", () => {
    expect(
      dissentItemsForDisplay(
        decision([
          item("policy", "Policy counterargument", `Red Team review unavailable (provider error): ${REASON}`),
          item("policy", "Policy counterargument", `red_team_veto: ${REASON}`)
        ])
      )
    ).toEqual([]);
  });

  it("preserves Red Team rows that add meaningful override context even when summary matches the bare verdict reason", () => {
    // The override context is only in the title ("overridden"), not the
    // summary text. Production override items keep `redTeamVerdict.reason`
    // as-is for summary — the "overridden" annotation is title-only.
    const overridden = item(
      "red_team",
      "Red Team rejection (overridden)",
      REASON
    );

    expect(dissentItemsForDisplay(decision([overridden]))).toEqual([overridden]);
  });

  it("preserves Red Team rows that add meaningful override context with an annotated summary", () => {
    const overridden = item(
      "red_team",
      "Red Team rejection (overridden)",
      `${REASON} — overridden by a logged autonomy thesis; trade allowed to proceed.`
    );

    expect(dissentItemsForDisplay(decision([overridden]))).toEqual([overridden]);
  });

  it("keeps the first generic dissent item when no structured verdict owns it", () => {
    const first = item("red_team", "Red Team objection", REASON);
    const duplicate = item("policy", "Policy counterargument", REASON);

    expect(dissentItemsForDisplay(decision([first, duplicate], null))).toEqual([first]);
  });
});
