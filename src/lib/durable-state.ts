// durable-state.ts — the standard for making an in-memory rate-limiter / circuit-breaker /
// cooldown counter survive a process restart. The app now auto-deploys on every merge to main
// (replacing the running container mid-session), so any in-memory guard against a real external
// rate cap or a real safety cooldown (order-remediation double-sell guard, LLM trigger-engine
// hourly/daily caps, etc.) needs to come back with its pre-restart state intact — otherwise a
// redeploy silently grants a fresh budget/cooldown an attacker or a bug couldn't get any other way.
//
// createDurableMap(namespace) gives call sites a drop-in replacement for `new Map()`: reads/writes
// go through an in-memory cache (source of truth for the hot path — no per-call DB latency), which
// is hydrated from SQLite once per process on first touch of that namespace, and written back
// either "debounced" (batched, flushed after a short idle window — the default, right for anything
// checked/updated frequently) or "immediate" (synchronous write-through on every set/delete — right
// for low-frequency call sites where losing the last few seconds of state on a hard crash matters
// more than saving a synchronous write, e.g. a financial double-action guard).
//
// NOT every in-memory Map should use this. Deliberately ephemeral state — an in-flight lock/Set
// tied to promises that literally cannot survive a restart, a TTL cache meant to reset, a pacer
// whose correct post-restart state IS zero in-flight — must keep using a bare Map. Persisting those
// would introduce new bugs (stale locks, resurrected in-flight markers) rather than fixing anything.
import { getDurableStateValue, setDurableStateValue, deleteDurableStateValue, listDurableStateNamespace } from "./db-durable-state";

const FLUSH_DEBOUNCE_MS = 15_000;

const DELETE_TOMBSTONE = Symbol("durable-state-delete");

// All module state is globalThis-pinned (mirrors the pattern already used by order-replacement.ts,
// congress-share.ts, triggers.ts, scheduler.ts) so a fresh instance of THIS module -- Next.js HMR
// re-evaluating the file in dev, or a test runner giving each test file its own isolated module
// registry -- reuses the same cache/timers/registered-hooks instead of starting over. Without this,
// each fresh instance would independently call process.once("SIGTERM", ...) etc., leaking listeners
// on the one real process (harmless-but-noisy in tests, an accumulating leak across dev-mode HMR
// reloads) -- and worse, a stale orphaned instance's pending debounced writes could be lost if a
// newer instance took over pendingWrites/flushTimer without them.
interface DurableStateHost {
  __durableStateCache?: Map<string, Map<string, unknown>>;
  __durableStateHydratedNamespaces?: Set<string>;
  __durableStatePendingWrites?: Map<string, unknown>;
  __durableStateFlushTimer?: ReturnType<typeof setTimeout> | null;
  __durableStateShutdownHooksRegistered?: boolean;
}
const host = globalThis as unknown as DurableStateHost;

// In-memory cache: namespace -> key -> value. Source of truth for reads between flushes.
const cache: Map<string, Map<string, unknown>> = host.__durableStateCache ?? (host.__durableStateCache = new Map());
const hydratedNamespaces: Set<string> = host.__durableStateHydratedNamespaces ?? (host.__durableStateHydratedNamespaces = new Set());

// Pending writes keyed by "namespace key" -- a plain space separator (namespace strings we define
// ourselves never contain one). Coalesces multiple writes to the same key within one debounce
// window into one row.
const pendingWrites: Map<string, unknown> = host.__durableStatePendingWrites ?? (host.__durableStatePendingWrites = new Map());
// flushTimer/shutdownHooksRegistered are reassigned (not just lazily-created-once like the Map/Set
// above), so they're read/written directly through `host` rather than mirrored into a local binding
// that a second module instance wouldn't see updates to.

function nsKeyOf(namespace: string, key: string): string {
  return `${namespace} ${key}`;
}

/** Whether `namespace` has completed its one-time hydration from SQLite. Exposed so a caller with
 *  ITS OWN mirrored copy of durable state (RequestQuota's `hits` map, hydrated once via
 *  restoreLane) can gate its own re-hydration off the SAME source of truth durable-state already
 *  tracks — instead of keeping a second, easily-inconsistent hydration flag that
 *  resetDurableStateCacheForTests() wouldn't know to clear. */
export function hasHydratedNamespace(namespace: string): boolean {
  return hydratedNamespaces.has(namespace);
}

function ensureHydrated(namespace: string): Map<string, unknown> {
  let ns = cache.get(namespace);
  if (!ns) {
    ns = new Map();
    cache.set(namespace, ns);
  }
  if (!hydratedNamespaces.has(namespace)) {
    hydratedNamespaces.add(namespace); // mark first: a failed read below must not retry every call
    try {
      for (const [key, value] of listDurableStateNamespace(namespace)) ns.set(key, value);
    } catch (err) {
      // Best-effort, matching the write-behind flush path: a caller reading/writing durable state
      // must never crash on a DB error (e.g. a test's `vi.mock("../src/lib/db", ...)` that doesn't
      // provide `getDb`, since it never intended to exercise persistence at all). Degrade to an
      // empty in-memory cache for this namespace rather than propagating the failure.
      console.error(`[durable-state] hydration failed for namespace ${namespace}:`, err instanceof Error ? err.message : err);
    }
  }
  return ns;
}

