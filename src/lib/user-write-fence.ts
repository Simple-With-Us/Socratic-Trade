import crypto from "crypto";
import { accountSubjectToken, getDb } from "./db";

const EPOCH_PREFIX = "account_write_epoch:";
const OPERATION_PREFIX = "account_user_operation:";
const DEFAULT_OPERATION_TTL_MS = 5 * 60_000;
const OPERATION_HEARTBEAT_MS = 30_000;

type EpochStatus = "none" | "prepared" | "completed";

interface StoredEpoch {
  generation: string;
  status: EpochStatus;
  updatedAt: string;
}

export interface UserWriteEpoch {
  generation: string;
  status: "none" | "completed";
}

export interface UserOperationClaim {
  userId: string;
  key: string;
  claimId: string;
  kind: string;
  epoch: UserWriteEpoch;
}

interface StoredOperationClaim {
  claimId: string;
  kind: string;
  epoch: UserWriteEpoch;
  expiresAt: string;
  updatedAt: string;
}

function subjectToken(userId: string): string {
  return accountSubjectToken(userId);
}

function epochKey(userId: string): string {
  return `${EPOCH_PREFIX}${subjectToken(userId)}`;
}

function operationKeyPrefix(userId: string): string {
  return `${OPERATION_PREFIX}${subjectToken(userId)}:`;
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function readStoredEpoch(database: ReturnType<typeof getDb>, userId: string): StoredEpoch {
  const fence = database.prepare(`
    SELECT generation, status, updated_at
    FROM account_write_fences
    WHERE subject_token = ?
  `).get(subjectToken(userId)) as {
    generation: string;
    status: "prepared" | "completed";
    updated_at: string;
  } | undefined;
  if (fence) {
    return { generation: fence.generation, status: fence.status, updatedAt: fence.updated_at };
  }
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(epochKey(userId)) as
    | { value: string }
    | undefined;
  const parsed = parseJson<StoredEpoch>(row?.value);
  if (
    parsed &&
    typeof parsed.generation === "string" &&
    (parsed.status === "prepared" || parsed.status === "completed")
  ) return parsed;
  return { generation: "none", status: "none", updatedAt: "1970-01-01T00:00:00.000Z" };
}

function publicEpoch(stored: StoredEpoch): UserWriteEpoch {
  if (stored.status !== "none") {
    const phase = stored.status === "prepared" ? "prepared" : "completed";
    throw Object.assign(new Error(`Account deletion is ${phase}; user writes are fenced.`), { status: 409 });
  }
  return { generation: stored.generation, status: "none" };
}

function sameEpoch(left: UserWriteEpoch, right: StoredEpoch): boolean {
  return right.status === "none" && left.generation === right.generation && left.status === "none";
}

export function captureUserWriteEpoch(userId: string): UserWriteEpoch {
  return publicEpoch(readStoredEpoch(getDb(), userId));
}

/** Execute synchronous user-scoped writes in the same IMMEDIATE transaction as the epoch check. */
export function runWithUserWriteEpoch<T>(userId: string, epoch: UserWriteEpoch, work: () => T): T {
  const database = getDb();
  const transaction = database.transaction(() => {
    const current = readStoredEpoch(database, userId);
    if (!sameEpoch(epoch, current)) {
      throw Object.assign(new Error("User write epoch changed during account deletion."), { status: 409 });
    }
    const result = work();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("runWithUserWriteEpoch requires synchronous work.");
    }
    return result;
  });
  return transaction.immediate() as T;
}

