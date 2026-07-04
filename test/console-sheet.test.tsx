import { describe, expect, it } from "vitest";
import { nextSheetFocusTarget } from "../app/console/ui/sheet";

describe("console sheet focus trap", () => {
  it("chooses the correct wrap target for Tab and Shift+Tab", () => {
    const sheet = { id: "sheet" };
    const close = { id: "close" };
    const input = { id: "input" };
    const action = { id: "action" };
    const focusables = [close, input, action];

    expect(nextSheetFocusTarget(focusables, action, sheet, false, true)).toBe(close);
    expect(nextSheetFocusTarget(focusables, close, sheet, true, true)).toBe(action);
    expect(nextSheetFocusTarget(focusables, sheet, sheet, true, true)).toBe(action);
    expect(nextSheetFocusTarget(focusables, null, sheet, false, false)).toBe(close);
    expect(nextSheetFocusTarget(focusables, input, sheet, false, true)).toBeNull();
    expect(nextSheetFocusTarget([], null, sheet, false, true)).toBe(sheet);
  });
});
