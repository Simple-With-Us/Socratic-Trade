import { describe, expect, it } from "vitest";
import { applyCoachChipPrefill, COACH_NOTE_CHIPS } from "../app/console/lib/coach-chips";

describe("Home Coach chips", () => {
  it("exposes three Title Case actions that prefill the coach note", () => {
    expect(COACH_NOTE_CHIPS.map((chip) => chip.label)).toEqual([
      "Refocus Mandate",
      "Critique Thesis",
      "Promote Lesson"
    ]);
    expect(applyCoachChipPrefill("", COACH_NOTE_CHIPS[0].prefill)).toBe("Refocus the mandate: ");
    expect(applyCoachChipPrefill("", COACH_NOTE_CHIPS[1].prefill)).toBe("Critique the thesis: ");
    expect(applyCoachChipPrefill("", COACH_NOTE_CHIPS[2].prefill)).toBe("Promote this as a lesson: ");
  });

  it("keeps owner-typed text and prepends the starter once", () => {
    expect(applyCoachChipPrefill("size this smaller", "Critique the thesis: ")).toBe(
      "Critique the thesis: size this smaller"
    );
    expect(applyCoachChipPrefill("Critique the thesis: already", "Critique the thesis: ")).toBe(
      "Critique the thesis: already"
    );
  });
});