/** Called only from the account-deletion transaction that creates the matching prepared request. */
export function markUserDeletionPrepared(
  database: ReturnType<typeof getDb>,
  userId: string,
  generation: string,
  now: string
): void {
  const existing = readStoredEpoch(database, userId);
  if (existing.status === "completed") {
    throw Object.assign(new Error("This deleted account generation is permanently fenced."), { status: 409 });
  }
  database.prepare(`
    INSERT INTO account_write_fences (subject_token, generation, status, updated_at)
    VALUES (?, ?, 'prepared', ?)
    ON CONFLICT(subject_token) DO UPDATE SET
      generation = excluded.generation,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(subjectToken(userId), generation, now);
  database.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(epochKey(userId), JSON.stringify({ generation, status: "prepared", updatedAt: now }), now);
}

/** Durable, non-PII tombstone. Old operations keep their prior epoch and cannot resurrect data. */
export function markUserDeletionCompleted(
  database: ReturnType<typeof getDb>,
  userId: string,
  generation: string,
  now: string
): void {
  const current = readStoredEpoch(database, userId);
  if (current.generation !== generation || current.status !== "prepared") {
    throw new Error("Account deletion write epoch ownership was lost.");
  }
  const fenceUpdate = database.prepare(`
    UPDATE account_write_fences
    SET status = 'completed', updated_at = ?
    WHERE subject_token = ? AND generation = ? AND status = 'prepared'
  `).run(now, subjectToken(userId), generation);
  if (fenceUpdate.changes !== 1) throw new Error("Account deletion database fence ownership was lost.");
  database.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
    .run(JSON.stringify({ generation, status: "completed", updatedAt: now }), now, epochKey(userId));
}

/**
 * Record which opaque account generation was deleted. The completed per-generation write fence is
 * never removed; a later verified login maps to a distinct user id instead.
 */
export function markAccountIdentityDeleted(
  database: ReturnType<typeof getDb>,
  baseUserId: string,
  deletedUserId: string,
  cutoffAt: string
): void {
  const token = subjectToken(baseUserId);
  const row = database.prepare(`
    SELECT current_user_id, generation, status
    FROM account_identity_generations
    WHERE base_subject_token = ?
  `).get(token) as {
    current_user_id: string;
    generation: number;
    status: "active" | "deleted";
  } | undefined;
  if (!row) {
    if (deletedUserId !== baseUserId) throw new Error("Account identity generation is missing.");
    database.prepare(`
      INSERT INTO account_identity_generations (
        base_subject_token, current_user_id, generation, status, session_cutoff_at, updated_at
      ) VALUES (?, ?, 0, 'deleted', ?, ?)
    `).run(token, deletedUserId, cutoffAt, cutoffAt);
    return;
  }
  if (row.current_user_id !== deletedUserId || row.status !== "active") {
    throw new Error("Account identity generation ownership was lost.");
  }
  const updated = database.prepare(`
    UPDATE account_identity_generations
    SET status = 'deleted', session_cutoff_at = ?, updated_at = ?
    WHERE base_subject_token = ? AND current_user_id = ? AND generation = ? AND status = 'active'
  `).run(cutoffAt, cutoffAt, token, deletedUserId, row.generation);
  if (updated.changes !== 1) throw new Error("Account identity generation changed during deletion.");
}

function recreatedUserId(baseUserId: string, generation: number): string {
  return `u_${crypto.createHash("sha256")
    .update(`account-generation:v1|${baseUserId}|${generation}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

/** Fail closed before any destructive/provider work if the request identity is not current. */
export function assertCurrentAccountIdentity(baseUserId: string, currentUserId: string): void {
  const row = getDb().prepare(`
    SELECT current_user_id, status
    FROM account_identity_generations
    WHERE base_subject_token = ?
  `).get(subjectToken(baseUserId)) as {
    current_user_id: string;
    status: "active" | "deleted";
  } | undefined;
  const matches = row
    ? row.status === "active" && row.current_user_id === currentUserId
    : currentUserId === baseUserId;
  if (!matches) throw Object.assign(new Error("Authenticated account generation is stale."), { status: 409 });
}

/**
 * Resolve a verified provider login to the current opaque account generation. Sessions at or
 * before the last deletion cutoff map to the permanently fenced base id, never to the new account.
 */
export function resolveAuthenticatedAccountGeneration(baseUserId: string, loginAt: string): string {
  const loginAtMs = Date.parse(loginAt);
  const database = getDb();
  return database.transaction(() => {
    const token = subjectToken(baseUserId);
    const row = database.prepare(`
      SELECT current_user_id, generation, status, session_cutoff_at
      FROM account_identity_generations
      WHERE base_subject_token = ?
    `).get(token) as {
      current_user_id: string;
      generation: number;
      status: "active" | "deleted";
      session_cutoff_at: string;
    } | undefined;
    if (!row) return baseUserId;
    if (!Number.isFinite(loginAtMs)) {
      throw Object.assign(new Error("A fresh provider sign-in is required after account deletion."), { status: 401 });
    }
    const cutoffMs = Date.parse(row.session_cutoff_at);
    if (!Number.isFinite(cutoffMs) || loginAtMs <= cutoffMs) {
      throw Object.assign(new Error("This session predates account deletion; sign in again."), { status: 401 });
    }
    if (row.status === "active") return row.current_user_id;
    const nextGeneration = row.generation + 1;
    const nextUserId = recreatedUserId(baseUserId, nextGeneration);
    const updatedAt = new Date(loginAtMs).toISOString();
    const updated = database.prepare(`
      UPDATE account_identity_generations
      SET current_user_id = ?, generation = ?, status = 'active', updated_at = ?
      WHERE base_subject_token = ? AND generation = ? AND status = 'deleted'
    `).run(nextUserId, nextGeneration, updatedAt, token, row.generation);
    if (updated.changes !== 1) throw new Error("Account identity generation changed during sign-in.");
    return nextUserId;
  }).immediate() as string;
}

function sweepExpiredClaims(database: ReturnType<typeof getDb>, userId: string, now: string): void {
  const prefix = operationKeyPrefix(userId);
  const rows = database.prepare("SELECT key, value FROM settings WHERE key LIKE ?")
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
  for (const row of rows) {
    const claim = parseJson<StoredOperationClaim>(row.value);
    if (!claim || !Number.isFinite(Date.parse(claim.expiresAt)) || claim.expiresAt <= now) {
      database.prepare("DELETE FROM settings WHERE key = ?").run(row.key);
    }
  }
}

export function acquireUserOperationClaim(
  userId: string,
  kind: string,
  ttlMs = DEFAULT_OPERATION_TTL_MS
): UserOperationClaim {
  const database = getDb();
  const now = new Date().toISOString();
  const claimId = crypto.randomUUID();
  const key = `${operationKeyPrefix(userId)}${claimId}`;
  return database.transaction(() => {
    const epoch = publicEpoch(readStoredEpoch(database, userId));
    sweepExpiredClaims(database, userId, now);
    const stored: StoredOperationClaim = {
      claimId,
      kind: kind.slice(0, 120),
      epoch,
      expiresAt: new Date(Date.parse(now) + Math.max(30_000, ttlMs)).toISOString(),
      updatedAt: now
    };
    database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(stored), now);
    return { userId, key, claimId, kind: stored.kind, epoch };
  }).immediate() as UserOperationClaim;
}

function readClaim(database: ReturnType<typeof getDb>, claim: UserOperationClaim): StoredOperationClaim | undefined {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(claim.key) as
    | { value: string }
    | undefined;
  const stored = parseJson<StoredOperationClaim>(row?.value);
  return stored?.claimId === claim.claimId ? stored : undefined;
}

export function assertUserOperationClaim(claim: UserOperationClaim): void {
  const database = getDb();
  const stored = readClaim(database, claim);
  const currentEpoch = readStoredEpoch(database, claim.userId);
  if (!stored || stored.expiresAt <= new Date().toISOString() || !sameEpoch(claim.epoch, currentEpoch)) {
    throw Object.assign(new Error("User operation claim was lost during account deletion."), { status: 409 });
  }
}

export function heartbeatUserOperationClaim(
  claim: UserOperationClaim,
  ttlMs = DEFAULT_OPERATION_TTL_MS
): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.transaction(() => {
    const stored = readClaim(database, claim);
    if (!stored || !sameEpoch(claim.epoch, readStoredEpoch(database, claim.userId))) {
      throw Object.assign(new Error("User operation claim was lost during account deletion."), { status: 409 });
    }
    const next = { ...stored, expiresAt: new Date(Date.parse(now) + Math.max(30_000, ttlMs)).toISOString(), updatedAt: now };
    database.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?")
      .run(JSON.stringify(next), now, claim.key);
  }).immediate();
}

export function releaseUserOperationClaim(claim: UserOperationClaim): void {
  const database = getDb();
  database.transaction(() => {
    if (readClaim(database, claim)) database.prepare("DELETE FROM settings WHERE key = ?").run(claim.key);
  }).immediate();
}

export function countActiveUserOperations(userId: string): number {
  const database = getDb();
  const now = new Date().toISOString();
  return database.transaction(() => {
    sweepExpiredClaims(database, userId, now);
    return (database.prepare("SELECT COUNT(*) AS count FROM settings WHERE key LIKE ?")
      .get(`${operationKeyPrefix(userId)}%`) as { count: number }).count;
  }).immediate() as number;
}

export async function withUserWriteOperation<T>(
  userId: string,
  kind: string,
  work: (claim: UserOperationClaim) => Promise<T>
): Promise<T> {
  const claim = acquireUserOperationClaim(userId, kind);
  let heartbeatError: unknown;
  const timer = setInterval(() => {
    try {
      heartbeatUserOperationClaim(claim);
    } catch (error) {
      heartbeatError = error;
    }
  }, OPERATION_HEARTBEAT_MS);
  timer.unref?.();
  try {
    const result = await work(claim);
    if (heartbeatError) throw heartbeatError;
    assertUserOperationClaim(claim);
    return result;
  } finally {
    clearInterval(timer);
    releaseUserOperationClaim(claim);
  }
}
