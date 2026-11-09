import { afterEach, describe, expect, it } from "vitest";
import { admitRun, triggerEngineEnabled, triggerMode } from "../src/lib/triggers";
import { eightKHasMaterialItem } from "../src/lib/web-sources/sec8k";

const TRIGGER_ENVS = ["TRIGGER_ENGINE", "TRIGGER_MODE"];

afterEach(() => {
  for (const k of TRIGGER_ENVS) delete process.env[k];
});

describe("trigger engine defaults (Phase 0 — off = unchanged behavior)", () => {
  it("is disabled by default", () => {
    expect(triggerEngineEnabled()).toBe(false);
  });

  it("defaults mode to 'both' but only matters when the engine is on", () => {
    expect(triggerMode()).toBe("both");
    process.env.TRIGGER_MODE = "event";
    expect(triggerMode()).toBe("event");
    process.env.TRIGGER_MODE = "garbage";
    expect(triggerMode()).toBe("both");
  });

  it("admitRun short-circuits to engine_off when disabled (no DB/market access)", () => {
    expect(admitRun("local", [{ type: "test", sourceId: "x" }])).toEqual({ ok: false, reason: "engine_off" });
  });

  it("respects TRIGGER_ENGINE flag values", () => {
    process.env.TRIGGER_ENGINE = "on";
    expect(triggerEngineEnabled()).toBe(true);
    process.env.TRIGGER_ENGINE = "false";
    expect(triggerEngineEnabled()).toBe(false);
  });
});

describe("eightKHasMaterialItem (8-K trigger gating)", () => {
  it("returns true for material item codes", () => {
    expect(eightKHasMaterialItem({ symbol: "AAPL", filedAt: "2026-06-19", accession: "a1", items: ["Item 2.02 Results of Operations and Financial Condition"] })).toBe(true);
    expect(eightKHasMaterialItem({ symbol: "X", filedAt: "2026-06-19", accession: "a2", items: ["Item 5.02 Departure of Directors or Certain Officers"] })).toBe(true);
  });

  it("returns false for non-material / absent items", () => {
    expect(eightKHasMaterialItem({ symbol: "X", filedAt: "2026-06-19", accession: "a3", items: ["Item 5.07 Submission of Matters to a Vote", "Item 9.01 Financial Statements and Exhibits"] })).toBe(false);
    expect(eightKHasMaterialItem({ symbol: "X", filedAt: "2026-06-19", accession: "a4" })).toBe(false);
  });
});
