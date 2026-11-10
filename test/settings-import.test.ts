/**
 * importAccountSettings — copy one connected account's own live strategy settings onto another
 * connected account (any->any, e.g. paper->live). Distinct from applyProfileToAccount (which copies
 * a saved LIBRARY profile): this reads the SOURCE account's live account_strategy_state row and
 * writes it onto the TARGET account's row, preserving the target's run-state and stripping both
 * identity fields (connectedAccountId/accountNumber/activeBroker) and user-level overlay fields
 * (e.g. notificationSettings) so they never leak into account-scoped storage.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-settings-import-${randomUUID()}.db`)}`;
});

/** Read the RAW stored policy JSON off account_strategy_state, bypassing getPolicy/peekPolicy's
 *  merge-and-overlay logic — needed to prove identity/user-level fields never hit storage, not just
 *  that the effective read comes out clean (getPolicy would mask that either way). */
function rawAccountStrategyState(db: typeof import("../src/lib/db"), userId: string, connectedAccountId: string) {
  const row = db
    .getDb()
    .prepare(
      "SELECT policy, prompt, scoring_weights, system_state, derived_from_profile_id FROM account_strategy_state WHERE user_id = ? AND connected_account_id = ?"
    )
    .get(userId, connectedAccountId) as
    | { policy: string; prompt: string | null; scoring_weights: string | null; system_state: string; derived_from_profile_id: string | null }
    | undefined;
  return row;
}

