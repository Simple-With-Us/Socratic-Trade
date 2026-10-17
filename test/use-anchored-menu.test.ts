import { describe, expect, it } from "vitest";
import { anchoredMenuPosition } from "../app/console/ui/use-anchored-menu";

// ST-4544: geometry for the portaled header dropdown panels. The hook feeds
// these coordinates to `position: fixed`; the clamping is what keeps a
// right-edge menu on screen on phones.
describe("anchoredMenuPosition", () => {
  it("left-aligns under the trigger with the default 4px gap", () => {
    expect(
      anchoredMenuPosition({ left: 100, right: 260, bottom: 50 }, 1280, { align: "left", width: 360 })
    ).toEqual({ top: 54, left: 100 });
  });

  it("right-aligns the panel edge to the trigger edge", () => {
    expect(
      anchoredMenuPosition({ left: 1100, right: 1200, bottom: 48 }, 1280, {
        align: "right",
        width: 340,
        gap: 2
      })
    ).toEqual({ top: 50, left: 860 });
  });

  it("clamps a left-aligned panel at the right viewport margin", () => {
    expect(
      anchoredMenuPosition({ left: 1200, right: 1270, bottom: 50 }, 1280, { align: "left", width: 360 })
    ).toEqual({ top: 54, left: 912 });
  });

  it("never goes past the 8px left margin", () => {
    expect(
      anchoredMenuPosition({ left: 0, right: 40, bottom: 50 }, 1280, { align: "left", width: 360 })
    ).toEqual({ top: 54, left: 8 });
  });

  it("caps panel width to the viewport on narrow screens", () => {
    // 320px phone, 380px menu: effective width 304, so right-align lands at 8.
    expect(
      anchoredMenuPosition({ left: 276, right: 316, bottom: 48 }, 320, {
        align: "right",
        width: 380,
        gap: 2
      })
    ).toEqual({ top: 50, left: 8 });
  });
});
