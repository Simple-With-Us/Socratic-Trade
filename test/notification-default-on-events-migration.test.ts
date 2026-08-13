/**
 * Migration v77 (notification_default_on_events_backfill) — owner ruling 2026-08-12: every
 * notification-event toggle must be authoritative, no silent force-include. The 8 event types
 * below (provider_degraded, storage_warning, autonomy_halted_on_boot, signal_health,
 * lookahead_leak, risk_advisory, budget_alert, earningscalls_entitlement_blocked) used to be
 * force-injected into enabledEvents at every send site, permanently overriding a real, rendered
 * Settings checkbox. This ONE-TIME backfill replaces that: it unions the 8 types into an
 * existing stored enabledEvents array exactly once (matching what every account already
 * received via the old force-inject), so the checkbox becomes real going forward without
 * flipping delivery behavior on the migration itself.
 */
import { randomUUID } from "node:crypto";
import RawDatabase from "better-sqlite3";
import { describe, expect, it } from "vitest";

/** Minimal baseline of the four policy-blob tables the backfill walks — mirrors
 *  migrateLegacyDailyOpeningCapRows' target list exactly (db.ts). */
function buildLegacyDb(): RawDatabase.Database {
  const db = new RawDatabase(":memory:");
  db.exec(`
    CREATE TABLE account_strategy_state (
      user_id TEXT NOT NULL, connected_account_id TEXT NOT NULL, policy TEXT NOT NULL,
      PRIMARY KEY (user_id, connected_account_id)
    );
    CREATE TABLE strategy_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, policy TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '', scoring_weights TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_settings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function setUserPolicy(db: RawDatabase.Database, userId: string, policy: Record<string, unknown>): void {
  db.prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, '')").run(
    `${userId}_policy`,
    userId,
    JSON.stringify(policy)
  );
}

function userPolicy(db: RawDatabase.Database, userId: string): Record<string, unknown> {
  const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId) as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}

describe("migration v77 — notification default-on events backfill", () => {
  it("unions the 8 default-on event types into a stored array that predates them", async () => {
    const { backfillDefaultOnNotificationEvents } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;

    // A pre-existing account's stored preferences: only the classic events, saved before the
    // newer advisory event types existed.
    setUserPolicy(db, userId, { notificationSettings: { enabledEvents: ["fill", "block", "pending_approval"] } });

    const changed = backfillDefaultOnNotificationEvents(db);
    expect(changed).toBe(1);

    const enabledEvents = (userPolicy(db, userId).notificationSettings as { enabledEvents: string[] }).enabledEvents;
    for (const type of [
      "provider_degraded",
      "storage_warning",
      "autonomy_halted_on_boot",
      "signal_health",
      "lookahead_leak",
      "risk_advisory",
      "budget_alert",
      "earningscalls_entitlement_blocked"
    ]) {
      expect(enabledEvents).toContain(type);
    }
    // Untouched, pre-existing choices survive verbatim.
    expect(enabledEvents).toEqual(expect.arrayContaining(["fill", "block", "pending_approval"]));
    db.close();
  });

  it("runs exactly ONCE via the versioned-migration guard — a later explicit opt-out sticks", async () => {
    // The backfill itself can only ADD (it has no way to tell "never chosen" apart from
    // "deliberately unchecked" at the row level) — the real default-on-vs-forced-on guarantee
    // comes from the versioned-migration framework running it exactly once ever, never again on
    // a later boot. Exercise that guarantee directly with the real runMigrations guard instead of
    // calling the backfill function a second time by hand.
    const { runMigrations, backfillDefaultOnNotificationEvents } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;
    const migs = [{ version: 2, name: "backfill", up: (d: RawDatabase.Database) => backfillDefaultOnNotificationEvents(d) }];

    setUserPolicy(db, userId, { notificationSettings: { enabledEvents: ["fill"] } });
    expect(runMigrations(db, migs, 1)).toBe(2); // first boot: backfill runs, all 8 added
    expect((userPolicy(db, userId).notificationSettings as { enabledEvents: string[] }).enabledEvents).toContain("risk_advisory");

    // The owner now explicitly unchecks risk_advisory in Settings (a fresh save, post-migration).
    const current = userPolicy(db, userId);
    const notificationSettings = current.notificationSettings as { enabledEvents: string[] };
    notificationSettings.enabledEvents = notificationSettings.enabledEvents.filter((t) => t !== "risk_advisory");
    db.prepare("UPDATE user_settings SET value = ? WHERE user_id = ? AND key = 'policy'").run(JSON.stringify(current), userId);

    // A subsequent boot re-runs the SAME migration list. Because migration 2 is already stamped,
    // it must NOT run again — the owner's uncheck survives.
    expect(runMigrations(db, migs, 1)).toBe(2);
    expect(userPolicy(db, userId).notificationSettings).toEqual({ enabledEvents: ["fill", "provider_degraded", "storage_warning", "autonomy_halted_on_boot", "signal_health", "lookahead_leak", "budget_alert", "earningscalls_entitlement_blocked"] });
    db.close();
  });

  it("is a no-op when notificationSettings/enabledEvents is absent (mergePolicy already defaults it)", async () => {
    const { backfillDefaultOnNotificationEvents } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;
    setUserPolicy(db, userId, { maxOrderNotional: 9 });

    const changed = backfillDefaultOnNotificationEvents(db);
    expect(changed).toBe(0);
    expect("notificationSettings" in userPolicy(db, userId)).toBe(false);
    db.close();
  });

  it("is idempotent — a second run over an already-backfilled row changes nothing", async () => {
    const { backfillDefaultOnNotificationEvents } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;
    setUserPolicy(db, userId, { notificationSettings: { enabledEvents: ["fill"] } });

    expect(backfillDefaultOnNotificationEvents(db)).toBe(1);
    expect(backfillDefaultOnNotificationEvents(db)).toBe(0);
    db.close();
  });
});
