import { describe, it, expect } from "vitest";
import { tooltipPosition } from "../app/console/lib/tooltip-position";
const trigger = { top: 100, bottom: 120, left: 200, right: 280, width: 80 };
const content = { width: 160, height: 40 };
const viewport = { width: 700, height: 520 };
describe("tooltip viewport positioning", () => {
  it("prefers above with an eight-pixel gap", () => expect(tooltipPosition(trigger, content, viewport, "center")).toEqual({ top: 52, left: 160 }));
  it("flips below near the top", () => expect(tooltipPosition({ ...trigger, top: 8, bottom: 28 }, content, viewport, "center").top).toBe(36));
  it("clamps the left edge", () => expect(tooltipPosition({ ...trigger, left: 2, right: 82 }, content, viewport, "center").left).toBe(12));
  it("clamps the right edge", () => expect(tooltipPosition({ ...trigger, left: 618, right: 698 }, content, viewport, "center").left).toBe(528));
  it("preserves left alignment where it fits", () => expect(tooltipPosition(trigger, content, viewport, "left").left).toBe(200));
  it("preserves right alignment where it fits", () => expect(tooltipPosition(trigger, content, viewport, "right").left).toBe(120));
  it("keeps tall content anchored inside the top pad", () => expect(tooltipPosition(trigger, { width: 160, height: 800 }, viewport, "center").top).toBe(12));
});
