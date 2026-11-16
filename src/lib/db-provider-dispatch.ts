// Crash-durable external-provider dispatch admission and outcome ledger.
//
// A reservation is committed before a paid/network boundary. The caller marks it dispatched
// immediately before invoking the SDK/fetch and settles it after the promise resolves or rejects.
// These writes intentionally do not accept a business-operation lease: usage truth must survive
// lease loss, process crashes, and successor takeover.

import "server-only";
import crypto from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";

export type ProviderDispatchOutcome = "succeeded" | "failed" | "unknown";

export interface ProviderDispatchWindow {
  maxUnits: number;
  windowMs: number;
}

export interface ReserveProviderDispatchInput {
  provider: string;
  operation: string;
  credentialRef: string;
  userId?: string;
  units?: number;
  estimatedCostUsd?: number;
  windows?: ProviderDispatchWindow[];
  maxEstimatedCostUsdPer24h?: number;
  authorityId?: string;
  idempotencyKey?: string;
  /**
   * Narrow bypass for the provider-side account-erasure operation itself. Admission verifies this
   * exact durable prepared request still belongs to the same user; callers cannot use a boolean to
   * bypass the deletion fence.
   */
  accountDeletionRequestId?: string;
  now?: string;
}

export type ProviderDispatchReservation =
  | { admitted: true; attemptId: string; authorityId: string }
  | { admitted: false; reason: "request_window" | "cost_cap" | "account_deletion" };

export interface ProviderDispatchLease {
  attemptId: string;
  ownerToken: string;
  leaseExpiresAt: string;
}

export class ProviderDispatchLeaseLostError extends Error {
  constructor(attemptId: string) {
    super(`Provider dispatch lease was lost before outcome persistence (${attemptId}).`);
    this.name = "ProviderDispatchLeaseLostError";
  }
}

const PROVIDER_DISPATCH_LEASE_LOST_MESSAGE =
  /Provider dispatch lease was lost before outcome persistence/i;
const PROVIDER_DISPATCH_LEASE_LOST_CAUSE_DEPTH = 3;

/**
 * True when the failure is OUR durable-dispatch lease, not a vendor HTTP/network error.
 *
 * Prod (2026-08-17): a 1m23s UptimeRobot blip coincided with in-flight Pinecone query +
 * OpenRouter rerank settles. Those pages titled "Pinecone connection failed" /
 * "OpenRouter rerank connection failed" with this exact message. The vendor answered (or
 * the process died mid-settle); the LOCAL owner token was gone. Walks `cause` the same
 * way local-db-fault does so a re-wrap cannot re-label it as a provider outage.
 */
export function isProviderDispatchLeaseLostError(error: unknown, depth = 0): boolean {
  if (depth > PROVIDER_DISPATCH_LEASE_LOST_CAUSE_DEPTH) return false;
  if (typeof error === "string") return PROVIDER_DISPATCH_LEASE_LOST_MESSAGE.test(error);
  if (!error || typeof error !== "object") return false;
  if (error instanceof ProviderDispatchLeaseLostError) return true;
  const name = (error as { name?: unknown }).name;
  if (name === "ProviderDispatchLeaseLostError") return true;
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string" && PROVIDER_DISPATCH_LEASE_LOST_MESSAGE.test(message)) return true;
  return isProviderDispatchLeaseLostError((error as { cause?: unknown }).cause, depth + 1);
}

export interface ProviderDispatchStartOptions {
  /** Primarily a deterministic test seam; production dispatches are always supervised by default. */
  supervise?: boolean;
  leaseMs?: number;
}

const DEFAULT_PROVIDER_DISPATCH_LEASE_MS = 2 * 60_000;
const MIN_PROVIDER_DISPATCH_LEASE_MS = 1_000;
const MAX_PROVIDER_DISPATCH_LEASE_MS = 30 * 60_000;

