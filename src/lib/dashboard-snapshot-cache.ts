/**
 * Short in-memory TTL cache for dashboard snapshots (UX Wave C1).
 *
 * Keyed by (userId, accountNumber) so multi-account users never share a snapshot
 * across accounts. Separate module so write paths (setPolicy, approve, …) can
 * invalidate without importing the heavy dashboard assembly graph.
 *
 * Correctness model: ~10s soft TTL + explicit invalidation on policy/proposal
 * writes. Stale portfolio for a few seconds is acceptable; cross-account leak is not.
 */

/** Default TTL (~10s). Override in tests via options on get/set helpers. */
export const DASHBOARD_SNAPSHOT_TTL_MS = 10_000;

export function dashboardSnapshotCacheKey(
  userId: string,
  accountNumber: string | null | undefined
): string {
  return `${userId}\0${accountNumber ?? ""}`;
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

/** Last value for `key`, including after the soft TTL.  The happy path must not serve it. */
export function peekDashboardSnapshot<T>(key: string, now = Date.now()): { value: T; fresh: boolean } | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) return undefined;
  return { value: entry.value, fresh: entry.expiresAt > now };
}

/** Read a non-expired entry, or undefined.  Expired rows stay so a later timeout can serve them. */
export function getCachedDashboardSnapshot<T>(key: string, now = Date.now()): T | undefined {
  const peeked = peekDashboardSnapshot<T>(key, now);
  if (!peeked?.fresh) return undefined;
  return peeked.value;
}

/** Store a snapshot under key with the given TTL. */
export function setCachedDashboardSnapshot<T>(
  key: string,
  value: T,
  ttlMs: number = DASHBOARD_SNAPSHOT_TTL_MS,
  now = Date.now()
): void {
  cache.set(key, { expiresAt: now + ttlMs, value });
}

/**
 * Single-flight: if another compute for `key` is already running, await it;
 * otherwise run `compute`, cache the result, and return it.
 */
export async function getOrComputeDashboardSnapshot<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = DASHBOARD_SNAPSHOT_TTL_MS
): Promise<T> {
  const hit = getCachedDashboardSnapshot<T>(key);
  if (hit !== undefined) return hit;

  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await compute();
      setCachedDashboardSnapshot(key, value, ttlMs);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Drop cached snapshots.
 * - no args: clear entire process cache
 * - userId only: all keys for that user (any account)
 * - userId + accountNumber: that exact key only
 */
export function invalidateDashboardSnapshotCache(
  userId?: string,
  accountNumber?: string | null
): void {
  if (userId == null) {
    cache.clear();
    inFlight.clear();
    return;
  }
  if (accountNumber !== undefined) {
    const key = dashboardSnapshotCacheKey(userId, accountNumber);
    cache.delete(key);
    inFlight.delete(key);
    return;
  }
  const prefix = `${userId}\0`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

/** Test-only: full reset. */
export function resetDashboardSnapshotCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

/** Test-only: current entry count (non-expired not required). */
export function dashboardSnapshotCacheSizeForTests(): number {
  return cache.size;
}
