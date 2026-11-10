import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = join(tmpdir(), `socratic-provider-dispatch-${randomUUID()}`);
const path = join(dir, "test.db");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
process.env.DATABASE_URL = `file:${path}`;

const {
  cancelUndispatchedProviderReservation,
  getDb,
  heartbeatProviderDispatch,
  markProviderDispatchStarted,
  reconcileStaleProviderDispatches,
  reserveProviderDispatch,
  resolveStaleProviderDispatch,
  settleProviderDispatch,
  isProviderDispatchLeaseLostError,
  ProviderDispatchLeaseLostError
} = await import("../src/lib/db");
const { getAccountDeletionBlockers } = await import("../src/lib/account-deletion");

beforeEach(() => {
  getDb().exec("DELETE FROM provider_usage_outbox; DELETE FROM provider_dispatch_attempts; DELETE FROM account_deletion_requests; DELETE FROM audit_events;");
});

afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch { /* best effort */ }
  }
});

describe("durable provider dispatch admission and usage truth", () => {
  it("atomically enforces credential-scoped windows and releases only undispatched reservations", () => {
    const now = "2026-07-14T12:00:00.000Z";
    const input = {
      provider: "fmp",
      operation: "transcript-dates",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      windows: [{ maxUnits: 1, windowMs: 60_000 }],
      now
    };
    const first = reserveProviderDispatch(input);
    expect(first.admitted).toBe(true);
    expect(reserveProviderDispatch(input)).toEqual({ admitted: false, reason: "request_window" });

    if (!first.admitted) throw new Error("Expected first reservation.");
    expect(cancelUndispatchedProviderReservation(first.attemptId, "test-refund", now)).toBe(true);
    const afterRefund = reserveProviderDispatch(input);
    expect(afterRefund.admitted).toBe(true);
    if (!afterRefund.admitted) throw new Error("Expected reservation after refund.");
    markProviderDispatchStarted(afterRefund.attemptId, now);
    expect(cancelUndispatchedProviderReservation(afterRefund.attemptId, "too-late", now)).toBe(false);
    expect(reserveProviderDispatch(input)).toEqual({ admitted: false, reason: "request_window" });

    expect(reserveProviderDispatch({ ...input, credentialRef: "credential-b" }).admitted).toBe(true);
  });

  it("reuses an idempotency receipt before quota evaluation without reserving twice", () => {
    const input = {
      provider: "voyage",
      operation: "embed document",
      credentialRef: "voyage-credential",
      authorityId: "shared-test-authority",
      windows: [{ maxUnits: 1, windowMs: 60_000 }],
      idempotencyKey: "logical-attempt-1",
      now: "2026-07-14T12:10:00.000Z"
    };
    const first = reserveProviderDispatch(input);
    const repeated = reserveProviderDispatch(input);
    expect(first.admitted).toBe(true);
    expect(repeated).toEqual(first);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM provider_dispatch_attempts").get())
      .toEqual({ count: 1 });
    expect(reserveProviderDispatch({ ...input, idempotencyKey: "logical-attempt-2" }))
      .toEqual({ admitted: false, reason: "request_window" });
  });

  it("fences new work and idempotency replay once deletion is prepared, except for the exact erasure request", () => {
    const userId = "deleting-user";
    const requestId = randomUUID();
    const input = {
      provider: "pinecone",
      operation: "query",
      credentialRef: "deleting-user-credential",
      userId,
      authorityId: "shared-test-authority",
      idempotencyKey: "before-delete",
      now: "2026-07-14T12:15:00.000Z"
    };
    expect(reserveProviderDispatch(input).admitted).toBe(true);
    getDb().prepare(`
      INSERT INTO account_deletion_requests (id, user_id, email, requested_at, status)
      VALUES (?, ?, 'delete@example.com', ?, 'prepared')
    `).run(requestId, userId, input.now);

    expect(reserveProviderDispatch(input)).toEqual({ admitted: false, reason: "account_deletion" });
    expect(reserveProviderDispatch({ ...input, idempotencyKey: "new-work" }))
      .toEqual({ admitted: false, reason: "account_deletion" });
    expect(reserveProviderDispatch({
      ...input,
      operation: "account private-vector delete",
      idempotencyKey: "erasure-work",
      accountDeletionRequestId: requestId
    }).admitted).toBe(true);
    expect(reserveProviderDispatch({
      ...input,
      provider: "voyage",
      operation: "account private-vector delete",
      idempotencyKey: "wrong-provider-bypass",
      accountDeletionRequestId: requestId
    })).toEqual({ admitted: false, reason: "account_deletion" });
    expect(reserveProviderDispatch({
      ...input,
      operation: "query",
      idempotencyKey: "wrong-operation-bypass",
      accountDeletionRequestId: requestId
    })).toEqual({ admitted: false, reason: "account_deletion" });
    getDb().prepare("UPDATE account_deletion_requests SET status = 'completed' WHERE id = ?").run(requestId);
    expect(reserveProviderDispatch({
      ...input,
      operation: "account private-vector delete",
      idempotencyKey: "stale-request-bypass",
      accountDeletionRequestId: requestId
    })).toEqual({ admitted: false, reason: "account_deletion" });
  });

  it("persists one immutable terminal outcome and reports the reserved request units", () => {
    const reservation = reserveProviderDispatch({
      provider: "pinecone",
      operation: "upsert",
      credentialRef: "pinecone-credential",
      authorityId: "shared-test-authority",
      units: 2,
      now: "2026-07-14T12:20:00.000Z"
    });
    if (!reservation.admitted) throw new Error("Expected reservation.");
    markProviderDispatchStarted(reservation.attemptId, "2026-07-14T12:20:01.000Z");
    settleProviderDispatch(reservation.attemptId, "succeeded", {
      outcomeCode: "provider-ack",
      at: "2026-07-14T12:20:02.000Z"
    });
    // A late/double callback cannot rewrite the already-persisted truth.
    settleProviderDispatch(reservation.attemptId, "failed", {
      outcomeCode: "late-error",
      at: "2026-07-14T12:20:03.000Z"
    });

    expect(getDb().prepare(`
      SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?
    `).get(reservation.attemptId)).toEqual({ status: "succeeded", outcome_code: "provider-ack" });
    expect(getDb().prepare(`
      SELECT outcome, requests FROM provider_usage_outbox WHERE attempt_id = ?
    `).get(reservation.attemptId)).toEqual({ outcome: "succeeded", requests: 2 });
    expect(() => markProviderDispatchStarted(reservation.attemptId))
      .toThrow("Provider dispatch boundary was not durably recorded.");
  });

  it("keeps a genuinely slow dispatched call live when its exact owner heartbeats", () => {
    const old = "2026-07-14T12:00:00.000Z";
    const dispatched = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-body",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      now: old
    });
    const undispatched = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-dates",
      credentialRef: "credential-b",
      authorityId: "shared-test-authority",
      now: old
    });
    if (!dispatched.admitted || !undispatched.admitted) throw new Error("Expected reservations.");
    const lease = markProviderDispatchStarted(dispatched.attemptId, old, {
      supervise: false,
      leaseMs: 60_000
    });
    expect(heartbeatProviderDispatch(dispatched.attemptId, lease.ownerToken, {
      at: "2026-07-14T12:00:30.000Z",
      leaseMs: 60_000
    })).toBe(true);

    expect(reconcileStaleProviderDispatches("2026-07-14T12:01:00.000Z", 60_000))
      .toEqual({ released: 1, unknown: 0 });
    expect(getDb().prepare(`
      SELECT status FROM provider_dispatch_attempts WHERE id = ?
    `).get(dispatched.attemptId)).toEqual({ status: "dispatched" });
    expect(getDb().prepare(`
      SELECT status FROM provider_dispatch_attempts WHERE id = ?
    `).get(undispatched.attemptId)).toEqual({ status: "cancelled" });
    expect(getDb().prepare(`
      SELECT outcome FROM provider_usage_outbox WHERE attempt_id = ?
    `).get(dispatched.attemptId)).toBeUndefined();
    expect(() => settleProviderDispatch(dispatched.attemptId, "succeeded", {
      at: "2026-07-14T12:01:01.000Z",
      ownerToken: "wrong-owner-token"
    })).toThrow("Provider dispatch lease was lost before outcome persistence");
    settleProviderDispatch(dispatched.attemptId, "succeeded", {
      at: "2026-07-14T12:01:01.000Z",
      ownerToken: lease.ownerToken
    });
  });

  it("classifies only the deleting user's expired owner as unresolved unknown", () => {
    const old = "2026-07-14T12:00:00.000Z";
    const deleting = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-body",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      userId: "deleting-user",
      now: old
    });
    const other = reserveProviderDispatch({
      provider: "fmp",
      operation: "transcript-body",
      credentialRef: "credential-b",
      authorityId: "shared-test-authority",
      userId: "other-user",
      now: old
    });
    if (!deleting.admitted || !other.admitted) throw new Error("Expected reservations.");
    markProviderDispatchStarted(deleting.attemptId, old, { supervise: false, leaseMs: 60_000 });
    markProviderDispatchStarted(other.attemptId, old, { supervise: false, leaseMs: 60_000 });

    expect(reconcileStaleProviderDispatches("2026-07-14T12:10:00.000Z", 60_000, "deleting-user"))
      .toEqual({ released: 0, unknown: 1 });
    expect(getDb().prepare(`
      SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?
    `).get(deleting.attemptId)).toEqual({
      status: "unknown",
      outcome_code: "stale-owner-unresolved"
    });
    expect(getDb().prepare("SELECT status FROM provider_dispatch_attempts WHERE id = ?").get(other.attemptId))
      .toEqual({ status: "dispatched" });
  });

  it("rejects a late owner callback and requires an audited operator resolution", () => {
    const attempt = reserveProviderDispatch({
      provider: "pinecone",
      operation: "upsert",
      credentialRef: "credential-a",
      authorityId: "shared-test-authority",
      userId: "deleting-user",
      now: "2026-07-14T12:00:00.000Z"
    });
    if (!attempt.admitted) throw new Error("Expected reservation.");
    const lease = markProviderDispatchStarted(attempt.attemptId, "2026-07-14T12:00:01.000Z", {
      supervise: false,
      leaseMs: 60_000
    });
    expect(reconcileStaleProviderDispatches("2026-07-14T12:02:00.000Z", 60_000, "deleting-user"))
      .toEqual({ released: 0, unknown: 1 });
    expect(heartbeatProviderDispatch(attempt.attemptId, lease.ownerToken, {
      at: "2026-07-14T12:02:01.000Z",
      leaseMs: 60_000
    })).toBe(false);
    expect(() => settleProviderDispatch(attempt.attemptId, "succeeded", {
      at: "2026-07-14T12:02:01.000Z"
    })).toThrow("Provider dispatch lease was lost before outcome persistence");
    expect(getDb().prepare(`
      SELECT outcome FROM provider_usage_outbox WHERE attempt_id = ?
    `).get(attempt.attemptId)).toEqual({ outcome: "unknown" });
    expect(getAccountDeletionBlockers("deleting-user").activeProviderDispatches).toBe(1);

    expect(() => resolveStaleProviderDispatch({
      attemptId: attempt.attemptId,
      attestedBy: "",
      reason: "old deployment was terminated",
      at: "2026-07-14T12:02:02.000Z"
    })).toThrow("requires attempt id, attestedBy, and reason");
    expect(resolveStaleProviderDispatch({
      attemptId: attempt.attemptId,
      attestedBy: "operator@example.com",
      reason: "verified the old deployment and process are terminated",
      at: "2026-07-14T12:02:02.000Z"
    })).toBe(true);
    expect(getDb().prepare(`
      SELECT status, outcome_code FROM provider_dispatch_attempts WHERE id = ?
    `).get(attempt.attemptId)).toEqual({
      status: "unknown",
      outcome_code: "stale-owner-resolved"
    });
    const audit = getDb().prepare(`
      SELECT user_id, kind, payload FROM audit_events
      WHERE kind = 'provider_dispatch_stale_owner_resolved'
    `).get() as { user_id: string; kind: string; payload: string };
    expect(audit.user_id).toBe("deleting-user");
    expect(audit.kind).toBe("provider_dispatch_stale_owner_resolved");
    expect(JSON.parse(audit.payload)).toMatchObject({
      attemptId: attempt.attemptId,
      provider: "pinecone",
      operation: "upsert",
      attestedBy: "operator@example.com"
    });
    expect(getAccountDeletionBlockers("deleting-user").activeProviderDispatches).toBe(0);
    expect(resolveStaleProviderDispatch({
      attemptId: attempt.attemptId,
      attestedBy: "operator@example.com",
      reason: "duplicate resolution",
      at: "2026-07-14T12:02:03.000Z"
    })).toBe(false);
  });

  it("charges the greater of actual and reserved cost against later daily admission", () => {
    const base = {
      provider: "voyage",
      operation: "embed",
      credentialRef: "voyage-credential",
      authorityId: "shared-test-authority",
      maxEstimatedCostUsdPer24h: 1,
      now: "2026-07-14T12:30:00.000Z"
    };
    const first = reserveProviderDispatch({ ...base, estimatedCostUsd: 0.6 });
    if (!first.admitted) throw new Error("Expected first cost reservation.");
    markProviderDispatchStarted(first.attemptId, base.now);
    settleProviderDispatch(first.attemptId, "succeeded", {
      actualCostUsd: 0.8,
      at: "2026-07-14T12:30:01.000Z"
    });
    expect(reserveProviderDispatch({ ...base, estimatedCostUsd: 0.3 }))
      .toEqual({ admitted: false, reason: "cost_cap" });
  });
});

describe("isProviderDispatchLeaseLostError", () => {
  it("recognizes the typed error, the message, and a re-wrap, but not vendor HTTP", () => {
    const lost = new ProviderDispatchLeaseLostError("attempt-1");
    expect(isProviderDispatchLeaseLostError(lost)).toBe(true);
    expect(isProviderDispatchLeaseLostError(lost.message)).toBe(true);
    expect(isProviderDispatchLeaseLostError(new Error("query managed shared tier", { cause: lost }))).toBe(true);
    expect(isProviderDispatchLeaseLostError(new Error("PineconeConnectionError: Request failed"))).toBe(false);
    expect(isProviderDispatchLeaseLostError(undefined)).toBe(false);
  });
});
