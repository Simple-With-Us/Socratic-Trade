import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sched-${randomUUID()}.db`)}`;
});

// The scheduler seeds userSchedules[user].lastRunAt from this on boot so a restart doesn't
// fire an immediate run regardless of cadence. (The accessor is the testable unit; the
// one-line wiring in scheduler.ts reads it on first tick.)
describe("getLastStrategyRunStartedAt — cadence rehydration source", () => {
  it("returns null for a user with no runs", async () => {
    const { getLastStrategyRunStartedAt } = await import("../src/lib/db");
    expect(getLastStrategyRunStartedAt("user-with-no-runs")).toBeNull();
  });

  it("returns the most recent run's start time (so the cadence clock survives a restart)", async () => {
    const { insertStrategyRun, getLastStrategyRunStartedAt } = await import("../src/lib/db");
    const user = "sched-user";
    const before = new Date().toISOString();
    insertStrategyRun(randomUUID(), user);
    const first = getLastStrategyRunStartedAt(user);
    expect(first).not.toBeNull();
    expect(first! >= before).toBe(true); // ISO sorts chronologically

    insertStrategyRun(randomUUID(), user);
    const second = getLastStrategyRunStartedAt(user);
    expect(second! >= first!).toBe(true); // MAX advances to the latest run
  });

  it("is scoped per user", async () => {
    const { insertStrategyRun, getLastStrategyRunStartedAt } = await import("../src/lib/db");
    insertStrategyRun(randomUUID(), "sched-A");
    expect(getLastStrategyRunStartedAt("sched-A")).not.toBeNull();
    expect(getLastStrategyRunStartedAt("sched-B-empty")).toBeNull();
  });
});
