/**
 * PR 2 — copy a saved library strategy into a CHOSEN connected account.
 *
 * `applyProfileToAccount` writes only the target account's live state (not the active account, and
 * without flipping the library's active flag), stamps provenance, and — critically — preserves the
 * target account's run-state so applying a strategy never arms/disarms autonomy.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-copy-to-account-${randomUUID()}.db`)}`;
});

describe("strategy copy-to-account (PR 2)", () => {
  it("copies a saved profile into a chosen non-active account, leaving the active account untouched", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const active = `active-${randomUUID()}`;
    const target = `target-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-ACT", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-TGT", label: "Target", isActive: false });

    // Distinct live state on the active account (so we can prove the copy doesn't touch it).
    db.setPolicy({ ...db.getPolicy(userId, active), maxOrderNotional: 111 }, userId, active);

    // A saved library strategy with its own distinctive cap.
    const profile = db.createStrategyProfile(
      { name: "Aggressive", policy: { ...db.getPolicy(userId, active), maxOrderNotional: 999 } },
      userId
    );

    const result = db.applyProfileToAccount(profile.id, target, userId);
    expect(result).toEqual({ profileId: profile.id, connectedAccountId: target });

    // Target account now carries the saved strategy's cap + provenance…
    expect(db.getPolicy(userId, target).maxOrderNotional).toBe(999);
    expect(db.getPolicy(userId, target).activeProfileId).toBe(profile.id);
    // …while the active account is unchanged.
    expect(db.getPolicy(userId, active).maxOrderNotional).toBe(111);
  });

  it("preserves the target account's run-state — copying never arms autonomy", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const active = `active-${randomUUID()}`;
    const target = `target-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-A2", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-T2", label: "Target", isActive: false });

    // Target is halted; build a saved strategy that is itself "active".
    db.setPolicy({ ...db.getPolicy(userId, target), systemState: "halted" }, userId, target);
    const armed = db.createStrategyProfile(
      { name: "Armed", policy: { ...db.getPolicy(userId, active), systemState: "active" } },
      userId
    );

    db.applyProfileToAccount(armed.id, target, userId);

    // The saved strategy was "active", but the target account stays "halted".
    expect(db.getPolicy(userId, target).systemState).toBe("halted");
  });

  it("preserves the target account's strategyAuthority — copying never arms Autopilot", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const active = `active-${randomUUID()}`;
    const target = `target-${randomUUID()}`;

    db.upsertConnectedAccount({ id: active, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-A3", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: target, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-T3", label: "Target", isActive: false });

    db.setPolicy({ ...db.getPolicy(userId, target), strategyAuthority: "propose" }, userId, target);
    const autopilot = db.createStrategyProfile(
      { name: "Autopilot", policy: { ...db.getPolicy(userId, active), strategyAuthority: "decide" } },
      userId
    );

    db.applyProfileToAccount(autopilot.id, target, userId);

    expect(db.getPolicy(userId, target).strategyAuthority).toBe("propose");
  });

  it("rejects unknown profile or unknown account", async () => {
    const db = await import("../src/lib/db");
    const userId = `u-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId, broker: "alpaca", environment: "paper", accountNumber: "PA-X", label: "X", isActive: true });
    const profile = db.createStrategyProfile({ name: "P", policy: db.getPolicy(userId, acct) }, userId);

    expect(() => db.applyProfileToAccount("no-such-profile", acct, userId)).toThrow(/not found/i);
    expect(() => db.applyProfileToAccount(profile.id, "no-such-account", userId)).toThrow(/not found/i);
  });
});
