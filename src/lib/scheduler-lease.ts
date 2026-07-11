// scheduler-lease.ts — single-leader compare-and-swap (CAS) lease for the scheduler tick.
//
// Stores the lease as a JSON blob in the existing `settings` KV table (key = "scheduler:lease").
// NO new table, NO migration. Mirrors the acquireStrategyLock CAS pattern in db-execution.ts.
//
// Atomicity note: like acquireStrategyLock, the database.transaction() wrapper serializes
// read+write within a process and within SQLite's single-writer model. A two-process TOCTOU
// window of one tick remains — the same pre-existing limitation shared by acquireStrategyLock.
// The TTL+steal semantics plus the per-process stopMonitorInFlight guard make a real double-exit
// vanishingly unlikely. Single-leader operation is ON by default; an operator can still disable it
// explicitly for diagnostics. Fixing the underlying TOCTOU is a SEPARATE PR.
//
// Do NOT use setSetting() here — that calls audit("policy_change") which is noisy for lease ops.
// Use direct getDb() prepared statements, matching the acquireStrategyLock approach.

import { randomUUID } from "crypto";
import { getDb } from "./db";

const LEASE_KEY = "scheduler:lease"; // colon-namespaced, mirrors "scheduler:lastTick"

export interface LeaseRecord {
  owner: string;
  acquiredAt: string; // ISO
  expiresAt: string;  // ISO
}

// Stable per-process instance id. Pinned to globalThis so Next.js HMR re-evaluating this module
// does NOT mint a new id and silently orphan a lease this process holds.
const ownerHost = globalThis as unknown as { __schedulerLeaseOwner?: string };
export const LEASE_OWNER: string =
  ownerHost.__schedulerLeaseOwner ??
  (ownerHost.__schedulerLeaseOwner = `${process.pid}:${randomUUID()}`);

/** Read the raw lease row. Returns null if absent or JSON-malformed (treat as reclaimable). */
function readLease(database = getDb()): LeaseRecord | null {
  const row = database
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(LEASE_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as LeaseRecord;
  } catch {
    return null; // malformed → treat as absent (reclaimable), mirrors acquireStrategyLock
  }
}

/** Write (upsert) a lease record. Caller must be inside a transaction. */
function writeLease(database: ReturnType<typeof getDb>, rec: LeaseRecord, nowIso: string): void {
  database
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    )
    .run(LEASE_KEY, JSON.stringify(rec), nowIso);
}

/**
 * Atomically acquire the scheduler lease for `owner`.
 *
 * Wins if:
 *  - no lease exists, OR
 *  - the existing lease is JSON-malformed (treated as absent), OR
 *  - the existing lease has EXPIRED (expiresAt <= now) — steals it, OR
 *  - the existing lease already belongs to `owner` — re-acquires/extends.
 *
 * Returns false (without writing) if a LIVE lease is held by a different owner.
 * Fails closed: any exception returns false so a process that can't prove leadership
 * does NOT run the money-path body.
 */
export function acquireLease(owner: string, ttlMs: number, now: Date = new Date()): boolean {
  const database = getDb();
  const nowIso = now.toISOString();

  const acquire = database.transaction((): boolean => {
    const existing = readLease(database);

    // Determine if we can win:
    // - no existing lease (null → absent or malformed)
    // - expired
    // - already ours
    const canWin =
      existing === null ||
      new Date(existing.expiresAt).getTime() <= now.getTime() ||
      existing.owner === owner;

    if (!canWin) return false;

    writeLease(
      database,
      {
        owner,
        acquiredAt: nowIso,
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      },
      nowIso
    );
    return true;
  });

  try {
    return acquire.immediate() as boolean;
  } catch {
    // Fail closed: if we can't prove leadership, behave as non-leader.
    return false;
  }
}

/**
 * Atomically renew the lease, extending expiresAt by ttlMs from now.
 * Only succeeds if the current owner matches. Does NOT steal; use acquireLease for that.
 *
 * Returns false (without writing) if the lease is absent or belongs to a different owner.
 * Fails closed on any exception.
 */
export function renewLease(owner: string, ttlMs: number, now: Date = new Date()): boolean {
  const database = getDb();
  const nowIso = now.toISOString();

  const renew = database.transaction((): boolean => {
    const existing = readLease(database);
    if (!existing || existing.owner !== owner) return false;

    writeLease(
      database,
      {
        owner: existing.owner,
        acquiredAt: existing.acquiredAt, // keep original acquiredAt
        expiresAt: new Date(now.getTime() + ttlMs).toISOString()
      },
      nowIso
    );
    return true;
  });

  try {
    return renew.immediate() as boolean;
  } catch {
    return false;
  }
}

/**
 * Release the lease only if `owner` is the current holder. No-op otherwise (safe to call even
 * if the lease was already stolen or never held). Never throws — shutdown path must be safe.
 */
export function releaseLease(owner: string): void {
  const database = getDb();

  const release = database.transaction((): void => {
    const existing = readLease(database);
    if (!existing || existing.owner !== owner) return;
    database.prepare("DELETE FROM settings WHERE key = ?").run(LEASE_KEY);
  });

  try {
    release.immediate();
  } catch {
    // Swallow — shutdown path must never throw.
  }
}

/**
 * Read the current lease state, augmented with derived `ageMs` and `expired` fields.
 * Returns null when no lease exists (or if the row is malformed). Never throws.
 */
export function getLease(
  now: Date = new Date()
): (LeaseRecord & { ageMs: number; expired: boolean }) | null {
  try {
    const existing = readLease();
    if (!existing) return null;
    const ageMs = now.getTime() - new Date(existing.acquiredAt).getTime();
    const expired = now.getTime() >= new Date(existing.expiresAt).getTime();
    return { ...existing, ageMs, expired };
  } catch {
    return null;
  }
}

/** Read SCHEDULER_LEASE_TTL_MS env var, defaulting to 90_000 ms (1.5 ticks). */
function leaseTtlMs(): number {
  const parsed = Number(process.env.SCHEDULER_LEASE_TTL_MS ?? 90_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}

/**
 * Convenience wrapper for tick(): attempt renew first (cheapest path for the stable leader),
 * then fall back to acquire. Returns true if THIS process is the leader this tick.
 */
export function acquireOrRenewLeadership(now: Date = new Date()): boolean {
  const ttl = leaseTtlMs();
  if (renewLease(LEASE_OWNER, ttl, now)) return true;
  return acquireLease(LEASE_OWNER, ttl, now);
}
