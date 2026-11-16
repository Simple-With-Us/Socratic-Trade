import { describe, expect, it } from "vitest";
import { nextTabId } from "../app/console/lib/tabs";
import { ACTIVITY_TAB_IDS } from "../src/lib/activity-tabs";

const IDS = ACTIVITY_TAB_IDS;

describe("console tablist keyboard movement", () => {
  it("moves and wraps in both directions", () => {
    expect(nextTabId(IDS, "alerts", "ArrowRight")).toBe("notifications");
    expect(nextTabId(IDS, "audit", "ArrowRight")).toBe("alerts");
    expect(nextTabId(IDS, "notifications", "ArrowLeft")).toBe("alerts");
    expect(nextTabId(IDS, "alerts", "ArrowLeft")).toBe("audit");
  });

  it("jumps to the ends with Home/End", () => {
    expect(nextTabId(IDS, "fills", "Home")).toBe("alerts");
    expect(nextTabId(IDS, "runs", "End")).toBe("audit");
  });

  it("returns null for keys the tabs pattern does not own", () => {
    // The caller keys preventDefault off this: swallowing Tab/Enter/typing would
    // trap keyboard users inside the switcher.
    for (const key of ["Tab", "Enter", " ", "a", "ArrowDown", "Escape"]) {
      expect(nextTabId(IDS, "alerts", key)).toBeNull();
    }
  });

  it("leaves focus alone when the current tab is not in the list", () => {
    expect(nextTabId(IDS, "nope" as (typeof IDS)[number], "ArrowRight")).toBeNull();
    expect(nextTabId([] as readonly string[], "alerts", "ArrowRight")).toBeNull();
  });
});
