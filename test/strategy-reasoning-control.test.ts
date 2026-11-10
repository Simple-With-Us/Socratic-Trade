/** The Strategy page's "Reasoning / Thinking Effort" control logic
 *  (app/console/strategy/reasoning-control.ts) — extracted pure helpers, with the
 *  rotation-sentinel awareness added for the rotation-UX fixes (2026-07-09) and the
 *  PER-SEAT patch helper from the per-team reasoning split (2026-07-10): each seat's
 *  select renormalizes ONLY its own field, and the reviewer's unset/inheriting state
 *  is never materialized by a model change. */

import { describe, expect, it } from "vitest";
import { ALL_LLM_REASONING_EFFORTS, LLM_MODEL_ROTATION_SENTINEL, resolveReviewerReasoningEffort } from "../src/lib/llm-request";
import {
  HIGH_TIER_REASONING_EFFORTS,
  normalizeReasoningValueForControl,
  reasoningControlForModels,
  reasoningSummary,
  seatReasoningPatch
} from "../app/console/strategy/reasoning-control";

const ROTATE = LLM_MODEL_ROTATION_SENTINEL;

describe("reasoningControlForModels — rotation sentinel keeps the control visible", () => {
  it("all-rotate seats get the full generic ladder (owner report: control used to vanish)", () => {
    const control = reasoningControlForModels([ROTATE, ROTATE]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual([...ALL_LLM_REASONING_EFFORTS]);
    expect(control!.label).toBe("Reasoning / Thinking Effort");
    // The stored effort stays representable — "medium" is shown as "medium", not clamped away.
    expect(normalizeReasoningValueForControl([ROTATE, ROTATE], control, "medium")).toBe("medium");
    expect(normalizeReasoningValueForControl([ROTATE, ROTATE], control, undefined)).toBe("medium");
  });

  it("rotate + concrete model intersects down to the concrete model's own ladder", () => {
    const control = reasoningControlForModels([ROTATE, "o1"]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual(["low", "medium", "high"]);
    expect(control!.label).toBe("Shared Reasoning / Thinking");
    expect(normalizeReasoningValueForControl([ROTATE, "o1"], control, "medium")).toBe("medium");
  });

  it("rotate + a model with NO reasoning capability still shows the rotation ladder", () => {
    // mistral-small-2603 takes no reasoning params (provider 400) — it contributes no capability,
    // so the rotating seat's full ladder is what remains.
    const control = reasoningControlForModels([ROTATE, "mistral-small-latest"]);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual([...ALL_LLM_REASONING_EFFORTS]);
  });

  it("models with no capability at all still yield no control (honest absence)", () => {
    expect(reasoningControlForModels(["mistral-small-latest"])).toBeNull();
    expect(reasoningControlForModels(["openai/gpt-4.1-mini", "mistral-small-latest"])).toBeNull();
  });
});

describe("reasoningSummary — honest copy under rotation", () => {
  it("never claims rotating seats 'do not expose' a reasoning control", () => {
    const control = reasoningControlForModels([ROTATE, ROTATE]);
    const summary = reasoningSummary(control);
    expect(summary).not.toMatch(/do not expose/i);
    // Per-team split (2026-07-10): rotation AUTO-SETS each served model's recommended effort —
    // the summary states that instead of the old "your chosen effort applies, clamped" copy.
    expect(summary).toMatch(/served model/i);
    expect(summary).toMatch(/recommended/i);
  });

  it("keeps the plain copy for concrete models and the honest-absence line for none", () => {
    expect(reasoningSummary(reasoningControlForModels(["gpt-5.4-mini"]))).toBe("OpenAI Reasoning active.");
    expect(reasoningSummary(null)).toMatch(/do not expose/i);
  });
});

describe("normalizeReasoningValueForControl — high-tier-only pairings (no silent escalation)", () => {
  it("mistral-medium-3-5 + gpt-5.4 collapses to {high}; non-explicit efforts stay unset", () => {
    const models = ["mistral-medium-3-5", "gpt-5.4"];
    const control = reasoningControlForModels(models);
    expect(control).not.toBeNull();
    expect(control!.options.map((o) => o.value)).toEqual(["high"]);
    // Every shared option is high-tier — the UI uses this to offer the explicit
    // "Per-model default" blank option instead of hiding the whole control.
    expect(control!.options.every((o) => HIGH_TIER_REASONING_EFFORTS.has(o.value))).toBe(true);
    // A non-explicit stored effort must NOT silently map onto the expensive high tier...
    expect(normalizeReasoningValueForControl(models, control, "medium")).toBeUndefined();
    expect(normalizeReasoningValueForControl(models, control, undefined)).toBeUndefined();
    // ...but an explicit high-tier request passes through (the opt-in path the blank option enables).
    expect(normalizeReasoningValueForControl(models, control, "high")).toBe("high");
  });

  it("rotate + mistral-medium-3-5 shares {none, high} and keeps the same opt-in guard", () => {
    const models = [ROTATE, "mistral-medium-3-5"];
    const control = reasoningControlForModels(models);
    expect(control!.options.map((o) => o.value)).toEqual(["none", "high"]);
    expect(normalizeReasoningValueForControl(models, control, "medium")).toBeUndefined();
    expect(normalizeReasoningValueForControl(models, control, "none")).toBe("none");
    expect(normalizeReasoningValueForControl(models, control, "xhigh")).toBe("high");
  });
});

describe("seatReasoningPatch — per-seat renormalization bundled into model saves", () => {
  it("clamps the seat's stored effort to the new model's own ladder", () => {
    // o1's ladder is {low, medium, high}: "xhigh" clamps to "high" for the save.
    expect(seatReasoningPatch("llmReasoningEffort", "o1", "xhigh")).toEqual({ llmReasoningEffort: "high" });
    expect(seatReasoningPatch("llmReasoningEffort", "o1", "medium")).toEqual({ llmReasoningEffort: "medium" });
    // Writes the reviewer's own per-team field when asked to.
    expect(seatReasoningPatch("redTeamReasoningEffort", "claude-sonnet-5", "xhigh")).toEqual({ redTeamReasoningEffort: "xhigh" });
  });

  it("rotating/blank seats yield an empty patch (rotation auto-sets the served model's effort)", () => {
    expect(seatReasoningPatch("llmReasoningEffort", ROTATE, "medium")).toEqual({});
    expect(seatReasoningPatch("redTeamReasoningEffort", ROTATE, "xhigh")).toEqual({});
    expect(seatReasoningPatch("llmReasoningEffort", "", "medium")).toEqual({});
    expect(seatReasoningPatch("llmReasoningEffort", undefined, "medium")).toEqual({});
  });

  it("an UNSET effort never materializes into an explicit value on a model change", () => {
    // The reviewer's inheriting state (redTeamReasoningEffort absent) must survive a model swap.
    expect(seatReasoningPatch("redTeamReasoningEffort", "gpt-5.4-mini", undefined)).toEqual({});
  });

  it("a model with no reasoning capability yields no patch (effort is ignored at call time)", () => {
    expect(seatReasoningPatch("llmReasoningEffort", "mistral-small-latest", "high")).toEqual({});
  });

  it("the disallowed interactive gpt-5.5+high combo saves the run-time-honest medium instead", () => {
    expect(seatReasoningPatch("llmReasoningEffort", "openai/gpt-5.5", "high")).toEqual({ llmReasoningEffort: "medium" });
    expect(seatReasoningPatch("redTeamReasoningEffort", "openai/gpt-5.5", "high")).toEqual({ redTeamReasoningEffort: "medium" });
  });
});

describe("resolveReviewerReasoningEffort — the reviewer's fallback lives in one place", () => {
  it("explicit reviewer effort wins; unset falls back to the proposer's; both-unset stays unset", () => {
    expect(resolveReviewerReasoningEffort({ llmReasoningEffort: "medium", redTeamReasoningEffort: "high" })).toBe("high");
    expect(resolveReviewerReasoningEffort({ llmReasoningEffort: "medium" })).toBe("medium");
    expect(resolveReviewerReasoningEffort({})).toBeUndefined();
    expect(resolveReviewerReasoningEffort(undefined)).toBeUndefined();
    expect(resolveReviewerReasoningEffort(null)).toBeUndefined();
  });
});

describe("seat effort control for MiniMax and Muse (ST-4589)", () => {
  it("offers an effort control derived from the capability, never none, and never max for contributor models", () => {
    const flash = reasoningControlForModels(["minimax-m3.1-flash"]);
    expect(flash!.options.map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(normalizeReasoningValueForControl(["minimax-m3.1-flash"], flash, undefined)).toBe("medium");
    const spark = reasoningControlForModels(["muse-spark-1.3"]);
    expect(spark!.options.map((o) => o.value)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    const contributor = reasoningControlForModels(["muse-wonder-1.0-contributor"]);
    expect(contributor!.options.map((o) => o.value)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(normalizeReasoningValueForControl(["muse-wonder-1.0-contributor"], contributor, "max")).toBe("xhigh");
    // A shared control over Spark + a contributor model never offers max.
    const shared = reasoningControlForModels(["muse-spark-1.3", "muse-spark-1.3-contributor"]);
    expect(shared!.options.map((o) => o.value)).not.toContain("max");
    // Saving a contributor model with a stored Max persists the clamped XHigh.
    expect(seatReasoningPatch("llmReasoningEffort", "muse-spark-1.3-contributor", "max")).toEqual({ llmReasoningEffort: "xhigh" });
    // MiniMax-M3 still has no knob.
    expect(reasoningControlForModels(["minimax-m3"])).toBeNull();
  });
});