function scheduleFlush(): void {
  if (host.__durableStateFlushTimer) return;
  const timer = setTimeout(() => {
    host.__durableStateFlushTimer = null;
    flushDurableStateNow();
  }, FLUSH_DEBOUNCE_MS);
  timer.unref?.();
  host.__durableStateFlushTimer = timer;
}

/** Flush every pending debounced write to SQLite immediately. Idempotent (a no-op with nothing
 *  pending). Call sites needing exact synchronous behavior should pass `flush: "immediate"` to
 *  `createDurableMap` instead of relying on manual flush timing. */
export function flushDurableStateNow(): void {
  if (host.__durableStateFlushTimer) {
    clearTimeout(host.__durableStateFlushTimer);
    host.__durableStateFlushTimer = null;
  }
  if (pendingWrites.size === 0) return;
  const batch = [...pendingWrites.entries()];
  pendingWrites.clear();
  for (const [nsKey, value] of batch) {
    const sep = nsKey.indexOf(" ");
    const namespace = nsKey.slice(0, sep);
    const key = nsKey.slice(sep + 1);
    try {
      if (value === DELETE_TOMBSTONE) deleteDurableStateValue(namespace, key);
      else setDurableStateValue(namespace, key, value);
    } catch (err) {
      // Best-effort: a durable-state write failing must never break the caller's own hot path
      // (that's the whole point of write-behind). Losing this one write just means a restart
      // within the debounce window sees slightly stale state, same as any other lost debounce tick.
      console.error(`[durable-state] flush failed for ${namespace}/${key}:`, err instanceof Error ? err.message : err);
    }
  }
}

function registerShutdownFlushOnce(): void {
  if (host.__durableStateShutdownHooksRegistered) return;
  host.__durableStateShutdownHooksRegistered = true;
  const flush = () => flushDurableStateNow();
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
  process.on("beforeExit", flush);
}

export interface DurableMapOptions {
  /** "debounced" (default): batch writes, flush ~15s after the last write or on process shutdown.
   *  "immediate": write-through synchronously on every set/delete — use for low-frequency call
   *  sites where an ungraceful crash losing the last write matters (e.g. a double-action guard). */
  flush?: "debounced" | "immediate";
}

export interface DurableMap<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  has(key: string): boolean;
  /** Clears BOTH the in-memory cache and the persisted rows for this namespace. */
  clear(): void;
  entries(): IterableIterator<[string, T]>;
  keys(): IterableIterator<string>;
  readonly size: number;
}

/** A `Map`-shaped, SQLite-backed durable store for one namespace. See file header for when to use
 *  this vs. a bare `Map`. Namespaces are independent — reuse the same namespace string only for
 *  values a single owning module writes; give each call site its own namespace. */
export function createDurableMap<T>(namespace: string, options: DurableMapOptions = {}): DurableMap<T> {
  const flushMode = options.flush ?? "debounced";
  registerShutdownFlushOnce();

  function persist(key: string, value: T | typeof DELETE_TOMBSTONE): void {
    const nsKey = nsKeyOf(namespace, key);
    if (flushMode === "immediate") {
      pendingWrites.delete(nsKey); // nothing left for a later debounced flush to redo
      try {
        if (value === DELETE_TOMBSTONE) deleteDurableStateValue(namespace, key);
        else setDurableStateValue(namespace, key, value);
      } catch (err) {
        console.error(`[durable-state] immediate write failed for ${namespace}/${key}:`, err instanceof Error ? err.message : err);
      }
    } else {
      pendingWrites.set(nsKey, value);
      scheduleFlush();
    }
  }

  return {
    get(key) {
      return ensureHydrated(namespace).get(key) as T | undefined;
    },
    set(key, value) {
      ensureHydrated(namespace).set(key, value);
      persist(key, value);
    },
    delete(key) {
      const existed = ensureHydrated(namespace).delete(key);
      if (existed) persist(key, DELETE_TOMBSTONE);
    },
    has(key) {
      return ensureHydrated(namespace).has(key);
    },
    clear() {
      const ns = ensureHydrated(namespace);
      for (const key of ns.keys()) persist(key, DELETE_TOMBSTONE);
      ns.clear();
    },
    entries() {
      return ensureHydrated(namespace).entries() as IterableIterator<[string, T]>;
    },
    keys() {
      return ensureHydrated(namespace).keys();
    },
    get size() {
      return ensureHydrated(namespace).size;
    }
  };
}

/** Test-only: forget in-memory hydration/cache state for a namespace (or all of them) so the next
 *  access re-reads from SQLite, and drop any not-yet-flushed pending writes for it. Does NOT delete
 *  the persisted rows themselves — pair with the map's own `.clear()` for that. */
export function resetDurableStateCacheForTests(namespace?: string): void {
  if (!namespace) {
    cache.clear();
    hydratedNamespaces.clear();
    pendingWrites.clear();
    if (host.__durableStateFlushTimer) {
      clearTimeout(host.__durableStateFlushTimer);
      host.__durableStateFlushTimer = null;
    }
    return;
  }
  cache.delete(namespace);
  hydratedNamespaces.delete(namespace);
  for (const nsKey of [...pendingWrites.keys()]) {
    if (nsKey.startsWith(`${namespace} `)) pendingWrites.delete(nsKey);
  }
}