interface LocalProviderDispatchLease {
  ownerToken: string;
  leaseMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

// This is intentionally process-local: a process crash removes the renewer while the durable row
// remains. One-shot unref'ed timers cannot keep Node/tests alive, and terminal settlement clears
// them. The database lease, not this map, is the cross-process source of truth.
const localProviderDispatchLeases = new Map<string, LocalProviderDispatchLease>();

const ACCOUNT_DELETION_PINECONE_OPERATIONS = new Set([
  "listIndexes",
  "describeIndex",
  "inventory list",
  "inventory fetch",
  "account private-namespace delete",
  "account legacy-private-filter delete",
  "account private-vector delete",
  "account private-vector verify"
]);

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function providerAuthorityId(explicit?: string): string {
  const configured = explicit?.trim() || process.env.PROVIDER_QUOTA_AUTHORITY_ID?.trim();
  return configured || "socratic-trade-local";
}

function validIso(value: string | undefined): string {
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function providerDispatchLeaseMs(explicit?: number): number {
  const raw = process.env.PROVIDER_DISPATCH_LEASE_MS?.trim();
  const configured = explicit ?? (raw ? Number(raw) : Number.NaN);
  if (!Number.isFinite(configured)) return DEFAULT_PROVIDER_DISPATCH_LEASE_MS;
  return Math.max(
    MIN_PROVIDER_DISPATCH_LEASE_MS,
    Math.min(MAX_PROVIDER_DISPATCH_LEASE_MS, Math.floor(configured))
  );
}

function leaseExpiry(at: string, leaseMs: number): string {
  return new Date(Date.parse(at) + leaseMs).toISOString();
}

function stopLocalProviderDispatchLease(attemptId: string, ownerToken?: string): void {
  const active = localProviderDispatchLeases.get(attemptId);
  if (!active || (ownerToken && active.ownerToken !== ownerToken)) return;
  if (active.timer) clearTimeout(active.timer);
  localProviderDispatchLeases.delete(attemptId);
}

function scheduleProviderDispatchHeartbeat(attemptId: string): void {
  const active = localProviderDispatchLeases.get(attemptId);
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  const delayMs = Math.max(250, Math.min(30_000, Math.floor(active.leaseMs / 3)));
  const timer = setTimeout(() => {
    const current = localProviderDispatchLeases.get(attemptId);
    if (!current || current.ownerToken !== active.ownerToken) return;
    current.timer = undefined;
    try {
      const renewed = heartbeatProviderDispatch(
        attemptId,
        current.ownerToken,
        { leaseMs: current.leaseMs }
      );
      if (!renewed) {
        stopLocalProviderDispatchLease(attemptId, current.ownerToken);
        return;
      }
    } catch {
      // A transient SQLite lock/error gets another bounded attempt. If the database remains
      // unavailable past the durable expiry, reconciliation correctly treats ownership as lost.
    }
    scheduleProviderDispatchHeartbeat(attemptId);
  }, delayMs);
  timer.unref?.();
  active.timer = timer;
}

/**
 * Atomically reserve request units and estimated cost for one credential lane. Every active or
 * completed dispatch remains chargeable inside its windows; only a never-dispatched cancellation
 * is released. `BEGIN IMMEDIATE` serializes competing app processes sharing this SQLite authority.
 */
export function reserveProviderDispatch(input: ReserveProviderDispatchInput): ProviderDispatchReservation {
  const database = getDb();
  const provider = input.provider.trim().toLowerCase();
  const operation = input.operation.trim();
  const credentialRef = input.credentialRef.trim();
  if (!provider || !operation || !credentialRef) throw new Error("Provider dispatch identity is incomplete.");
  const authorityId = providerAuthorityId(input.authorityId);
  const units = positiveInt(input.units, 1);
  const estimatedCostUsd = nonNegative(input.estimatedCostUsd);
  const idempotencyKey = input.idempotencyKey?.trim() || undefined;
  const now = validIso(input.now);
  const nowMs = Date.parse(now);
  const attemptId = crypto.randomUUID();

  const reserve = database.transaction((): ProviderDispatchReservation => {
    const dispatchUserId = input.userId?.trim() || "local";
    const preparedDeletion = database.prepare(`
      SELECT id FROM account_deletion_requests
      WHERE user_id = ? AND status = 'prepared'
      ORDER BY requested_at DESC, rowid DESC LIMIT 1
    `).get(dispatchUserId) as { id: string } | undefined;
    const requestedDeletionBypass = input.accountDeletionRequestId?.trim();
    const validDeletionBypass = Boolean(
      requestedDeletionBypass &&
      preparedDeletion?.id === requestedDeletionBypass &&
      provider === "pinecone" &&
      ACCOUNT_DELETION_PINECONE_OPERATIONS.has(operation)
    );
    if ((preparedDeletion && !validDeletionBypass) || (requestedDeletionBypass && !validDeletionBypass)) {
      // Fence before idempotency replay: a pre-deletion key must not resurrect provider work after
      // the durable erasure request has been prepared. A stale/nonexistent request id and any
      // provider/operation outside the exact erasure capability are denied as well.
      return { admitted: false, reason: "account_deletion" };
    }
    if (idempotencyKey) {
      const prior = database.prepare(`
        SELECT id FROM provider_dispatch_attempts
        WHERE authority_id = ? AND idempotency_key = ?
      `).get(authorityId, idempotencyKey) as { id: string } | undefined;
      if (prior) return { admitted: true, attemptId: prior.id, authorityId };
    }
    for (const window of input.windows ?? []) {
      if (!Number.isFinite(window.windowMs) || window.windowMs <= 0 || !Number.isFinite(window.maxUnits) || window.maxUnits < 0) {
        continue;
      }
      const since = new Date(nowMs - window.windowMs).toISOString();
      const row = database.prepare(`
        SELECT COALESCE(SUM(units), 0) AS used
        FROM provider_dispatch_attempts
        WHERE authority_id = ? AND provider = ? AND credential_ref = ?
          AND status <> 'cancelled' AND created_at > ?
      `).get(authorityId, provider, credentialRef, since) as { used: number };
      if (row.used + units > window.maxUnits) return { admitted: false, reason: "request_window" };
    }

    const costCap = input.maxEstimatedCostUsdPer24h;
    if (typeof costCap === "number" && Number.isFinite(costCap) && costCap >= 0) {
      const since = new Date(nowMs - 86_400_000).toISOString();
      const row = database.prepare(`
        SELECT COALESCE(SUM(
          CASE WHEN actual_cost_usd IS NULL THEN estimated_cost_usd
               ELSE MAX(actual_cost_usd, estimated_cost_usd) END
        ), 0) AS used
        FROM provider_dispatch_attempts
        WHERE authority_id = ? AND provider = ? AND credential_ref = ?
          AND status <> 'cancelled' AND created_at > ?
      `).get(authorityId, provider, credentialRef, since) as { used: number };
      if (row.used + estimatedCostUsd > costCap) return { admitted: false, reason: "cost_cap" };
    }

    database.prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
    `).run(
      attemptId,
      authorityId,
      provider,
      operation,
      credentialRef,
      dispatchUserId,
      units,
      estimatedCostUsd,
      idempotencyKey ?? null,
      now,
      now
    );
    return { admitted: true, attemptId, authorityId };
  });
  return reserve.immediate() as ProviderDispatchReservation;
}

/**
 * Persist the last certain pre-network state and start a process-local lease renewer. A distinct
 * process cannot adopt an already-dispatched attempt: it must wait for the prior owner's durable
 * lease to expire and reconciliation to record the accounting outcome as unknown.
 */
export function markProviderDispatchStarted(
  attemptId: string,
  at: string = new Date().toISOString(),
  options: ProviderDispatchStartOptions = {}
): ProviderDispatchLease {
  const timestamp = validIso(at);
  const leaseMs = providerDispatchLeaseMs(options.leaseMs);
  const expiresAt = leaseExpiry(timestamp, leaseMs);
  const candidateOwnerToken = crypto.randomUUID();
  const database = getDb();
  const lease = database.transaction((): ProviderDispatchLease => {
    const updated = database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'dispatched', dispatched_at = COALESCE(dispatched_at, ?),
          dispatch_owner_token = ?, dispatch_heartbeat_at = ?, dispatch_lease_expires_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(
      timestamp,
      candidateOwnerToken,
      timestamp,
      expiresAt,
      timestamp,
      attemptId
    );
    const row = database.prepare(`
      SELECT status, dispatched_at, dispatch_owner_token, dispatch_lease_expires_at
      FROM provider_dispatch_attempts WHERE id = ?
    `).get(attemptId) as {
      status: string;
      dispatched_at: string | null;
      dispatch_owner_token: string | null;
      dispatch_lease_expires_at: string | null;
    } | undefined;
    if (
      updated.changes !== 1 ||
      row?.status !== "dispatched" ||
      !row.dispatched_at ||
      row.dispatch_owner_token !== candidateOwnerToken ||
      !row.dispatch_lease_expires_at
    ) {
      throw new Error("Provider dispatch boundary was not durably recorded.");
    }
    return {
      attemptId,
      ownerToken: candidateOwnerToken,
      leaseExpiresAt: row.dispatch_lease_expires_at
    };
    // IMMEDIATE is currently equivalent (the first statement is already a write, so the writer
    // lock is taken at that point either way) but states the invariant explicitly: every
    // transaction in this ledger must hold the write lock from BEGIN, so no future statement
    // reorder can reintroduce the deferred read-then-write SQLITE_BUSY_SNAPSHOT failure.
  }).immediate();
  stopLocalProviderDispatchLease(attemptId);
  localProviderDispatchLeases.set(attemptId, {
    ownerToken: lease.ownerToken,
    leaseMs
  });
  if (options.supervise !== false && Date.parse(lease.leaseExpiresAt) > Date.now()) {
    scheduleProviderDispatchHeartbeat(attemptId);
  }
  return lease;
}

/**
 * Extend a live dispatch only while the exact owner token still holds an unexpired lease. A late
 * heartbeat cannot resurrect ownership after expiry, even before reconciliation observes it.
 */
export function heartbeatProviderDispatch(
  attemptId: string,
  ownerToken: string,
  options: { at?: string; leaseMs?: number } = {}
): boolean {
  const timestamp = validIso(options.at);
  const expiresAt = leaseExpiry(timestamp, providerDispatchLeaseMs(options.leaseMs));
  const result = getDb().prepare(`
    UPDATE provider_dispatch_attempts
    SET dispatch_heartbeat_at = ?, dispatch_lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'dispatched' AND dispatch_owner_token = ?
      AND dispatch_lease_expires_at > ?
  `).run(timestamp, expiresAt, timestamp, attemptId, ownerToken, timestamp);
  return result.changes === 1;
}

/** Cancel only a reservation proven not to have crossed the network boundary. */
export function cancelUndispatchedProviderReservation(
  attemptId: string,
  outcomeCode = "not_dispatched",
  at: string = new Date().toISOString()
): boolean {
  const timestamp = validIso(at);
  const result = getDb().prepare(`
    UPDATE provider_dispatch_attempts
    SET status = 'cancelled', outcome_code = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'reserved' AND dispatched_at IS NULL
  `).run(outcomeCode, timestamp, timestamp, attemptId);
  return result.changes > 0;
}

function insertUsageOutbox(
  database: Database.Database,
  attemptId: string,
  outcome: ProviderDispatchOutcome,
  at: string
): void {
  database.prepare(`
    INSERT OR IGNORE INTO provider_usage_outbox (
      id, attempt_id, provider, operation, credential_ref, user_id, outcome,
      requests, estimated_cost_usd, actual_cost_usd, occurred_at, created_at
    )
    SELECT ?, id, provider, operation, credential_ref, user_id, ?, units,
      estimated_cost_usd, actual_cost_usd, COALESCE(dispatched_at, ?), ?
    FROM provider_dispatch_attempts
    WHERE id = ? AND dispatched_at IS NOT NULL
  `).run(`provider-attempt:${attemptId}`, outcome, at, at, attemptId);
}

/**
 * Settle independently of the caller's business lease. A dispatched outcome always creates one
 * idempotent usage-outbox row; Usage Monitor replay can deliver it after any later crash.
 *
 * BEGIN IMMEDIATE is load-bearing, not decoration (prod bug, 2026-08-09). This body READS
 * (`SELECT status, outcome_code, dispatch_owner_token`) before it WRITES. Under a plain deferred
 * `BEGIN`, the SELECT takes a WAL read snapshot; if any other connection commits before the
 * UPDATE, promoting that snapshot to a write returns **SQLITE_BUSY_SNAPSHOT immediately and does
 * NOT consult `busy_timeout`** — SQLite skips the busy handler because waiting can never make a
 * stale snapshot current. better-sqlite3 surfaces it as the bare message "database is locked".
 * That is exactly how a healthy Pinecone call ended up alerting "Pinecone connection failed /
 * inventory fetch: database is locked" every hour despite `busy_timeout = 60000` in db.ts.
 * Taking the write lock at BEGIN removes the stale-snapshot window entirely and puts contention
 * back under the busy handler (wait, then proceed). Repro + receipts:
 * docs/rollouts/2026-08-09-pinecone-lock-mislabel.md.
 */
export function settleProviderDispatch(
  attemptId: string,
  outcome: ProviderDispatchOutcome,
  options: { outcomeCode?: string; actualCostUsd?: number; at?: string; ownerToken?: string } = {}
): void {
  const timestamp = validIso(options.at);
  const database = getDb();
  try {
    database.transaction(() => {
      const before = database.prepare(`
        SELECT status, outcome_code, dispatch_owner_token
        FROM provider_dispatch_attempts
        WHERE id = ? AND dispatched_at IS NOT NULL
      `).get(attemptId) as {
        status: string;
        outcome_code: string | null;
        dispatch_owner_token: string | null;
      } | undefined;
      if (!before) throw new Error("Provider dispatch outcome has no durable dispatch boundary.");
      if (before.status !== "dispatched") {
        if (before.status === "unknown" && before.outcome_code?.startsWith("stale-owner-")) {
          throw new ProviderDispatchLeaseLostError(attemptId);
        }
        // A duplicate/late callback cannot rewrite an already-known terminal outcome.
        return;
      }
      const ownerToken = options.ownerToken ?? localProviderDispatchLeases.get(attemptId)?.ownerToken;
      if (!ownerToken || before.dispatch_owner_token !== ownerToken) {
        throw new ProviderDispatchLeaseLostError(attemptId);
      }
      const updated = database.prepare(`
        UPDATE provider_dispatch_attempts
        SET status = ?, outcome_code = ?, actual_cost_usd = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND dispatched_at IS NOT NULL
          AND status = 'dispatched' AND dispatch_owner_token = ?
      `).run(
        outcome,
        options.outcomeCode?.slice(0, 120) ?? null,
        typeof options.actualCostUsd === "number" && Number.isFinite(options.actualCostUsd)
          ? Math.max(0, options.actualCostUsd)
          : null,
        timestamp,
        timestamp,
        attemptId,
        ownerToken
      );
      if (updated.changes !== 1) throw new ProviderDispatchLeaseLostError(attemptId);
      insertUsageOutbox(database, attemptId, outcome, timestamp);
    }).immediate();
  } catch (error) {
    if (error instanceof ProviderDispatchLeaseLostError) {
      const row = database.prepare("SELECT status FROM provider_dispatch_attempts WHERE id = ?")
        .get(attemptId) as { status: string } | undefined;
      if (row?.status !== "dispatched") stopLocalProviderDispatchLease(attemptId);
    }
    throw error;
  }
  stopLocalProviderDispatchLease(attemptId);
}

/**
 * Release never-dispatched stale reservations and close only dispatched attempts whose durable
 * owner lease has expired. Active slow calls renew that lease independently of their response.
 * Unknown remains chargeable and emits an immutable usage record; it is never guessed successful
 * or failed. `stale-owner-unresolved` deliberately remains an account-deletion blocker until an
 * operator attests that the prior process/deploy is gone and explicitly resolves it below.
 */
export function reconcileStaleProviderDispatches(
  now: string = new Date().toISOString(),
  staleAfterMs = 5 * 60_000,
  userId?: string
): { released: number; unknown: number } {
  const timestamp = validIso(now);
  const cutoff = new Date(Date.parse(timestamp) - Math.max(0, staleAfterMs)).toISOString();
  const database = getDb();
  return database.transaction(() => {
    const released = database.prepare(`
      UPDATE provider_dispatch_attempts
      SET status = 'cancelled', outcome_code = 'stale-undispatched-reservation',
          completed_at = ?, updated_at = ?
      WHERE status = 'reserved' AND dispatched_at IS NULL AND updated_at <= ?
        ${userId ? "AND user_id = ?" : ""}
    `).run(timestamp, timestamp, cutoff, ...(userId ? [userId] : [])).changes;
    const expired = database.prepare(`
      SELECT id FROM provider_dispatch_attempts
      WHERE status = 'dispatched' AND dispatched_at IS NOT NULL
        AND dispatch_lease_expires_at IS NOT NULL
        AND dispatch_lease_expires_at <= ?
        ${userId ? "AND user_id = ?" : ""}
      ORDER BY id
    `).all(timestamp, ...(userId ? [userId] : [])) as Array<{ id: string }>;
    let unknown = 0;
    for (const row of expired) {
      const updated = database.prepare(`
        UPDATE provider_dispatch_attempts
        SET status = 'unknown', outcome_code = 'stale-owner-unresolved',
            completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'dispatched'
          AND dispatch_lease_expires_at IS NOT NULL
          AND dispatch_lease_expires_at <= ?
      `).run(timestamp, timestamp, row.id, timestamp);
      if (updated.changes !== 1) continue;
      insertUsageOutbox(database, row.id, "unknown", timestamp);
      stopLocalProviderDispatchLease(row.id);
      unknown += 1;
    }
    return { released, unknown };
    // IMMEDIATE for the same invariant as the rest of this ledger (see markProviderDispatchStarted).
  }).immediate();
}

export interface ResolveStaleProviderDispatchInput {
  attemptId: string;
  attestedBy: string;
  reason: string;
  at?: string;
}

/**
 * Explicitly clear a stale-owner deletion blocker after an operator has verified the owning
 * process/deploy is dead. This never changes the fail-closed billing outcome (`unknown`); it only
 * records a durable, audited attestation that a late provider mutation can no longer resume.
 *
 * BEGIN IMMEDIATE for the same reason as settleProviderDispatch: this body reads before it writes,
 * and a deferred read-then-write transaction fails with SQLITE_BUSY_SNAPSHOT ("database is locked")
 * without ever consulting `busy_timeout`.
 */
export function resolveStaleProviderDispatch(input: ResolveStaleProviderDispatchInput): boolean {
  const attemptId = input.attemptId.trim();
  const attestedBy = input.attestedBy.trim();
  const reason = input.reason.trim();
  if (!attemptId || !attestedBy || !reason) {
    throw new Error("Stale provider dispatch resolution requires attempt id, attestedBy, and reason.");
  }
  if (attemptId.length > 200 || attestedBy.length > 320 || reason.length > 2_000) {
    throw new Error("Stale provider dispatch resolution fields exceed their allowed length.");
  }
  const timestamp = validIso(input.at);
  const database = getDb();
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT id, user_id, provider, operation, dispatch_owner_token,
             dispatch_heartbeat_at, dispatch_lease_expires_at
      FROM provider_dispatch_attempts
      WHERE id = ? AND status = 'unknown' AND outcome_code = 'stale-owner-unresolved'
    `).get(attemptId) as {
      id: string;
      user_id: string;
      provider: string;
      operation: string;
      dispatch_owner_token: string | null;
      dispatch_heartbeat_at: string | null;
      dispatch_lease_expires_at: string | null;
    } | undefined;
    if (!row) return false;
    if (!row.dispatch_lease_expires_at || row.dispatch_lease_expires_at > timestamp) {
      throw new Error("Stale provider dispatch owner lease has not expired.");
    }
    const updated = database.prepare(`
      UPDATE provider_dispatch_attempts
      SET outcome_code = 'stale-owner-resolved', updated_at = ?
      WHERE id = ? AND status = 'unknown' AND outcome_code = 'stale-owner-unresolved'
        AND dispatch_lease_expires_at <= ?
    `).run(timestamp, attemptId, timestamp);
    if (updated.changes !== 1) return false;
    const ownerFingerprint = row.dispatch_owner_token
      ? crypto.createHash("sha256").update(row.dispatch_owner_token, "utf8").digest("hex").slice(0, 16)
      : null;
    database.prepare(`
      INSERT INTO audit_events (
        id, user_id, connected_account_id, created_at, kind, payload
      ) VALUES (?, ?, NULL, ?, 'provider_dispatch_stale_owner_resolved', ?)
    `).run(
      crypto.randomUUID(),
      row.user_id,
      timestamp,
      JSON.stringify({
        attemptId,
        provider: row.provider,
        operation: row.operation,
        attestedBy,
        reason,
        ownerFingerprint,
        lastHeartbeatAt: row.dispatch_heartbeat_at,
        leaseExpiredAt: row.dispatch_lease_expires_at
      })
    );
    return true;
  }).immediate();
}

export interface ProviderUsageOutboxRow {
  id: string;
  attempt_id: string;
  provider: string;
  operation: string;
  credential_ref: string;
  user_id: string;
  outcome: ProviderDispatchOutcome;
  requests: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  occurred_at: string;
  created_at: string;
}

export function listProviderUsageOutboxRows(input: {
  after?: { createdAt: string; id: string } | null;
  inclusive?: boolean;
  limit: number;
}): ProviderUsageOutboxRow[] {
  const columns = "id, attempt_id, provider, operation, credential_ref, user_id, outcome, requests, estimated_cost_usd, actual_cost_usd, occurred_at, created_at";
  if (!input.after) {
    return getDb().prepare(`SELECT ${columns} FROM provider_usage_outbox ORDER BY created_at, id LIMIT ?`)
      .all(input.limit) as ProviderUsageOutboxRow[];
  }
  const comparator = input.inclusive ? ">=" : ">";
  return getDb().prepare(`
    SELECT ${columns} FROM provider_usage_outbox
    WHERE created_at > ? OR (created_at = ? AND id ${comparator} ?)
    ORDER BY created_at, id LIMIT ?
  `).all(input.after.createdAt, input.after.createdAt, input.after.id, input.limit) as ProviderUsageOutboxRow[];
}
