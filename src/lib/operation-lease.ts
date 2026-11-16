// operation-lease.ts - durable, owner-token single-flight for expensive provider/dataset work.
//
// Leases live in the existing settings KV table, so they coordinate every process sharing the
// SQLite database and survive a process restart until their TTL expires. Acquisition uses
// BEGIN IMMEDIATE: SQLite takes the writer reservation before the read/compare/write sequence,
// removing the cross-process read-then-write race that an in-memory guard cannot cover.

import { getDb } from "./db";

/** Distinguishes an ownership-loss/lease-lost condition from an arbitrary Error so money-path
 *  callers can short-circuit it (never contact the broker, never audit order_placement_uncertain)
 *  instead of laundering it through generic placement-error recovery (see account-mutation.ts
 *  §7 slice 3 PR-2's mutationCtx.assertOwned() fence). Every throw site that signals ownership
 *  loss — assertOperationLeaseOwnership, validateInheritedClaim, the heartbeat's markClaimLost,
 *  and throwIfOperationLeaseCancelled's fallback — constructs this type. */
export class OperationLeaseOwnershipError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OperationLeaseOwnershipError";
  }
}

export const OPERATION_LEASE_GROUPS = {
  RAG_REINDEX: "rag-reindex",
  CONGRESS_SHARE: "congress-share",
  CONGRESS_WEB_SOURCE: "web-source:congress",
  SEC8K_WEB_SOURCE: "web-source:sec8k",
  SEC_INGEST_SEED: "sec-ingest-seed"
} as const;

/** Dynamic per-account broker-mutation groups (account-mutation.ts, oss-lessons §7 slice 3).
 *  Template-typed rather than enumerated: one group per (userId, account key). All lease
 *  mechanics below treat the group as an opaque key, so the widening changes no behavior;
 *  the test sweep (`LIKE 'operation_lease:%'`) already covers these keys. */
export type BrokerMutationLeaseGroup = `broker-mutation:${string}`;

export type OperationLeaseGroup =
  | typeof OPERATION_LEASE_GROUPS[keyof typeof OPERATION_LEASE_GROUPS]
  | BrokerMutationLeaseGroup;

export interface OperationLeaseBusy {
  status: "busy";
  group: OperationLeaseGroup;
  operation: string;
  activeOperation: string;
  retryAfterSeconds: number;
}

export type OperationLeaseAware<T> = T & { operationLease?: OperationLeaseBusy };

export function getOperationLeaseBusy(value: unknown): OperationLeaseBusy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const busy = (value as { operationLease?: unknown }).operationLease;
  if (!busy || typeof busy !== "object") return undefined;
  return (busy as { status?: unknown }).status === "busy" ? busy as OperationLeaseBusy : undefined;
}

interface OperationLeaseRecord {
  owner: string;
  operation: string;
  acquiredAt: string;
  expiresAt: string;
}

const claimBrand: unique symbol = Symbol("operation-lease-claim");

/** Opaque capability passed only from an outer guard to the matching core boundary. */
export type OperationLeaseClaim = { readonly [claimBrand]: true };

interface ClaimState {
  group: OperationLeaseGroup;
  owner: string;
  active: boolean;
  controller: AbortController;
}

const claimStates = new WeakMap<object, ClaimState>();

export interface OperationLeaseRunOptions {
  group: OperationLeaseGroup;
  operation: string;
  /** Reuse a claim already acquired by an outer admission guard; the inner call never releases it. */
  claim?: OperationLeaseClaim;
  /** Test-only override. Production callers use the fixed five-minute crash-recovery TTL. */
  ttlMs?: number;
  /** Test/exception override. Production defaults to one third of the TTL. */
  heartbeatMs?: number;
}

export type OperationLeaseRunResult<T> =
  | { acquired: true; value: T; tookOverExpired?: OperationLeaseTakeover }
  | { acquired: false; busy: OperationLeaseBusy };

