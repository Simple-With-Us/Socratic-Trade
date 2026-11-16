import { describe, expect, it } from "vitest";
import { presentAccountSchedule } from "../src/lib/scheduler-presentation";

function etDate(isoDate: string, etHour: number, etMinute = 0): Date {
  const utcHour = etHour + 4;
  return new Date(`${isoDate}T${String(utcHour).padStart(2, "0")}:${String(etMinute).padStart(2, "0")}:00Z`);
}

describe("presentAccountSchedule", () => {
  it("last run comes from the persisted strategy start when the memory clock is empty", () => {
    const presented = presentAccountSchedule({
      lastStrategyRunStartedAt: "2026-08-21T15:02:00.000Z",
      systemState: "halted",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      now: etDate("2026-08-21", 18, 0)
    });
    expect(presented.lastRunAt).toBe("2026-08-21T15:02:00.000Z");
    expect(presented.nextRunAt).toBeNull();
  });

  it("does not call a missing last run 'not scheduled' — next run stays null while autonomy is off", () => {
    const presented = presentAccountSchedule({
      lastStrategyRunStartedAt: null,
      systemState: "halted",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      now: etDate("2026-08-21", 18, 0)
    });
    expect(presented.lastRunAt).toBeNull();
    expect(presented.nextRunAt).toBeNull();
  });

  it("fills next run for an Autopilot account after the cash close from last run + cadence", () => {
    const lastRun = etDate("2026-08-21", 15, 0).toISOString();
    const presented = presentAccountSchedule({
      lastStrategyRunStartedAt: lastRun,
      systemState: "active",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      now: etDate("2026-08-21", 18, 0)
    });
    expect(presented.lastRunAt).toBe(lastRun);
    expect(presented.nextRunAt).toBe(etDate("2026-08-24", 9, 30).toISOString());
  });

  it("keeps a live in-memory next-run stamp when the tick already scheduled one", () => {
    const presented = presentAccountSchedule({
      memoryLastRunAt: "2026-08-21T14:00:00.000Z",
      memoryNextRunAt: "2026-08-21T15:00:00.000Z",
      lastStrategyRunStartedAt: "2026-08-21T13:00:00.000Z",
      systemState: "active",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      now: etDate("2026-08-21", 14, 10)
    });
    expect(presented.lastRunAt).toBe("2026-08-21T14:00:00.000Z");
    expect(presented.nextRunAt).toBe("2026-08-21T15:00:00.000Z");
  });

  it("during regular hours with a due clock, next run is now rather than blank", () => {
    const now = etDate("2026-08-21", 11, 0);
    const presented = presentAccountSchedule({
      lastStrategyRunStartedAt: etDate("2026-08-21", 9, 0).toISOString(),
      systemState: "active",
      runCadenceMinutes: 60,
      runDuringExtendedHours: false,
      now
    });
    expect(presented.nextRunAt).toBe(now.toISOString());
  });
});
