import { afterEach, describe, expect, it, vi } from "vitest";
import { syncVisualViewport } from "../app/console/ui/use-overlay";

describe("syncVisualViewport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes visualViewport height and offset to CSS variables", () => {
    const setProperty = vi.fn();
    vi.stubGlobal("window", { visualViewport: { height: 640, offsetTop: 24 } });
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty, removeProperty: vi.fn() } }
    });

    syncVisualViewport();
    expect(setProperty).toHaveBeenCalledWith("--con-vv-height", "640px");
    expect(setProperty).toHaveBeenCalledWith("--con-vv-offset-top", "24px");
  });

  it("falls back to 100dvh when visualViewport is unavailable", () => {
    const setProperty = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty, removeProperty: vi.fn() } }
    });

    syncVisualViewport();
    expect(setProperty).toHaveBeenCalledWith("--con-vv-height", "100dvh");
    expect(setProperty).toHaveBeenCalledWith("--con-vv-offset-top", "0px");
  });
});