const leaseKey = (group: OperationLeaseGroup): string => `operation_lease:${group}`;

function positiveMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function leaseTtlMs(override?: number): number {
  return positiveMs(override, 5 * 60_000);
}

function heartbeatMs(ttlMs: number, override?: number): number {
  return positiveMs(override, Math.max(250, Math.floor(ttlMs / 3)));
}

function parseLease(raw: string): OperationLeaseRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<OperationLeaseRecord>;
    if (
      typeof value.owner !== "string" || !value.owner ||
      typeof value.operation !== "string" || !value.operation ||
      typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    ) return null;
    return value as OperationLeaseRecord;
  } catch {
    return null;
  }
}

function readLease(group: OperationLeaseGroup): OperationLeaseRecord | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(leaseKey(group)) as { value: string } | undefined;
  return row ? parseLease(row.value) : null;
}

function upsertLease(group: OperationLeaseGroup, record: OperationLeaseRecord, nowIso: string): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(leaseKey(group), JSON.stringify(record), nowIso);
}

function busyResult(
  group: OperationLeaseGroup,
  operation: string,
  active: OperationLeaseRecord | null,
  now: Date,
  ttlMs: number
): OperationLeaseBusy {
  const remainingMs = active ? Math.max(1_000, Date.parse(active.expiresAt) - now.getTime()) : ttlMs;
  return {
    status: "busy",
    group,
    operation,
    activeOperation: active?.operation ?? "lease-unavailable",
    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000))
  };
}

/** Present on a fresh acquisition that displaced an EXPIRED record — crash/stall evidence
 *  the caller can receipt (e.g. broker_mutation_takeover_expired). */
export interface OperationLeaseTakeover {
  operation: string;
  expiresAt: string;
}

function acquireOperationLease(
  group: OperationLeaseGroup,
  operation: string,
  ttlMs: number,
  now: Date = new Date()
): { claim: OperationLeaseClaim; tookOverExpired?: OperationLeaseTakeover } | { busy: OperationLeaseBusy } {
  const owner = `${process.pid}:${globalThis.crypto.randomUUID()}`;
  const nowIso = now.toISOString();
  let active: OperationLeaseRecord | null = null;
  let tookOverExpired: OperationLeaseTakeover | undefined;
  try {
    const database = getDb();
    const acquire = database.transaction((): boolean => {
      active = readLease(group);
      if (active && Date.parse(active.expiresAt) > now.getTime()) return false;
      if (active) tookOverExpired = { operation: active.operation, expiresAt: active.expiresAt };
      upsertLease(group, {
        owner,
        operation,
        acquiredAt: nowIso,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      }, nowIso);
      return true;
    });
    if (!acquire.immediate()) return { busy: busyResult(group, operation, active, now, ttlMs) };
  } catch {
    // Fail closed: a caller that cannot prove exclusive ownership must not start provider work.
    return { busy: busyResult(group, operation, active, now, ttlMs) };
  }

  const claim = Object.freeze({ [claimBrand]: true }) as OperationLeaseClaim;
  claimStates.set(claim, { group, owner, active: true, controller: new AbortController() });
  return { claim, tookOverExpired };
}

function renewOperationLease(claim: OperationLeaseClaim, ttlMs: number, now: Date = new Date()): boolean {
  const state = claimStates.get(claim);
  if (!state?.active) return false;
  const nowIso = now.toISOString();
  try {
    const database = getDb();
    const renew = database.transaction((): boolean => {
      const existing = readLease(state.group);
      // Do not resurrect an expired lease: another process is entitled to acquire it once its TTL
      // passes, even if this process was paused long enough to miss every heartbeat.
      if (!existing || existing.owner !== state.owner || Date.parse(existing.expiresAt) <= now.getTime()) return false;
      upsertLease(state.group, {
        ...existing,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      }, nowIso);
      return true;
    });
    return renew.immediate() as boolean;
  } catch {
    return false;
  }
}

