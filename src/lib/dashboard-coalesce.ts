/**
 * Per-user, per-account single-flight for GET /api/dashboard.
 *
 * getDashboardSnapshot already memoizes inside src/lib/dashboard.ts. This wrapper
 * sits outside that file so concurrent route calls share one invocation even when
 * that module's own map is not the one the route is waiting on. A finished
 * snapshot is remembered for a few seconds. A thrown compute is not. The
 * budget-timeout shell is not remembered either: that early return is not the
 * finished snapshot, and the in-flight compute still fills the inner cache.
 *
 * Keys match dashboardSnapshotCacheKey (userId + selected account). A write that
 * already clears the inner cache clears this memo too. An in-flight compute does
 * not get stored after that write, and a later request does not join it.
 */

import "server-only";
import { getActiveConnectedAccount } from "./db-api-keys";
import { getPolicy } from "./db-profiles";
import { onDashboardSnapshotInvalidated } from "./dashboard-snapshot-cache";

/** Short enough that a poll still sees a fresh book, long enough to collapse a page-load burst. */
export const DASHBOARD_COALESCE_TTL_MS = 8_000;

const BUDGET_SHELL_PREFIX = "Dashboard snapshot exceeded ";
const STORE_KEY = "__socraticDashboardCoalesceV1";
const LISTENER_KEY = "__socraticDashboardCoalesceListenerV1";

interface MemoEntry {
  expiresAt: number;
  value: unknown;
}

interface CoalesceStore {
  memos: Map<string, MemoEntry>;
  inflight: Map<string, Promise<unknown>>;
  generation: Map<string, number>;
}

function store(): CoalesceStore {
  const host = globalThis as typeof globalThis & { [STORE_KEY]?: CoalesceStore };
  const existing = host[STORE_KEY];
  if (existing) return existing;
  const created: CoalesceStore = {
    memos: new Map(),
    inflight: new Map(),
    generation: new Map()
  };
  host[STORE_KEY] = created;
  return created;
}

export function dashboardCoalesceKey(userId: string, accountNumber: string | null | undefined): string {
  return `${userId}\0${accountNumber ?? ""}`;
}

/** Selected account for the signed-in user, matching the inner snapshot cache key. */
export function dashboardAccountCoalesceKey(userId: string): string {
  const policy = getPolicy(userId);
  const active = getActiveConnectedAccount(userId);
  return dashboardCoalesceKey(userId, policy.accountNumber ?? active?.accountNumber ?? "");
}

export function isDashboardBudgetShell(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const reason = (value as { partialReason?: unknown }).partialReason;
  return typeof reason === "string" && reason.startsWith(BUDGET_SHELL_PREFIX);
}

function generationOf(key: string): number {
  return store().generation.get(key) ?? 0;
}

function bumpGeneration(key: string): void {
  const current = store();
  current.generation.set(key, (current.generation.get(key) ?? 0) + 1);
  current.memos.delete(key);
  // Callers that already joined keep that promise. A request that arrives after
  // the write must not join a compute that started before the write.
  current.inflight.delete(key);
}

function keysFor(userId?: string, accountNumber?: string | null): string[] {
  const current = store();
  const all = new Set<string>([
    ...current.memos.keys(),
    ...current.inflight.keys(),
    ...current.generation.keys()
  ]);
  if (userId == null) return [...all];
  if (accountNumber !== undefined) return [dashboardCoalesceKey(userId, accountNumber)];
  const prefix = `${userId}\0`;
  return [...all].filter((key) => key.startsWith(prefix));
}

/** Drop memos. Callers already waiting keep their promise. New callers recompute. */
export function invalidateDashboardCoalesce(userId?: string, accountNumber?: string | null): void {
  if (userId == null) {
    for (const key of keysFor()) bumpGeneration(key);
    store().memos.clear();
    return;
  }
  for (const key of keysFor(userId, accountNumber)) bumpGeneration(key);
}

export function resetDashboardCoalesceForTests(): void {
  const current = store();
  current.memos.clear();
  current.inflight.clear();
  current.generation.clear();
}

export async function coalesceDashboardSnapshot<T>(
  key: string,
  compute: () => Promise<T>,
  options?: { ttlMs?: number; cacheable?: (value: T) => boolean }
): Promise<T> {
  const ttlMs = options?.ttlMs ?? DASHBOARD_COALESCE_TTL_MS;
  const cacheable = options?.cacheable ?? ((value: T) => !isDashboardBudgetShell(value));
  const current = store();
  const hit = current.memos.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;

  const pending = current.inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const startedGeneration = generationOf(key);
  const slot: { promise?: Promise<T> } = {};
  const promise = (async () => {
    try {
      const value = await compute();
      if (startedGeneration === generationOf(key) && cacheable(value)) {
        store().memos.set(key, { expiresAt: Date.now() + ttlMs, value });
      }
      return value;
    } finally {
      const latest = store();
      if (latest.inflight.get(key) === slot.promise) latest.inflight.delete(key);
    }
  })();
  slot.promise = promise;

  current.inflight.set(key, promise);
  return promise;
}

export function coalesceUserDashboardSnapshot<T>(userId: string, compute: () => Promise<T>): Promise<T> {
  return coalesceDashboardSnapshot(dashboardAccountCoalesceKey(userId), compute);
}

const listenerHost = globalThis as typeof globalThis & { [LISTENER_KEY]?: boolean };
if (!listenerHost[LISTENER_KEY]) {
  listenerHost[LISTENER_KEY] = true;
  onDashboardSnapshotInvalidated((userId, accountNumber) => {
    invalidateDashboardCoalesce(userId, accountNumber);
  });
}
