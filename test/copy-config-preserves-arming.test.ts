/**
 * PR #7 — the ambient policy mirror (`copyPolicyConfigToActiveAccount`, formerly
 * `mirrorPolicyToActiveAccount`) propagates strategy CONFIG to the active account when a
 * library profile is created/updated/activated, but must NEVER arm or disarm that account
 * as a side-effect. Editing a library profile is a config change, not an execution command.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-copy-config-${randomUUID()}.db`)}`;
});

describe("library-profile edits never arm/disarm the active account (PR #7)", () => {
  it("activating a profile whose policy is 'active' does NOT arm a halted active account", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Acct", isActive: true });

    // Active account is explicitly halted.
    db.setPolicy({ ...db.getPolicy(u, acct), systemState: "halted", maxOrderNotional: 10 }, u, acct);
    expect(db.getPolicy(u, acct).systemState).toBe("halted");

    // Build + activate a library profile whose saved policy is "active" (armed) with a new cap.
    const armed = db.createStrategyProfile({ name: "Armed", policy: { ...db.getPolicy(u, acct), systemState: "active", maxOrderNotional: 99 } }, u);
    db.activateStrategyProfile(armed.id, u);

    // The config propagated (new cap) but the run-state is preserved — still halted.
    const after = db.getPolicy(u, acct);
    expect(after.systemState).toBe("halted");
    expect(after.maxOrderNotional).toBe(99);
  });

  it("activating a profile whose policy is 'halted' does NOT disarm an armed active account", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Acct", isActive: true });

    // Active account is armed.
    db.setPolicy({ ...db.getPolicy(u, acct), systemState: "active" }, u, acct);
    expect(db.getPolicy(u, acct).systemState).toBe("active");

    // Activate a "halted" library profile.
    const halted = db.createStrategyProfile({ name: "Halted", policy: { ...db.getPolicy(u, acct), systemState: "halted" } }, u);
    db.activateStrategyProfile(halted.id, u);

    // Still armed — a config change never disarms.
    expect(db.getPolicy(u, acct).systemState).toBe("active");
  });

  it("activating a profile whose policy is Autopilot does NOT arm Ask-first on the active account", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Acct", isActive: true });

    db.setPolicy({ ...db.getPolicy(u, acct), strategyAuthority: "propose" }, u, acct);
    expect(db.getPolicy(u, acct).strategyAuthority).toBe("propose");

    const autopilot = db.createStrategyProfile({
      name: "Autopilot",
      policy: { ...db.getPolicy(u, acct), strategyAuthority: "decide", maxOrderNotional: 99 }
    }, u);
    db.activateStrategyProfile(autopilot.id, u);

    const after = db.getPolicy(u, acct);
    expect(after.strategyAuthority).toBe("propose");
    expect(after.maxOrderNotional).toBe(99);
  });

  it("activating a profile whose policy is Ask-first does NOT disarm Autopilot on the active account", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    db.upsertConnectedAccount({ id: acct, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Acct", isActive: true });

    db.setPolicy({ ...db.getPolicy(u, acct), strategyAuthority: "decide" }, u, acct);
    expect(db.getPolicy(u, acct).strategyAuthority).toBe("decide");

    const askFirst = db.createStrategyProfile({
      name: "Ask-first",
      policy: { ...db.getPolicy(u, acct), strategyAuthority: "propose" }
    }, u);
    db.activateStrategyProfile(askFirst.id, u);

    expect(db.getPolicy(u, acct).strategyAuthority).toBe("decide");
  });
});
