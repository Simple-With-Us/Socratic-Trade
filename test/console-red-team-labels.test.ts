import { describe, expect, it } from "vitest";
import { redTeamCardState, redTeamFailureMeta, redTeamFailureModel, redTeamVerdictLabel, type RedTeamVerdict } from "../app/console/lib/red-team";
import { deterministicOutcomePresentation, isSuccessfulApprovalResult, proposalGreenRationale, proposalHumanReviewReasons } from "../app/console/lib/thesis";

function verdict(overrides: Partial<RedTeamVerdict>): RedTeamVerdict {
  return { rejected: false, available: false, reason: "Red Team evaluation failed.", ...overrides };
}

describe("redTeamFailureMeta", () => {
  it("matches the server-side describeRedTeamFailureKind wording for every kind", () => {
    expect(redTeamFailureMeta("not_configured").label).toBe("not configured");
    expect(redTeamFailureMeta("timeout").label).toBe("timeout");
    expect(redTeamFailureMeta("provider_error").label).toBe("provider error");
    expect(redTeamFailureMeta("rate_limited").label).toBe("rate limited");
    expect(redTeamFailureMeta("malformed_response").label).toBe("malformed response");
    expect(redTeamFailureMeta(undefined).label).toBe("unavailable");
  });

  it("always carries a plain-English hover explanation", () => {
    for (const kind of ["not_configured", "timeout", "provider_error", "rate_limited", "malformed_response", undefined] as const) {
      expect(redTeamFailureMeta(kind).title.length).toBeGreaterThan(20);
    }
  });
});

describe("decision evidence presentation", () => {
  it("treats a synchronous broker fill as a successful approval result", () => {
    expect(isSuccessfulApprovalResult("filled")).toBe(true);
    expect(isSuccessfulApprovalResult("placed")).toBe(true);
    expect(isSuccessfulApprovalResult("blocked")).toBe(false);
  });

  it("keeps appended Red/owner-hold prose out of the Green Team panel", () => {
    expect(
      proposalGreenRationale({
        symbol: "EXE",
        side: "buy",
        type: "market",
        dollarAmount: 4,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Green-only thesis.\n\nRed Team review — final broker-adjusted size requires owner approval: objection.",
        greenTeamRationale: "Green-only thesis.",
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "Neutral"
      })
    ).toBe("Green-only thesis.");
  });

  it("describes an uncertain placement as pending confirmation, never safe to retry", () => {
    const presentation = deterministicOutcomePresentation("placing");
    expect(presentation?.label).toBe("Placement pending confirmation");
    expect(presentation?.body).not.toMatch(/retry/i);
  });

  it("keeps an independent owner hold separate from the Red Team verdict", () => {
    expect(
      proposalHumanReviewReasons({
        symbol: "EXE",
        side: "buy",
        type: "market",
        dollarAmount: 4,
        timeInForce: "gfd",
        marketHours: "regular_hours",
        rationale: "Green thesis.",
        tradeThesisTag: "Value-Quality",
        entryMarketRegime: "Neutral",
        redTeamVerdict: { available: true, rejected: false, verdict: "approve", reason: "Approved." },
        humanReviewReasons: [
          { code: "rationale_collapse", title: "Rationale-diversity hold", summary: "The proposals repeated the same reasoning." }
        ]
      })
    ).toEqual([
      { code: "rationale_collapse", title: "Rationale-diversity hold", summary: "The proposals repeated the same reasoning." }
    ]);
  });
});

describe("redTeamVerdictLabel", () => {
  it("names the review result without implying the order executed", () => {
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "approve" }))).toBe("Approved at full size");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "approve-at-half" }))).toBe("Approved at half size");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "reject", rejected: true }))).toBe("Rejected by Red Team");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "reject", rejected: true, overridden: true }))).toBe("Rejected — override requested");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "reject", rejected: true, overridden: true }), false)).toBe("Rejected by Red Team");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "reject", rejected: true, overridden: true }), true)).toBe("Objection overridden");
    expect(redTeamVerdictLabel(verdict({ available: false }))).toBe("Review unavailable — held for human approval");
    expect(redTeamVerdictLabel(verdict({ available: false, humanOverrideApplied: true }))).toBe("Review unavailable — approved by user");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "reject", rejected: true, humanOverrideApplied: true }))).toBe("Objection overridden by user");
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "approve-at-half", humanOverrideApplied: true }))).toBe("Half-size advice overridden by user");
  });
});

