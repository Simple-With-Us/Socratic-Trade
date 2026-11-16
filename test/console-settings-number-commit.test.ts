import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveSourceFeatureNumberCommit,
  resolveServerKnobNumberCommit,
  resolveTaxRateCommit,
  resolveLearningReviewNumberCommit,
  resolveScoringWeightCommit
} from "../app/console/lib/number-commit";

/**
 * console-ia-forms-blotters (keystroke-PATCH slice, docs/reviews/2026-08-18-full-app-expert-review.md, Issue #2958):
 * The Settings > Data sources number rows and Admin > Operations knobs previously PATCHed the server
 * on every keystroke. Worse, RawNumInput's own onChange feeds `emptyValue` (the row's default) into
 * onValueChange the instant the field goes blank, so clearing a field to retype it wrote the
 * row's DEFAULT value to the server as a real setting on the very next keystroke.
 *
 * All numeric inputs across Admin > Operations, Tax Settings, Learning Review, Scoring Weights, and
 * Data Sources now follow the blur-commit, no-fallback-on-empty pattern with pure resolver functions.
 */
describe("Settings > Data sources number rows: blur-commit, no fallback on empty", () => {
  it("blank text commits nothing (does not fall back to the row's committed/default value)", () => {
    expect(resolveSourceFeatureNumberCommit("", 5)).toBeNull();
  });

  it("whitespace-only text commits nothing", () => {
    expect(resolveSourceFeatureNumberCommit("   ", 25)).toBeNull();
  });

  it("unparseable text commits nothing", () => {
    expect(resolveSourceFeatureNumberCommit("abc", 4)).toBeNull();
    expect(resolveSourceFeatureNumberCommit("-", 4)).toBeNull();
  });

  it("a value equal to what's already committed is a no-op (no redundant PATCH)", () => {
    expect(resolveSourceFeatureNumberCommit("16", 16)).toBeNull();
  });

  it("a real, changed, parseable value commits the parsed number", () => {
    expect(resolveSourceFeatureNumberCommit("42", 16)).toBe(42);
  });

  it("never resolves blank text to the field's default the way the old emptyValue fallback did", () => {
    const committedValue = 5;
    const oldFallbackDefault = 16;
    const result = resolveSourceFeatureNumberCommit("", committedValue);
    expect(result).toBeNull();
    expect(result).not.toBe(oldFallbackDefault);
  });
});

describe("Admin > Operations server knob number rows: blur-commit, no fallback on empty (Issue #2958)", () => {
  it("blank and whitespace text commit nothing (no fallback write)", () => {
    expect(resolveServerKnobNumberCommit("", 60)).toBeNull();
    expect(resolveServerKnobNumberCommit("  ", 60)).toBeNull();
  });

  it("unparseable text commits nothing", () => {
    expect(resolveServerKnobNumberCommit("xyz", 60)).toBeNull();
    expect(resolveServerKnobNumberCommit("-", 60)).toBeNull();
  });

  it("unchanged values return null (no redundant PATCH)", () => {
    expect(resolveServerKnobNumberCommit("60", 60)).toBeNull();
  });

  it("valid changed number commits parsed value", () => {
    expect(resolveServerKnobNumberCommit("120", 60)).toBe(120);
  });

  it("respects min and max bounds when specified", () => {
    expect(resolveServerKnobNumberCommit("5", 60, 10, 100)).toBe(10);
    expect(resolveServerKnobNumberCommit("150", 60, 10, 100)).toBe(100);
  });

  it("never writes default fallback when field is cleared", () => {
    const committed = 120;
    const defaultVal = 60;
    const res = resolveServerKnobNumberCommit("", committed);
    expect(res).toBeNull();
    expect(res).not.toBe(defaultVal);
  });
});