function releaseOperationLease(claim: OperationLeaseClaim): void {
  const state = claimStates.get(claim);
  if (!state) return;
  if (!state.active) {
    claimStates.delete(claim);
    return;
  }
  state.active = false;
  try {
    const database = getDb();
    const release = database.transaction((): void => {
      const existing = readLease(state.group);
      // Owner-token compare prevents an expired old holder from deleting its successor's lease.
      if (existing?.owner === state.owner) {
        database.prepare("DELETE FROM settings WHERE key = ?").run(leaseKey(state.group));
      }
    });
    release.immediate();
  } catch {
    // TTL is the crash/error fallback. Never mask the provider operation's real result.
  } finally {
    claimStates.delete(claim);
  }
}

function validateInheritedClaim(claim: OperationLeaseClaim, group: OperationLeaseGroup): ClaimState {
  const state = claimStates.get(claim);
  if (!state?.active || state.group !== group) {
    throw new OperationLeaseOwnershipError(`Operation lease claim does not authorize group "${group}".`);
  }
  let persisted: OperationLeaseRecord | null;
  try {
    persisted = readLease(group);
  } catch (error) {
    const ownershipError = new OperationLeaseOwnershipError(`Operation lease claim ownership for group "${group}" could not be verified.`, {
      cause: error
    });
    markClaimLost(claim, ownershipError);
    throw ownershipError;
  }
  if (
    !persisted ||
    persisted.owner !== state.owner ||
    Date.parse(persisted.expiresAt) <= Date.now()
  ) {
    const ownershipError = new OperationLeaseOwnershipError(`Operation lease claim no longer owns group "${group}".`);
    markClaimLost(claim, ownershipError);
    throw ownershipError;
  }
  return state;
}

function markClaimLost(claim: OperationLeaseClaim, error: Error): void {
  const state = claimStates.get(claim);
  if (!state) return;
  state.active = false;
  if (!state.controller.signal.aborted) state.controller.abort(error);
}

/**
 * Fail closed at a cooperative provider/write boundary if the heartbeat lost ownership or the
 * persisted owner/TTL no longer matches. The claim remains opaque; core code can only prove it.
 */
export function assertOperationLeaseOwnership(claim: OperationLeaseClaim): void {
  const state = claimStates.get(claim);
  if (!state) throw new OperationLeaseOwnershipError("Operation lease claim is not active.");
  if (state.controller.signal.aborted) {
    throw state.controller.signal.reason instanceof Error
      ? state.controller.signal.reason
      : new OperationLeaseOwnershipError(`Operation lease claim no longer owns group "${state.group}".`);
  }
  validateInheritedClaim(claim, state.group);
}

/** Cheap cooperative check between network steps; persisted ownership is checked before writes. */
export function throwIfOperationLeaseCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new OperationLeaseOwnershipError("Operation lease ownership was lost.");
}

/**
 * Run work while holding the named durable lease. The owner starts a TTL heartbeat and releases
 * with an owner-token compare. A nested core boundary can reuse the opaque claim acquired by an
 * admin guard, avoiding a self-conflict while keeping acquisition ahead of rate-budget debit.
 */
