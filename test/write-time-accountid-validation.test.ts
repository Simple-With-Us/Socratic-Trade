/**
 * PR #7 — write-time account ownership validation (the real safety boundary). A mutating
 * write that targets a specific connected account is rejected server-side when the account
 * does not belong to the session user — regardless of the id the client supplies. Session
 * identity is derived from the verified request header, not the request body.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-writeguard-${randomUUID()}.db`)}`;
});

describe("write-time accountId validation (PR #7)", () => {
  it("rejects a write against an account owned by a DIFFERENT user", async () => {
    const db = await import("../src/lib/db");
    const owner = `owner-${randomUUID()}`;
    const attacker = `attacker-${randomUUID()}`;
    const victimAccount = `victim-acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: victimAccount, userId: owner, broker: "alpaca", environment: "paper", accountNumber: "PA-V", label: "Victim", isActive: true });

    // The attacker has a profile of their own but does NOT own victimAccount.
    const attackerProfile = db.createStrategyProfile({ name: "Mine" }, attacker);

    // A stale/malicious write attempting to target the victim's account under the attacker's
    // session must be rejected.
    expect(() => db.assertConnectedAccountOwnedByUser(attacker, victimAccount)).toThrow(/not found/i);
    expect(() => db.applyProfileToAccount(attackerProfile.id, victimAccount, attacker)).toThrow(/not found/i);

    // And it never wrote the victim's row on behalf of the attacker.
    expect(db.peekPolicy(owner, victimAccount).systemState).toBe("halted");
  });

  it("rejects a write against a non-existent account id", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    expect(() => db.assertConnectedAccountOwnedByUser(u, `ghost-${randomUUID()}`)).toThrow(/not found/i);
  });

  it("allows a write against an account the session user DOES own", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Mine", isActive: true });
    const profile = db.createStrategyProfile({ name: "Mine" }, u);
    expect(() => db.assertConnectedAccountOwnedByUser(u, acct)).not.toThrow();
    expect(() => db.applyProfileToAccount(profile.id, acct, u)).not.toThrow();
  });
});
