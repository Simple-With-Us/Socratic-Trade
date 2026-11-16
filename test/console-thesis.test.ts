import { describe, expect, it } from "vitest";
import {
  decisionActionLabel,
  deterministicOutcomePresentation,
  splitThesisRationale
} from "../app/console/lib/thesis";

describe("Live thesis narrative", () => {
  it("separates Green Team prose, deterministic receipts, and the legacy Red Team suffix", () => {
    const green = "EXE is a value-quality setup.";
    const rationale = `${green}\n\n[Sizing] LLM advised $4.60.\n\n[Risk] Native bracket skipped.\n\nRed Team Review Survived: Facts check out.`;
    expect(splitThesisRationale(rationale, green)).toEqual({
      greenTeam: green,
      checks: "[Sizing] LLM advised $4.60.\n\n[Risk] Native bracket skipped."
    });
  });

  it("keeps a bounded legacy fallback without repeating the Red Team review", () => {
    expect(splitThesisRationale("Green and sizing text.\n\nRed Team review — approved at full size: sound."))
      .toEqual({ greenTeam: "Green and sizing text." });
  });

  it("distinguishes reviewer approval from a later deterministic block", () => {
    expect(deterministicOutcomePresentation("blocked", {
      approved: false,
      reasons: ["Alpaca bracket order is too small for one whole share."]
    })).toEqual({
      label: "Blocked before placement",
      body: "Alpaca bracket order is too small for one whole share.",
      tone: "neg"
    });
  });

  it("uses past tense only for confirmed placement", () => {
    expect(decisionActionLabel("buy", "blocked")).toBe("Buy");
    expect(decisionActionLabel("buy", "proposed")).toBe("Buy");
    expect(decisionActionLabel("buy", "placed")).toBe("Bought");
  });
});