describe("importAccountSettings", () => {
  it("roundtrips distinct policy/prompt/weights from source onto target", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-SRC", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "live", accountNumber: "LV-TGT", label: "Target", isActive: false });

    db.setPolicy({ ...db.getPolicy(userId, source), maxOrderNotional: 4242, maxDailyOrders: 17 }, userId, source);
    db.setStrategyPrompt("Distinctive source prompt.", userId, source);
    const withWeights = db.getPolicy(userId, source);
    db.setPolicy({ ...withWeights, scoringWeights: { ...withWeights.scoringWeights, momentum: 77 } }, userId, source);

    const result = db.importAccountSettings(userId, source, target);

    expect(result.maxOrderNotional).toBe(4242);
    expect(result.maxDailyOrders).toBe(17);
    expect(result.scoringWeights.momentum).toBe(77);
    expect(db.getStrategyPrompt(userId, target)).toBe("Distinctive source prompt.");
    // Effective read reflects the target account's own identity, never the source's.
    expect(result.connectedAccountId).toBe(target);
    expect(result.accountNumber).toBe("LV-TGT");
  });

  it("preserves the target's systemState — import never arms or disarms", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-S2", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "live", accountNumber: "LV-T2", label: "Target", isActive: false });

    db.setPolicy({ ...db.getPolicy(userId, source), systemState: "active" }, userId, source);
    db.setPolicy({ ...db.getPolicy(userId, target), systemState: "halted" }, userId, target);

    const result = db.importAccountSettings(userId, source, target);

    expect(result.systemState).toBe("halted");
    expect(db.getPolicy(userId, target).systemState).toBe("halted");
    // Source is untouched by the import.
    expect(db.getPolicy(userId, source).systemState).toBe("active");
  });

  it("preserves the target's strategyAuthority — import never arms Autopilot", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-S3", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "live", accountNumber: "LV-T3", label: "Target", isActive: false });

    db.setPolicy({ ...db.getPolicy(userId, source), strategyAuthority: "decide" }, userId, source);
    db.setPolicy({ ...db.getPolicy(userId, target), strategyAuthority: "propose" }, userId, target);

    const result = db.importAccountSettings(userId, source, target);

    expect(result.strategyAuthority).toBe("propose");
    expect(db.getPolicy(userId, target).strategyAuthority).toBe("propose");
    expect(db.getPolicy(userId, source).strategyAuthority).toBe("decide");
  });

  it("never copies identity fields — target keeps its own accountNumber/broker, and the source's never lands in target's stored JSON", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-ID-SRC", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "tradier", environment: "live", accountNumber: "LV-ID-TGT", label: "Target", isActive: false });

    db.setPolicy({ ...db.getPolicy(userId, source), maxOrderNotional: 500 }, userId, source);

    db.importAccountSettings(userId, source, target);

    const effective = db.getPolicy(userId, target);
    expect(effective.accountNumber).toBe("LV-ID-TGT");
    expect(effective.activeBroker).toBe("tradier");
    expect(effective.connectedAccountId).toBe(target);

    const raw = rawAccountStrategyState(db, userId, target);
    expect(raw).toBeTruthy();
    const rawPolicy = JSON.parse(raw!.policy) as Record<string, unknown>;
    expect(rawPolicy.accountNumber).not.toBe("PA-ID-SRC");
    expect(rawPolicy.connectedAccountId).not.toBe(source);
    expect(rawPolicy.activeBroker).not.toBe("alpaca");
  });

  it("does not duplicate user-level fields into the target's account-level JSON", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-UL-SRC", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "live", accountNumber: "LV-UL-TGT", label: "Target", isActive: false });

    // notificationSettings is a USER-LEVEL field (overlaid from user_settings, not per-account).
    // mergePolicy always backfills SOME notificationSettings object (it's a non-optional TradingPolicy
    // field), so its mere presence in stored JSON proves nothing — the real assertion is that a
    // distinctive VALUE living on the source's raw row never propagates onto the target; the field
    // must come back out as the DEFAULT, not the source's tampered value. Seed the source's raw row
    // directly (rather than through setPolicy, which would tier a live notificationSettings write off
    // to user_settings and never let it reach account-level storage in the first place) so this test
    // proves the import-time strip itself, not setPolicy's own tiering.
    db.getPolicy(userId, source); // lazily seeds the source's account_strategy_state row
    const db2 = db.getDb();
    const sourceRawBefore = rawAccountStrategyState(db, userId, source);
    expect(sourceRawBefore).toBeTruthy();
    const marker = "https://source-marker.example.com/hook";
    const tampered = {
      ...(JSON.parse(sourceRawBefore!.policy) as Record<string, unknown>),
      notificationSettings: { webhookUrl: marker, enabledEvents: [] }
    };
    db2
      .prepare("UPDATE account_strategy_state SET policy = ? WHERE user_id = ? AND connected_account_id = ?")
      .run(JSON.stringify(tampered), userId, source);

    db.importAccountSettings(userId, source, target);

    const raw = rawAccountStrategyState(db, userId, target);
    expect(raw).toBeTruthy();
    const rawPolicy = JSON.parse(raw!.policy) as { notificationSettings?: { webhookUrl?: string } };
    expect(rawPolicy.notificationSettings?.webhookUrl).not.toBe(marker);
    expect(rawPolicy.notificationSettings?.webhookUrl).toBe("");
  });

  it("rejects when source or target belongs to a different user", async () => {
    const db = await import("../src/lib/db");
    const owner = `owner-${randomUUID()}`;
    const attacker = `attacker-${randomUUID()}`;
    const ownerAccount = `owner-acct-${randomUUID()}`;
    const attackerAccount = `attacker-acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: ownerAccount, userId: owner, broker: "alpaca", environment: "paper", accountNumber: "PA-OWN", label: "Owner", isActive: true });
    db.upsertConnectedAccount({ id: attackerAccount, userId: attacker, broker: "alpaca", environment: "paper", accountNumber: "PA-ATK", label: "Attacker", isActive: true });
    // Give the owner's account some state to import (so the failure is strictly about ownership).
    db.setPolicy({ ...db.getPolicy(owner, ownerAccount), maxOrderNotional: 321 }, owner, ownerAccount);
    db.setPolicy({ ...db.getPolicy(attacker, attackerAccount), maxOrderNotional: 321 }, attacker, attackerAccount);

    // Attacker tries to use the owner's account as the SOURCE.
    expect(() => db.importAccountSettings(attacker, ownerAccount, attackerAccount)).toThrow(/not found/i);
    // Attacker tries to use the owner's account as the TARGET.
    expect(() => db.importAccountSettings(attacker, attackerAccount, ownerAccount)).toThrow(/not found/i);
    // Neither attempt actually wrote the owner's row.
    expect(db.getPolicy(owner, ownerAccount).maxOrderNotional).toBe(321);
  });

  it("rejects when source and target are the same account", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-SAME", label: "Solo", isActive: true });
    expect(() => db.importAccountSettings(userId, acct, acct)).toThrow(/must be different/i);
  });

  it("rejects when the source account has no strategy state yet", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    // upsertConnectedAccount alone does not seed account_strategy_state — only a getPolicy/setPolicy
    // touch does that lazily, so a freshly-connected source genuinely has no row yet.
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-NOSTATE", label: "Fresh source", isActive: false });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-NOSTATE-T", label: "Target", isActive: true });

    expect(() => db.importAccountSettings(userId, source, target)).toThrow(/no strategy settings/i);
  });

  it("carries the source's derived_from_profile_id lineage onto the target, clearing stale target lineage when the source has none", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const source = `source-${randomUUID()}`;
    const target = `target-${randomUUID()}`;
    db.upsertConnectedAccount({ id: source, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-LIN-SRC", label: "Source", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "live", accountNumber: "LV-LIN-TGT", label: "Target", isActive: false });

    // Give the TARGET stale lineage from a profile it applied earlier.
    const staleProfile = db.createStrategyProfile({ name: "Stale", policy: db.getPolicy(userId, target) }, userId);
    db.applyProfileToAccount(staleProfile.id, target, userId);
    expect(rawAccountStrategyState(db, userId, target)?.derived_from_profile_id).toBe(staleProfile.id);

    // Source has no lineage of its own (never had a profile applied to it).
    db.setPolicy({ ...db.getPolicy(userId, source), maxOrderNotional: 900 }, userId, source);
    expect(rawAccountStrategyState(db, userId, source)?.derived_from_profile_id).toBeNull();

    db.importAccountSettings(userId, source, target);

    // Target's stale lineage is cleared, not preserved, since the source had none.
    expect(rawAccountStrategyState(db, userId, target)?.derived_from_profile_id).toBeNull();

    // Now the reverse: source DOES have lineage, and it should carry onto target.
    const linkedProfile = db.createStrategyProfile({ name: "Linked", policy: db.getPolicy(userId, source) }, userId);
    db.applyProfileToAccount(linkedProfile.id, source, userId);
    db.importAccountSettings(userId, source, target);
    expect(rawAccountStrategyState(db, userId, target)?.derived_from_profile_id).toBe(linkedProfile.id);
  });
});