describe("Tax rate percentage inputs: blur-commit and 0-100 clamping", () => {
  it("blank and unparseable text commit nothing", () => {
    expect(resolveTaxRateCommit("", 24)).toBeNull();
    expect(resolveTaxRateCommit("   ", 24)).toBeNull();
    expect(resolveTaxRateCommit("abc", 24)).toBeNull();
  });

  it("unchanged value is a no-op", () => {
    expect(resolveTaxRateCommit("24", 24)).toBeNull();
  });

  it("valid percentage commits parsed value", () => {
    expect(resolveTaxRateCommit("28", 24)).toBe(28);
  });

  it("clamps percentage to 0-100", () => {
    expect(resolveTaxRateCommit("-5", 24)).toBe(0);
    expect(resolveTaxRateCommit("125", 24)).toBe(100);
  });
});

describe("Learning review threshold and wait days: blur-commit and min bounds", () => {
  it("blank and unparseable text commit nothing", () => {
    expect(resolveLearningReviewNumberCommit("", 5)).toBeNull();
    expect(resolveLearningReviewNumberCommit("   ", 5)).toBeNull();
    expect(resolveLearningReviewNumberCommit("invalid", 5)).toBeNull();
  });

  it("unchanged value is a no-op", () => {
    expect(resolveLearningReviewNumberCommit("5", 5)).toBeNull();
  });

  it("floors at min bound (default 1)", () => {
    expect(resolveLearningReviewNumberCommit("0", 5)).toBe(1);
    expect(resolveLearningReviewNumberCommit("10", 5)).toBe(10);
  });
});

describe("Scoring weights: blur-commit and non-negative floor", () => {
  it("blank and unparseable text commit nothing", () => {
    expect(resolveScoringWeightCommit("", 1.4)).toBeNull();
    expect(resolveScoringWeightCommit("   ", 1.4)).toBeNull();
    expect(resolveScoringWeightCommit("xyz", 1.4)).toBeNull();
  });

  it("unchanged value is a no-op", () => {
    expect(resolveScoringWeightCommit("1.4", 1.4)).toBeNull();
  });

  it("floors at 0 for negative input", () => {
    expect(resolveScoringWeightCommit("-2", 1.4)).toBe(0);
    expect(resolveScoringWeightCommit("2.5", 1.4)).toBe(2.5);
  });
});

describe("Source code structural checks for blur-commit compliance across all target files", () => {
  it("Admin > Operations client wires onValueChange to numberDrafts and onBlur to commitNumberRow", () => {
    const src = readFileSync(new URL("../app/admin/operations/operations-client.tsx", import.meta.url), "utf8");
    expect(src).toContain("resolveServerKnobNumberCommit");
    expect(src).toContain("setNumberDrafts");
    expect(src).toMatch(/onBlur=\{\(\)\s*=>\s*void commitNumberRow\(row\)\}/);
  });

  it("Tax settings wires onValueChange to rawRates and onBlur to commitRate", () => {
    const src = readFileSync(new URL("../app/console/strategy/tax-settings.tsx", import.meta.url), "utf8");
    expect(src).toContain("resolveTaxRateCommit");
    expect(src).toContain("setRawRates");
    expect(src).toContain("commitRate(\"shortTermRatePct\", 24)");
    expect(src).toContain("commitRate(\"longTermRatePct\", 15)");
  });

  it("Learning review wires onValueChange to rawDrafts and onBlur to commitNumber", () => {
    const src = readFileSync(new URL("../app/console/settings/learning-review.tsx", import.meta.url), "utf8");
    expect(src).toContain("resolveLearningReviewNumberCommit");
    expect(src).toContain("setRawDrafts");
    expect(src).toContain("commitNumber(\n                    \"learningReviewMinNewLessons\"");
    expect(src).toContain("commitNumber(\n                    \"learningReviewMaxWaitDays\"");
  });

  it("Strategy scoring weights wire onValueChange to weightsDrafts and onBlur to commitWeight", () => {
    const src = readFileSync(new URL("../app/console/strategy/page.tsx", import.meta.url), "utf8");
    expect(src).toContain("resolveScoringWeightCommit");
    expect(src).toContain("setWeightsDrafts");
    expect(src).toMatch(/onBlur=\{\(\)\s*=>\s*commitWeight\(key, saved\)\}/);
  });
});

