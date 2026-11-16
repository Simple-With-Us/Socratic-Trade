/**
 * PR #7 — the ⛔ gate: view/execution decouple.
 *
 * Switching which account is the ephemeral "view pointer" must cause ZERO execution
 * change on any account, and a freshly-seeded account must never auto-arm — fail-closed
 * to "halted" — independent of which account is active. (Previously the seed coerced
 * on `!== activeId`, coupling execution state to the view pointer.)
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-decouple-${randomUUID()}.db`)}`;
});

describe("view/execution decouple (PR #7)", () => {
  it("switching the active (view) pointer never changes another account's run-state", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const a = `a-${randomUUID()}`;
    const b = `b-${randomUUID()}`;
    db.upsertConnectedAccount({ id: a, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "A", isActive: true });
    db.upsertConnectedAccount({ id: b, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-B", label: "B", isActive: false });

    // Arm A, leave B halted.
    db.setPolicy({ ...db.getPolicy(u, a), systemState: "active" }, u, a);
    db.setPolicy({ ...db.getPolicy(u, b), systemState: "halted" }, u, b);
    expect(db.getPolicy(u, a).systemState).toBe("active");
    expect(db.getPolicy(u, b).systemState).toBe("halted");

    // Switch the view pointer back and forth — pure view change.
    db.setActiveConnectedAccount(b, u);
    db.setActiveConnectedAccount(a, u);
    db.setActiveConnectedAccount(b, u);

    // Neither account's execution state moved.
    expect(db.getPolicy(u, a).systemState).toBe("active");
    expect(db.getPolicy(u, b).systemState).toBe("halted");
  });

  it("a fresh account seeds 'halted' even when it IS the active pointer (fail-closed, no auto-arm)", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const armed = `armed-${randomUUID()}`;
    const fresh = `fresh-${randomUUID()}`;
    db.upsertConnectedAccount({ id: armed, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-1", label: "Armed", isActive: true });

    // Arm the active account AND push an "active" run-state into the shared library base
    // via an active profile, so the base policy a fresh account seeds from is "active".
    db.setPolicy({ ...db.getPolicy(u, armed), systemState: "active" }, u, armed);
    db.createStrategyProfile({ name: "Live", policy: { ...db.getPolicy(u, armed), systemState: "active" }, active: true }, u);

    // Now connect a second account and make IT the active pointer, then first-touch it.
    db.upsertConnectedAccount({ id: fresh, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-2", label: "Fresh", isActive: false });
    db.setActiveConnectedAccount(fresh, u);

    // Even as the active account, the fresh seed fail-closes to halted — it never
    // inherits "active" from the base policy.
    expect(db.getPolicy(u, fresh).systemState).toBe("halted");
  });

  it("a fresh NON-active account also seeds 'halted' (regression: no auto-arm)", async () => {
    const db = await import("../src/lib/db");
    const u = `user-${randomUUID()}`;
    const active = `active-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    db.upsertConnectedAccount({ id: active, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-A", label: "Active", isActive: true });
    db.upsertConnectedAccount({ id: other, userId: u, broker: "alpaca", environment: "paper", accountNumber: "PA-O", label: "Other", isActive: false });
    db.createStrategyProfile({ name: "Live", policy: { ...db.getPolicy(u, active), systemState: "active" }, active: true }, u);
    db.setPolicy({ ...db.getPolicy(u, active), systemState: "active" }, u, active);

    expect(db.getPolicy(u, other).systemState).toBe("halted");
  });
});