export async function runWithOperationLease<T>(
  options: OperationLeaseRunOptions,
  run: (claim: OperationLeaseClaim, signal: AbortSignal) => Promise<T>
): Promise<OperationLeaseRunResult<T>> {
  if (options.claim) {
    const state = validateInheritedClaim(options.claim, options.group);
    const value = await run(options.claim, state.controller.signal);
    // A long await can resume before an overdue heartbeat timer gets a turn. Re-read the persisted
    // owner/TTL here so timer starvation cannot let an expired or stolen holder report success.
    assertOperationLeaseOwnership(options.claim);
    return { acquired: true, value };
  }

  const ttl = leaseTtlMs(options.ttlMs);
  const acquired = acquireOperationLease(options.group, options.operation, ttl);
  if ("busy" in acquired) return { acquired: false, busy: acquired.busy };

  const state = claimStates.get(acquired.claim)!;
  const interval = setInterval(() => {
    if (!renewOperationLease(acquired.claim, ttl)) {
      markClaimLost(
        acquired.claim,
        new OperationLeaseOwnershipError(`Operation lease heartbeat could not prove ownership of group "${options.group}".`)
      );
    }
  }, heartbeatMs(ttl, options.heartbeatMs));
  interval.unref?.();

  try {
    const value = await run(acquired.claim, state.controller.signal);
    // Do not rely only on the heartbeat's AbortSignal at the success boundary: after an event-loop
    // pause, the awaited work's continuation can run before the overdue interval callback.
    assertOperationLeaseOwnership(acquired.claim);
    return { acquired: true, value, tookOverExpired: acquired.tookOverExpired };
  } finally {
    clearInterval(interval);
    releaseOperationLease(acquired.claim);
  }
}

export interface OperationLeaseStartResult {
  acquired: boolean;
  busy?: OperationLeaseBusy;
}

/**
 * Fire-and-forget sibling of `runWithOperationLease` for genuinely long-running admin-triggered
 * work (e.g. corpus-reembed) where the HTTP request must return immediately instead of blocking on
 * the whole operation. `runWithOperationLease`'s returned promise cannot resolve until `run`
 * finishes even in the busy branch check — awaiting it at all means awaiting full completion — so
 * a caller that wants an immediate "acquired or busy" answer needs acquisition split from
 * completion. Lease acquisition, heartbeat, and release are otherwise identical to
 * `runWithOperationLease`; this never accepts an inherited `options.claim` (fire-and-forget must
 * own the lease it starts, not borrow another guard's).
 *
 * Returns synchronously with `{acquired: false, busy}` when another operation already holds the
 * group. When acquired, `run` is started but NOT awaited by the caller; `onSettled` (best-effort,
 * never thrown) observes the eventual outcome so the caller can persist a final status.
 */
export function startDetachedOperationLease(
  options: Omit<OperationLeaseRunOptions, "claim">,
  run: (claim: OperationLeaseClaim, signal: AbortSignal) => Promise<void>,
  onSettled?: (result: { ok: boolean; error?: unknown }) => void
): OperationLeaseStartResult {
  const ttl = leaseTtlMs(options.ttlMs);
  const acquired = acquireOperationLease(options.group, options.operation, ttl);
  if ("busy" in acquired) return { acquired: false, busy: acquired.busy };

  const state = claimStates.get(acquired.claim)!;
  const interval = setInterval(() => {
    if (!renewOperationLease(acquired.claim, ttl)) {
      markClaimLost(
        acquired.claim,
        new OperationLeaseOwnershipError(`Operation lease heartbeat could not prove ownership of group "${options.group}".`)
      );
    }
  }, heartbeatMs(ttl, options.heartbeatMs));
  interval.unref?.();

  void run(acquired.claim, state.controller.signal)
    .then(() => {
      try {
        onSettled?.({ ok: true });
      } catch {
        // onSettled is best-effort observability only; never let it mask the real outcome.
      }
    })
    .catch((error: unknown) => {
      try {
        onSettled?.({ ok: false, error });
      } catch {
        // best-effort only
      }
    })
    .finally(() => {
      clearInterval(interval);
      releaseOperationLease(acquired.claim);
    });

  return { acquired: true };
}

/** Test-only cleanup for isolated temp databases. Production code must rely on owner release/TTL. */
export function resetOperationLeaseForTest(group?: OperationLeaseGroup): void {
  const database = getDb();
  if (group) database.prepare("DELETE FROM settings WHERE key = ?").run(leaseKey(group));
  else database.prepare("DELETE FROM settings WHERE key LIKE 'operation_lease:%'").run();
}
