import { describe, expect, it } from "vitest";
import { autonomyAuthorityWord, autonomyStatusLabel } from "../src/lib/autonomy-labels";
import { deriveStateInfo } from "../app/console/lib/derive";

function etDate(ymd: string, hour: number, minute: number): Date {
  return new Date(`${ymd}T${String(hour + 4).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
}

describe("Autopilot vs Running vocabulary", () => {
  it("calls auto-decide Autopilot and ask-first Ask-first", () => {
    expect(autonomyAuthorityWord("decide")).toBe("Autopilot");
    expect(autonomyAuthorityWord("propose")).toBe("Ask-first");
    expect(autonomyAuthorityWord(undefined)).toBe("Ask-first");
  });

  it("never labels ask-first autonomy as Autopilot", () => {
    expect(autonomyStatusLabel("active", "propose")).toBe("Running");
    expect(autonomyStatusLabel("active", "decide")).toBe("Autopilot");
    expect(autonomyStatusLabel("halted", "decide")).toBe("Stopped");
    expect(autonomyStatusLabel("close_only", "decide")).toBe("Exit-only");
    expect(autonomyStatusLabel("liquidating", "propose")).toBe("Winding down");
  });

  it("console chip uses Autopilot only when the account is auto-deciding", () => {
    const open = etDate("2026-06-10", 10, 0);
    const askFirst = deriveStateInfo(
      { systemState: "active", strategyAuthority: "propose", runDuringExtendedHours: false },
      open
    );
    const autopilot = deriveStateInfo(
      { systemState: "active", strategyAuthority: "decide", runDuringExtendedHours: false },
      open
    );
    expect(askFirst.word).toBe("Running");
    expect(askFirst.label).toBe("Running");
    expect(askFirst.label).not.toContain("Autopilot");
    expect(autopilot.word).toBe("Running");
    expect(autopilot.label).toBe("Autopilot");
  });
});
