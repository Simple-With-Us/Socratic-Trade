/**
 * Merge-gate — owner ruling 2026-08-12: every notification-event toggle must be authoritative,
 * no silent force-include, ever. A future edit that reintroduces a per-send forcedPolicy
 * enabledEvents override fails these.
 *
 * Residue from Claude's r4-toggles salvage (`r4-toggles-superseded` / edfb5fc1) after Monet
 * #2682 landed the force-include removal itself. Adapted to the names #2682 shipped:
 * FORCE_INCLUDE_BACKFILL_EVENT_TYPES + notification_enabled_events_backfill.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every module that used to force-inject an event type into a single send's effective
// enabledEvents (db-health.ts x2 event types, scheduler.ts, signal-health.ts, lookahead-audit.ts,
// strategy.ts x3 call sites, broker-health.ts, earningscalls-transcripts.ts,
// usage-limit-alerts.ts). Real production code only — test fixtures are free to construct
// whatever policy they like.
const FORMERLY_FORCE_INCLUDING_FILES = [
  "../src/lib/db-health.ts",
  "../src/lib/scheduler.ts",
  "../src/lib/signal-health.ts",
  "../src/lib/lookahead-audit.ts",
  "../src/lib/strategy.ts",
  "../src/lib/broker-health.ts",
  "../src/lib/earningscalls-transcripts.ts",
  "../src/lib/usage-limit-alerts.ts"
];

describe("notification enabledEvents force-include is gone (owner ruling 2026-08-12)", () => {
  for (const path of FORMERLY_FORCE_INCLUDING_FILES) {
    it(`${path} no longer unions a type into enabledEvents for a single send`, () => {
      const src = readFileSync(new URL(path, import.meta.url), "utf8");
      // The exact literal shape every force-include site used: unioning a hardcoded event type
      // into policy.notificationSettings.enabledEvents for that one send only.
      expect(src).not.toMatch(/notificationSettings\.enabledEvents,\s*"[a-z_]+"\s*(as const)?\s*\]/);
      expect(src).not.toContain("forcedPolicy");
      expect(src).not.toContain("forcedAdvisoryPolicy");
      expect(src).not.toContain("forcedRecoveryPolicy");
      expect(src).not.toContain("forcedAccuracyPolicy");
      expect(src).not.toContain("forcedBudgetAlertPolicy");
    });
  }

  it("db.ts carries the one-time backfill migration instead", () => {
    const src = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
    expect(src).toContain("FORCE_INCLUDE_BACKFILL_EVENT_TYPES");
    expect(src).toContain("notification_enabled_events_backfill");
  });
});
