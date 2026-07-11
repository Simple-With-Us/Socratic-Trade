import { afterEach, describe, expect, it, vi } from "vitest";
import { singleLeaderEnabled } from "../src/lib/scheduler";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SCHEDULER_SINGLE_LEADER default", () => {
  it("stays enabled for unset, empty, and whitespace-only values", () => {
    vi.stubEnv("SCHEDULER_SINGLE_LEADER", undefined);
    expect(singleLeaderEnabled()).toBe(true);
    expect(singleLeaderEnabled("")).toBe(true);
    expect(singleLeaderEnabled("   ")).toBe(true);
  });

  it.each(["1", "true", "on", "yes", " TRUE "])("accepts explicit enabled value %s", (value) => {
    expect(singleLeaderEnabled(value)).toBe(true);
  });

  it("fails safe to enabled for an unrecognized value", () => {
    expect(singleLeaderEnabled("invalid-value")).toBe(true);
  });

  it.each(["0", "false", "off", "no"])("requires an explicit disabled value such as %s", (value) => {
    expect(singleLeaderEnabled(value)).toBe(false);
  });
});
