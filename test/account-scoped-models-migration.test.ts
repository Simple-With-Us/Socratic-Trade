/**
 * Migration v7 (account_scoped_strategy_models_backfill) — regression for the two
 * back-compat hazards chatgpt-codex-connector flagged on PR #267:
 *
 *  1. Persist legacy model seeds before clearing user policy. Multiple legacy account
 *     rows that lack the model fields must each inherit the single user-level value so
 *     the first per-account save (which rewrites user_settings without those fields)
 *     can't strand a not-yet-saved account on defaults.
 *  2. Stop stale account rows from overriding cleared models. A row that picked up an
 *     old model via earlier lazy seeding must be overwritten with the CURRENT user-level
 *     value (or dropped when the user has no override), so a cleared model can't resurrect.
 */
import { randomUUID } from "node:crypto";
import RawDatabase from "better-sqlite3";
import { describe, expect, it } from "vitest";

/** Minimal baseline of the two tables the migration touches. */
function buildLegacyDb(): RawDatabase.Database {
  const db = new RawDatabase(":memory:");
  db.exec(`
    CREATE TABLE user_settings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(user_id, key)
    );
    CREATE TABLE account_strategy_state (
      user_id TEXT NOT NULL, connected_account_id TEXT NOT NULL, policy TEXT NOT NULL,
      prompt TEXT, scoring_weights TEXT, system_state TEXT, derived_from_profile_id TEXT, updated_at TEXT,
      PRIMARY KEY (user_id, connected_account_id)
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

function setAccountPolicy(db: RawDatabase.Database, userId: string, accountId: string, policy: Record<string, unknown>): void {
  db.prepare(
    "INSERT INTO account_strategy_state (user_id, connected_account_id, policy, system_state, updated_at) VALUES (?, ?, ?, 'halted', '')"
  ).run(userId, accountId, JSON.stringify(policy));
}

function accountPolicy(db: RawDatabase.Database, userId: string, accountId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT policy FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
    .get(userId, accountId) as { policy: string };
  return JSON.parse(row.policy) as Record<string, unknown>;
}

function userPolicy(db: RawDatabase.Database, userId: string): Record<string, unknown> {
  const row = db
    .prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'")
    .get(userId) as { value: string };
  return JSON.parse(row.value) as Record<string, unknown>;
}

describe("migration v7 — account-scoped strategy model backfill", () => {
  it("seeds the single legacy user value into every account row and strips it from user_settings", async () => {
    const { backfillAccountScopedStrategyModels } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;
    const a1 = "a1";
    const a2 = "a2";

    // Legacy layout: model fields live in user_settings.policy; account rows lack them.
    setUserPolicy(db, userId, { llmModel: "gpt-legacy", redTeamLlmModel: "gpt-red", llmReasoningEffort: "high", maxOrderNotional: 5 });
    setAccountPolicy(db, userId, a1, { maxOrderNotional: 1 });
    setAccountPolicy(db, userId, a2, { maxOrderNotional: 2 });

    backfillAccountScopedStrategyModels(db);

    // Both accounts now carry the legacy model values (Codex finding #1).
    for (const a of [a1, a2]) {
      const p = accountPolicy(db, userId, a);
      expect(p.llmModel).toBe("gpt-legacy");
      expect(p.redTeamLlmModel).toBe("gpt-red");
      expect(p.llmReasoningEffort).toBe("high");
    }
    // Account-level fields are untouched.
    expect(accountPolicy(db, userId, a1).maxOrderNotional).toBe(1);
    expect(accountPolicy(db, userId, a2).maxOrderNotional).toBe(2);

    // user_settings.policy no longer carries the model fields (so the runtime seed is a no-op).
    const up = userPolicy(db, userId);
    expect("llmModel" in up).toBe(false);
    expect("redTeamLlmModel" in up).toBe(false);
    expect("llmReasoningEffort" in up).toBe(false);
    expect(up.maxOrderNotional).toBe(5);
    db.close();
  });

  it("overwrites a stale lazy-seeded model with the current user value (Codex finding #2)", async () => {
    const { backfillAccountScopedStrategyModels } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;

    // User currently has llmModel set but redTeamLlmModel CLEARED (no override).
    setUserPolicy(db, userId, { llmModel: "gpt-current" });
    // A row that earlier lazy-seeding stamped with a now-stale red-team model.
    setAccountPolicy(db, userId, "a1", { llmModel: "gpt-OLD", redTeamLlmModel: "gpt-red-OLD" });

    backfillAccountScopedStrategyModels(db);

    const p = accountPolicy(db, userId, "a1");
    expect(p.llmModel).toBe("gpt-current"); // current user value wins over stale row copy
    expect("redTeamLlmModel" in p).toBe(false); // cleared globally => dropped, falls back to default
    db.close();
  });

  it("is a no-op when the user never had model overrides", async () => {
    const { backfillAccountScopedStrategyModels } = await import("../src/lib/db");
    const db = buildLegacyDb();
    const userId = `u-${randomUUID()}`;
    setUserPolicy(db, userId, { maxOrderNotional: 9 });
    setAccountPolicy(db, userId, "a1", { maxOrderNotional: 3 });

    backfillAccountScopedStrategyModels(db);

    const p = accountPolicy(db, userId, "a1");
    expect("llmModel" in p).toBe(false);
    expect(p.maxOrderNotional).toBe(3);
    expect(userPolicy(db, userId).maxOrderNotional).toBe(9);
    db.close();
  });
});
