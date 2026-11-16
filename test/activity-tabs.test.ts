import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TAB_IDS,
  ACTIVITY_TABS,
  DEFAULT_ACTIVITY_TAB,
  parseActivityTab
} from "../src/lib/activity-tabs";

describe("Activity tabs", () => {
  it("locks Title Case labels and the owner-specified order", () => {
    expect(ACTIVITY_TAB_IDS).toEqual(["alerts", "notifications", "runs", "fills", "audit"]);
    expect(ACTIVITY_TABS.map((tab) => tab.label)).toEqual([
      "Alerts Center",
      "Notifications",
      "Strategy Runs",
      "Order Fills",
      "Audit Log"
    ]);
    expect(DEFAULT_ACTIVITY_TAB).toBe("alerts");
  });

  it("maps legacy ?tab=all onto Audit Log and unknown values onto Alerts Center", () => {
    expect(parseActivityTab(null)).toBe("alerts");
    expect(parseActivityTab(undefined)).toBe("alerts");
    expect(parseActivityTab("")).toBe("alerts");
    expect(parseActivityTab("ALL")).toBe("audit");
    expect(parseActivityTab("all")).toBe("audit");
    expect(parseActivityTab("runs")).toBe("runs");
    expect(parseActivityTab("fills")).toBe("fills");
    expect(parseActivityTab("nope")).toBe("alerts");
  });
});
