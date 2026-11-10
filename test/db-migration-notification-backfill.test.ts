// Migration 78 ("notification_enabled_events_backfill") removes the banned force-include-at-
// send-time notification pattern (owner ruling 2026-08-12, "ALL toggles must be real") in favor
// of a ONE-TIME backfill of the affected event types into every stored
// notificationSettings.enabledEvents array that predates them. This test simulates a
// pre-migration database (a legacy user_settings row and a legacy global settings row, each with
// an explicit enabledEvents array missing the newer event types), boots getDb() to run the real
// versioned-migration chain, and verifies: the legacy arrays gain exactly the missing force-
// included types (existing members and other notificationSettings fields untouched), a row with
// NO notificationSettings key at all is left alone (mergePolicy's DEFAULT_POLICY fallback already
// covers it), and the backfilled row is genuinely toggleable afterward via the normal
// getPolicy/setPolicy path — turning an event off after the backfill sticks.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dbPath = join(tmpdir(), `agentic-notif-backfill-migration-${randomUUID()}.db`);
const LEGACY_USER_ID = "legacy-notif-user";

beforeAll(() => {
  // Recreate the exact user_settings/settings shape a pre-migration-78 deployment had on disk —
  // both tables already exist in the baseline DDL, so only rows need to be pre-seeded.
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  // A legacy per-user policy row: enabledEvents predates lookahead_leak/signal_health/
  // risk_advisory (and never had provider_degraded/budget_alert either), but the user DID
  // explicitly keep "fill" and "block" — those must survive byte-identical.
  const legacyUserPolicy = {
    systemState: "halted",
    notificationSettings: {
      webhookUrl: "https://ntfy.sh/legacy-topic",
      enabledEvents: ["fill", "block", "kill_switch"]
    }
  };
  raw
    .prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)")
    .run(`${LEGACY_USER_ID}_policy`, LEGACY_USER_ID, JSON.stringify(legacyUserPolicy), new Date().toISOString());

  // A row with a policy blob but NO notificationSettings key at all — must be left untouched;
  // mergePolicy already defaults it to every current event type at read time.
  const noNotificationSettingsPolicy = { systemState: "halted" };
  raw
    .prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, ?)")
    .run("bare-user_policy", "bare-notif-user", JSON.stringify(noNotificationSettingsPolicy), new Date().toISOString());

  // The legacy GLOBAL settings row (pre-multi-user single-operator storage) — same shape check,
  // different store, proving the sweep covers both.
  const legacyGlobalPolicy = {
    systemState: "halted",
    notificationSettings: { webhookUrl: "", enabledEvents: ["fill", "budget_alert"] }
  };
  raw
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('policy', ?, ?)")
    .run(JSON.stringify(legacyGlobalPolicy), new Date().toISOString());

  raw.close();
  process.env.DATABASE_URL = `file:${dbPath}`;
});

describe("migration 78: notification enabledEvents backfill", () => {
  it("unions the previously force-included event types into a legacy per-user array, preserving existing members and other fields", async () => {
    const { getDb, FORCE_INCLUDE_BACKFILL_EVENT_TYPES } = await import("../src/lib/db");
    const db = getDb();

    const row = db
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get(LEGACY_USER_ID) as { value: string };
    const policy = JSON.parse(row.value) as {
      notificationSettings: { webhookUrl: string; enabledEvents: string[] };
    };

    // Explicit pre-existing members survive untouched.
    expect(policy.notificationSettings.enabledEvents).toEqual(
      expect.arrayContaining(["fill", "block", "kill_switch"])
    );
    // Every previously force-included type is now present.
    for (const type of FORCE_INCLUDE_BACKFILL_EVENT_TYPES) {
      expect(policy.notificationSettings.enabledEvents).toContain(type);
    }
    // No duplicates.
    expect(new Set(policy.notificationSettings.enabledEvents).size).toBe(policy.notificationSettings.enabledEvents.length);
    // Untouched sibling field.
    expect(policy.notificationSettings.webhookUrl).toBe("https://ntfy.sh/legacy-topic");
  });

  it("leaves a row with no notificationSettings key alone", async () => {
    const { getDb } = await import("../src/lib/db");
    const db = getDb();

    const row = db
      .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
      .get("bare-notif-user") as { value: string };
    const policy = JSON.parse(row.value) as Record<string, unknown>;
    expect(policy.notificationSettings).toBeUndefined();
  });

  it("also backfills the legacy global settings.policy row", async () => {
    const { getDb, FORCE_INCLUDE_BACKFILL_EVENT_TYPES } = await import("../src/lib/db");
    const db = getDb();

    const row = db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as { value: string };
    const policy = JSON.parse(row.value) as {
      notificationSettings: { enabledEvents: string[] };
    };
    expect(policy.notificationSettings.enabledEvents).toEqual(expect.arrayContaining(["fill", "budget_alert"]));
    for (const type of FORCE_INCLUDE_BACKFILL_EVENT_TYPES) {
      expect(policy.notificationSettings.enabledEvents).toContain(type);
    }
  });

  it("the backfilled event is genuinely toggleable afterward — turning it off through setPolicy sticks", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");

    const backfilled = getPolicy(LEGACY_USER_ID);
    expect(backfilled.notificationSettings.enabledEvents).toContain("signal_health");

    setPolicy(
      {
        ...backfilled,
        notificationSettings: {
          ...backfilled.notificationSettings,
          enabledEvents: backfilled.notificationSettings.enabledEvents.filter((type) => type !== "signal_health")
        }
      },
      LEGACY_USER_ID
    );

    const after = getPolicy(LEGACY_USER_ID);
    expect(after.notificationSettings.enabledEvents).not.toContain("signal_health");
    // Re-reading again must not silently resurrect it — no force-include, no unioning migration
    // fires again (it is version-gated to run once).
    expect(getPolicy(LEGACY_USER_ID).notificationSettings.enabledEvents).not.toContain("signal_health");
  });
});