describe("redTeamVerdictLabel outcome-status temporality (item 22: no stale 'held for approval' next to a resolved outcome)", () => {
  it("keeps the live 'held for human approval' framing while no resolved outcome exists", () => {
    for (const status of [undefined, "proposed", "pending", "planned", "observed", "some-unrecognized-status"]) {
      expect(redTeamVerdictLabel(verdict({ available: false }), undefined, status)).toBe("Review unavailable — held for human approval");
    }
  });

  it("switches to a past-tense outcome once the proposal was subsequently filled or placed", () => {
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "filled")).toBe("Review unavailable; subsequently approved and executed");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "placed")).toBe("Review unavailable; subsequently approved and executed");
    // "placing" means the approval already happened — only broker confirmation is outstanding.
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "placing")).toBe("Review unavailable; subsequently approved; execution pending confirmation");
  });

  it("reports a subsequent rejection/block accurately instead of claiming it's still pending", () => {
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "blocked")).toBe("Review unavailable; subsequently blocked by policy before placement");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "rejected")).toBe("Review unavailable; subsequently rejected by the user");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "rejected_by_broker")).toBe("Review unavailable; subsequently approved, but rejected by the broker");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "not_placed")).toBe("Review unavailable; subsequently approved, but never placed");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "expired")).toBe("Review unavailable; left pending until it expired, unreviewed");
    expect(redTeamVerdictLabel(verdict({ available: false }), undefined, "withdrawn")).toBe("Review unavailable; subsequently withdrawn before a decision");
  });

  it("never applies the outcome-status phrase to an AVAILABLE verdict (only the failed-review path is outcome-aware)", () => {
    expect(redTeamVerdictLabel(verdict({ available: true, verdict: "approve" }), undefined, "filled")).toBe("Approved at full size");
  });

  it("a human-override-approved FAILED review keeps its own wording regardless of outcome status", () => {
    expect(redTeamVerdictLabel(verdict({ available: false, humanOverrideApplied: true }), undefined, "filled")).toBe("Review unavailable — approved by user");
  });
});

describe("redTeamCardState (exactly one Red Team section — no double-render)", () => {
  it("a FAILED verdict is owned solely by the verdict panel (regression: adversary-review-duplication)", () => {
    // The bug: a failed review satisfied BOTH the verdict panel AND a separate "unavailable"
    // callout, printing the same provider-error text twice. The panel must be the only owner —
    // even when the legacy adversaryUnavailable flag is ALSO set on the same decision.
    expect(redTeamCardState(true, false)).toBe("verdict-panel");
    expect(redTeamCardState(true, true)).toBe("verdict-panel");
  });

  it("an available verdict renders the panel", () => {
    expect(redTeamCardState(true, false)).toBe("verdict-panel");
  });

  it("only shows the legacy 'unavailable' callout when there is NO structured verdict", () => {
    expect(redTeamCardState(false, true)).toBe("legacy-unavailable");
  });

  it("shows the 'no review triggered' note when nothing ran and no unavailable flag is set", () => {
    expect(redTeamCardState(false, false)).toBe("no-review");
  });

  it("is total and mutually exclusive across all four input combinations", () => {
    const states = [
      redTeamCardState(true, true),
      redTeamCardState(true, false),
      redTeamCardState(false, true),
      redTeamCardState(false, false),
    ];
    // Every input yields exactly one defined state; the verdict panel wins whenever a verdict exists.
    expect(states.every((s) => s === "verdict-panel" || s === "legacy-unavailable" || s === "no-review")).toBe(true);
    expect(states.filter((s) => s === "legacy-unavailable")).toHaveLength(1);
  });
});

describe("redTeamFailureModel (never blame a model that provably never ran)", () => {
  it("prefers the persisted verdict model", () => {
    expect(redTeamFailureModel(verdict({ model: "deepseek-reasoner", failureKind: "timeout" }), "gpt-5.4-mini")).toBe("deepseek-reasoner");
  });

  it("returns null for not_configured even when a policy model exists — no model was ever called", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "not_configured" }), "gpt-5.4-mini")).toBeNull();
  });

  it("falls back to the configured red-team model for runtime failures without a persisted model", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns null when nothing is known", () => {
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), undefined)).toBeNull();
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "   ")).toBeNull();
  });

  it("never displays the '__rotate__' rotation sentinel as the failed reviewer", () => {
    // A rotating policy's configured value is a rotation marker, not a model that ran — the
    // fallback must skip it (a persisted concrete pick on the verdict still wins as usual).
    expect(redTeamFailureModel(verdict({ failureKind: "provider_error" }), "__rotate__")).toBeNull();
    expect(redTeamFailureModel(verdict({ model: "gpt-5.4-mini", failureKind: "timeout" }), "__rotate__")).toBe("gpt-5.4-mini");
  });
});
