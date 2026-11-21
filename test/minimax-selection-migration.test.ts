/**
 * Owner 2026-11-21 (MiniMax M3.1 only): a SAVED minimax-m3 team selection must become
 * minimax-m3.1-flash. The 2026-11-05 retirement kept stored selections resolving to the
 * retired catalog row, so the production Red Team guardrail was still running M3 off a
 * saved selection (Guardrails screenshot, 2026-11-21). The migration runs on the
 * getPolicy load path — the same load the Guardrails API, the console, the scheduler and
 * the trade loop all use — and rewrites the STORED value in every store that can hold
 * team-model fields (per-account live rows, library profiles, the user_settings blob),
 * so the setting itself reads minimax-m3.1-flash, not just a display projection.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `st-minimax-migration-${randomUUID()}.sqlite`)}`;
});

describe("saved minimax-m3 team selections migrate to minimax-m3.1-flash", () => {
  it("rewrites the per-account live row the Guardrails screen and trade loop load", async () => {
    const db = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-M3", label: "M3 acct", isActive: true });
    db.getPolicy(userId, acct); // seeds the live row

    // Simulate the pre-migration saved state production held: both team fields on M3,
    // one stored under its OpenRouter wire spelling.
    const raw = db.getDb();
    const row = raw
      .prepare("SELECT policy FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
      .get(userId, acct) as { policy: string };
    const stored = JSON.parse(row.policy) as Record<string, unknown>;
    stored.llmModel = "minimax/minimax-m3";
    stored.redTeamLlmModel = "minimax-m3";
    raw
      .prepare("UPDATE account_strategy_state SET policy = ? WHERE user_id = ? AND connected_account_id = ?")
      .run(JSON.stringify(stored), userId, acct);

    const loaded = db.getPolicy(userId, acct);
    expect(loaded.llmModel).toBe("minimax-m3.1-flash");
    expect(loaded.redTeamLlmModel).toBe("minimax-m3.1-flash");

    // The STORED value itself was rewritten — not just the loaded projection.
    const after = JSON.parse(
      (raw
        .prepare("SELECT policy FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?")
        .get(userId, acct) as { policy: string }).policy
    ) as Record<string, unknown>;
    expect(after.llmModel).toBe("minimax-m3.1-flash");
    expect(after.redTeamLlmModel).toBe("minimax-m3.1-flash");
  });

  it("rewrites the user_settings blob for a user with no connected account", async () => {
    const db = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const raw = db.getDb();
    raw
      .prepare("INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', ?, '')")
      .run(`${userId}_policy`, userId, JSON.stringify({ llmModel: "claude-sonnet-latest", redTeamLlmModel: "minimax-m3" }));

    const loaded = db.getPolicy(userId);
    expect(loaded.redTeamLlmModel).toBe("minimax-m3.1-flash");
    expect(loaded.llmModel).toBe("claude-sonnet-latest");

    const blob = JSON.parse(
      (raw.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'policy'").get(userId) as { value: string }).value
    ) as Record<string, unknown>;
    expect(blob.redTeamLlmModel).toBe("minimax-m3.1-flash");
    expect(blob.llmModel).toBe("claude-sonnet-latest");
  });

  it("rewrites a library profile so activating it cannot resurrect M3", async () => {
    const db = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const raw = db.getDb();
    const profileId = `prof-${randomUUID()}`;
    raw
      .prepare(
        "INSERT INTO strategy_profiles (id, user_id, name, policy, prompt, scoring_weights, active, created_at, updated_at) VALUES (?, ?, 'P', ?, '', '{}', 0, '', '')"
      )
      .run(profileId, userId, JSON.stringify({ redTeamLlmModel: "minimax-m3" }));

    db.getPolicy(userId); // any policy load runs the sweep

    const after = JSON.parse(
      (raw.prepare("SELECT policy FROM strategy_profiles WHERE id = ?").get(profileId) as { policy: string }).policy
    ) as Record<string, unknown>;
    expect(after.redTeamLlmModel).toBe("minimax-m3.1-flash");
  });

  it("leaves other models untouched, including an already-migrated M3.1 Flash selection", async () => {
    const db = await import("../src/lib/db");
    const userId = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-OK", label: "OK acct", isActive: true });
    db.setPolicy({ ...db.getPolicy(userId, acct), llmModel: "minimax-m3.1-flash", redTeamLlmModel: "claude-opus-latest" }, userId, acct);

    const loaded = db.getPolicy(userId, acct);
    expect(loaded.llmModel).toBe("minimax-m3.1-flash");
    expect(loaded.redTeamLlmModel).toBe("claude-opus-latest");
  });
});
