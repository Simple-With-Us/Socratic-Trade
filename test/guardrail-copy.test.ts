import { describe, expect, it } from "vitest";
import {
  ADVISORY_NOTE,
  ALPACA_PAPER_LABEL,
  BREAKER_FIRED_NOTE,
  FRAMEWORK_SIZING_INVARIANT,
  GUARDRAILS_HEADER_SUFFIX,
  HOW_IT_WORKS_AUTHORITY_ITEMS,
  PAPER_ACCOUNT_GLOSSARY_ALIASES,
  REGIME_BELOW_MEDIAN_CRISIS,
  REGIME_GATES_ENTRIES,
  TRADIER_SANDBOX_LABEL
} from "../src/lib/guardrail-copy";

describe("guardrail-copy — canonical semantics", () => {
  it("describes below-median regime gates as advisory, not hard veto", () => {
    for (const text of [REGIME_BELOW_MEDIAN_CRISIS, REGIME_GATES_ENTRIES]) {
      expect(text.toLowerCase()).toContain("advisory");
      expect(text.toLowerCase()).not.toContain("hard-veto");
      expect(text.toLowerCase()).not.toContain("vetoed outright");
    }
  });

  it("frames guardrails as adjustable preferences", () => {
    expect(GUARDRAILS_HEADER_SUFFIX).toContain("adjustable preferences");
    expect(GUARDRAILS_HEADER_SUFFIX.toLowerCase()).not.toContain("hard execution");
    expect(ADVISORY_NOTE.toLowerCase()).toContain("advisory");
    expect(BREAKER_FIRED_NOTE.toLowerCase()).not.toContain("hard limit did its job");
  });

  it("documents real authority controls on the public how-it-works page", () => {
    const joined = HOW_IT_WORKS_AUTHORITY_ITEMS.join(" ").toLowerCase();
    expect(joined).toContain("ask-first");
    expect(joined).toContain("autopilot");
    expect(joined).not.toContain("evidence threshold");
    expect(joined).not.toContain("review mode");
  });

  it("allows Socratic override in the public sizing invariant", () => {
    expect(FRAMEWORK_SIZING_INVARIANT.toLowerCase()).toContain("socratic override");
    expect(FRAMEWORK_SIZING_INVARIANT.toLowerCase()).not.toContain("cannot reach it");
  });

  it("labels Tradier paper in the same family as Alpaca (paper)", () => {
    expect(ALPACA_PAPER_LABEL).toBe("Alpaca (paper)");
    expect(TRADIER_SANDBOX_LABEL).toBe("Tradier (paper)");
    expect(TRADIER_SANDBOX_LABEL.toLowerCase()).not.toContain("sandbox");
    expect(PAPER_ACCOUNT_GLOSSARY_ALIASES.toLowerCase()).not.toContain("sandbox");
    expect(PAPER_ACCOUNT_GLOSSARY_ALIASES.toLowerCase()).toContain("paper");
  });
});
