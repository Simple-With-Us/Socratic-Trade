import { describe, expect, it } from "vitest";
import { HOLD_REASON_LABELS, classifyHoldReasonFromCodes, formatAwaitingApprovalSummary } from "../src/lib/hold-reason";
import type { HoldReasonCode, HumanReviewReasonCode } from "../src/lib/types";

// Root cause (2026-09-25, board 687a5fb4, lane G3): the owner's performance report found Autopilot
// ("decide") proposals landing "Awaiting approval" with no structured way to tell why. This suite
// covers the pure classifier that buckets the underlying HumanReviewReasonCode receipts into the
// coarser, aggregable holdReason used by the run summary, the console approval card, and
// GET /api/ops/performance's funnel.
describe("classifyHoldReasonFromCodes", () => {
  it("classifies initial_red_team as red_team_unavailable", () => {
    expect(classifyHoldReasonFromCodes(["initial_red_team"])).toBe("red_team_unavailable");
  });

  it("classifies final_size_red_team as red_team_unavailable", () => {
    expect(classifyHoldReasonFromCodes(["final_size_red_team"])).toBe("red_team_unavailable");
  });

  it("classifies pre_veto_override as policy_revert", () => {
    expect(classifyHoldReasonFromCodes(["pre_veto_override"])).toBe("policy_revert");
  });

  it("classifies override_resolution as policy_revert", () => {
    expect(classifyHoldReasonFromCodes(["override_resolution"])).toBe("policy_revert");
  });

  it("classifies a standalone rationale_collapse as other", () => {
    expect(classifyHoldReasonFromCodes(["rationale_collapse"])).toBe("other");
  });

  it("classifies no codes at all as other (safe default)", () => {
    expect(classifyHoldReasonFromCodes([])).toBe("other");
  });

  it("prefers red_team_unavailable over policy_revert when both are present", () => {
    const codes: HumanReviewReasonCode[] = ["pre_veto_override", "initial_red_team"];
    expect(classifyHoldReasonFromCodes(codes)).toBe("red_team_unavailable");
  });

  it("prefers policy_revert over other when both a policy code and rationale_collapse are present", () => {
    const codes: HumanReviewReasonCode[] = ["rationale_collapse", "override_resolution"];
    expect(classifyHoldReasonFromCodes(codes)).toBe("policy_revert");
  });

  it("has a label for every HoldReasonCode", () => {
    expect(Object.keys(HOLD_REASON_LABELS).sort()).toEqual(
      ["funding_sell", "other", "policy_revert", "red_team_unavailable"].sort()
    );
  });
});

// Audit of the merged G3 change (2026-09-29): an account demoted from Autopilot to Ask-first by a
// cap breach (autoRevertOnCapBreach) sends every later proposal in the run through the "propose"
// branch, which used to classify from the (usually empty) review codes and label the hold "other" —
// the exact case the policy_revert bucket exists for.
describe("classifyHoldReasonFromCodes — authority reverted in this run", () => {
  it("labels a code-less propose-branch hold policy_revert when authority was reverted this run", () => {
    expect(classifyHoldReasonFromCodes([], { authorityRevertedInRun: true })).toBe("policy_revert");
  });

  it("still prefers red_team_unavailable when the Red Team review is what needs a human", () => {
    expect(classifyHoldReasonFromCodes(["initial_red_team"], { authorityRevertedInRun: true })).toBe("red_team_unavailable");
  });

  it("prefers policy_revert over a standalone rationale_collapse when authority was reverted", () => {
    expect(classifyHoldReasonFromCodes(["rationale_collapse"], { authorityRevertedInRun: true })).toBe("policy_revert");
  });

  it("stays other when authority was NOT reverted", () => {
    expect(classifyHoldReasonFromCodes([], { authorityRevertedInRun: false })).toBe("other");
    expect(classifyHoldReasonFromCodes([])).toBe("other");
  });
});

// The persisted strategy_runs.summary is what the owner and GET /api/ops/performance read; it used
// to say only "Awaiting approval: N." so the structured holdReason never reached the run summary.
describe("formatAwaitingApprovalSummary", () => {
  const held = (holdReason?: HoldReasonCode) => ({ status: "proposed", proposal: { holdReason } });

  it("returns an empty string when nothing is awaiting approval", () => {
    expect(formatAwaitingApprovalSummary([{ status: "placed", proposal: {} }, { status: "blocked", proposal: {} }])).toBe("");
  });

  it("breaks the count down by cause, biggest first then by label", () => {
    const summary = formatAwaitingApprovalSummary([
      held("policy_revert"),
      held("red_team_unavailable"),
      held("red_team_unavailable"),
      held("funding_sell"),
      { status: "placed", proposal: {} }
    ]);
    expect(summary).toBe("Awaiting approval: 4 (Red Team review needed: 2, Funding sell: 1, Policy hold: 1).");
  });

  it("counts a held proposal that carries no holdReason as Other so the parts sum to the total", () => {
    expect(formatAwaitingApprovalSummary([held(undefined), held("other")])).toBe("Awaiting approval: 2 (Other: 2).");
  });
});
