import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Review rank 8 (2026-09-25): "Decide what to do with the dormant accounts... For each: park it,
 * re-arm it, or investigate."
 *
 * The review could not make that call because nothing in the state vocabulary could express it.
 * `systemState: "halted"` says trading stopped; `isDraining` says the account is being
 * disconnected. Neither says a person looked at Alpaca Standard (last run Jul 6) and decided it
 * should stay quiet — so a deliberately quiet account and a broken one were indistinguishable, and
 * all four dormant accounts kept reporting unexplained zeros or unknown balances.
 *
 * These tests pin the properties that make the flag useful rather than decorative: the reason is
 * mandatory, the two states stay independent, the decision is auditable in both directions, and
 * un-parking clears the stale reason with it.
 */

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-parked-${randomUUID()}.db`)}`;
  process.env.OPS_DIAGNOSTIC_TOKEN = "test-ops-token";
});

async function seedAccount() {
  const db = await import("../src/lib/db");
  const userId = `park-user-${randomUUID()}`;
  const accountId = `park-acct-${randomUUID()}`;
  db.upsertConnectedAccount({
    id: accountId,
    userId,
    broker: "alpaca",
    environment: "paper",
    accountNumber: `PARK-${randomUUID()}`,
    label: "Dormant Account",
    isActive: true
  });
  db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "halted" }, userId, accountId);
  return { db, userId, accountId };
}

const parse = async (raw: unknown) => (await import("../src/lib/ops-account-control")).parseOpsAccountControlRequest(raw);

describe("ops account control — park (review rank 8)", () => {
  it("rejects a park with no reason, because a blank reason is what it exists to prevent", async () => {
    await seedAccount();
    const missing = await parse({ action: "park_account", connectedAccountId: "acct" });
    expect(missing.ok).toBe(false);
    const blank = await parse({ action: "park_account", connectedAccountId: "acct", reason: "   " });
    expect(blank.ok).toBe(false);
    const good = await parse({ action: "park_account", connectedAccountId: "acct", reason: "no activity since Jul 6; owner decision" });
    expect(good.ok).toBe(true);
  });

  it("rejects an over-long reason rather than using the flag as free-text storage", async () => {
    await seedAccount();
    const { OPS_MAX_PARK_REASON } = await import("../src/lib/ops-account-control");
    const tooLong = await parse({ action: "park_account", connectedAccountId: "acct", reason: "x".repeat(OPS_MAX_PARK_REASON + 1) });
    expect(tooLong.ok).toBe(false);
  });

  it("records the decision and reads it back through the account row", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    const reason = "dormant since Jul 6; parked pending owner review of the unknown balance";

    const outcome = await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason, dryRun: false });
    expect(outcome.status).toBe(200);

    const stored = db.listConnectedAccounts(userId).find((a) => a.id === accountId);
    expect(stored?.parked).toBe(true);
    expect(stored?.parkedReason).toBe(reason);
    expect(typeof stored?.parkedAt).toBe("string");
  });

  it("dryRun reports the decision WITHOUT writing it", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    const outcome = await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "trial", dryRun: true });
    expect(outcome.status).toBe(200);
    const stored = db.listConnectedAccounts(userId).find((a) => a.id === accountId);
    expect(stored?.parked).toBeFalsy();
  });

  it("does NOT halt the account — parking records a decision, set_system_state halts", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    // Armed on paper so a park that silently halted would be visible in the state.
    db.setPolicy({ ...db.getPolicy(userId, accountId), systemState: "active" }, userId, accountId);
    await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "decision only", dryRun: false });
    // systemState untouched: the two decisions stay independently auditable, otherwise "parked"
    // and "halted" collapse into one flag and the distinction evaporates on first use.
    expect(db.getPolicy(userId, accountId).systemState).toBe("active");
  });

  it("refuses to park a draining account", async () => {
    const { db, userId, accountId } = await seedAccount();
    db.getDb().prepare("UPDATE connected_accounts SET is_draining = 1 WHERE id = ?").run(accountId);
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    const outcome = await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "x", dryRun: false });
    expect(outcome.status).toBe(409);
    expect(db.listConnectedAccounts(userId).find((a) => a.id === accountId)?.parked).toBeFalsy();
  });

  it("refuses to silently overwrite a different reason, and surfaces the existing one", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "first decision", dryRun: false });
    const second = await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "a different decision", dryRun: false });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).toContain("first decision");
    // Re-parking with the SAME reason is idempotent, not an error.
    const again = await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "first decision", dryRun: false });
    expect(again.status).toBe(200);
  });

  it("un-parks and clears the reason and timestamp with the flag", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "temporary", dryRun: false });
    const outcome = await runOpsAccountControl({ action: "unpark_account", connectedAccountId: accountId, dryRun: false });
    expect(outcome.status).toBe(200);

    const stored = db.listConnectedAccounts(userId).find((a) => a.id === accountId);
    expect(stored?.parked).toBe(false);
    // A stale "why" must never outlive the decision it belonged to.
    expect(stored?.parkedReason).toBeUndefined();
    expect(stored?.parkedAt).toBeUndefined();
    // And un-parking must NOT arm the account — that is a separate, explicit decision.
    expect(db.getPolicy(userId, accountId).systemState).toBe("halted");
  });

  it("exposes the parked facts on every ops response so a dormant account explains itself", async () => {
    const { accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "owner decision", dryRun: false });
    const list = await runOpsAccountControl({ action: "list_working_orders", connectedAccountId: accountId, dryRun: true });
    expect(JSON.stringify(list.body)).toContain("owner decision");
  });

  it("audits both directions", async () => {
    const { db, userId, accountId } = await seedAccount();
    const { runOpsAccountControl } = await import("../src/lib/ops-account-control");
    await runOpsAccountControl({ action: "park_account", connectedAccountId: accountId, reason: "audited", dryRun: false });
    await runOpsAccountControl({ action: "unpark_account", connectedAccountId: accountId, dryRun: false });
    // Signature is (kind, limit, userId, connectedAccountId) - positional, no options object.
    const rows = db.listAuditByKind("ops_account_control", 200, userId, accountId) as Array<{ payload: unknown }>;
    const payloads = rows.map((r) => r.payload as Record<string, any>);
    // The audit payload carries `action` at the top level (auditOpsCall spreads `request.action`),
    // not a nested `request` object.
    expect(payloads.some((p) => p.action === "park_account")).toBe(true);
    expect(payloads.some((p) => p.action === "unpark_account")).toBe(true);
  });
});
