/** The console's data store: one mutable object, many narrow subscribers.
 *
 *  WHY A STORE AND NOT ONE REACT CONTEXT (ST-4642)
 *
 *  The console used to publish a single context value that bundled the
 *  snapshot, the stream health, the freshness flags and the actions. Every
 *  SSE push minted a fresh stream object, so the bundled value's identity
 *  changed and EVERY consumer of the console re-rendered — including the
 *  twenty-odd files that only ever read `snapshot`. During an active scan
 *  (`market-data` events arriving continuously) that re-rendered the whole
 *  tree several times a minute, and it defeated the `memo()` wrappers on the
 *  expensive cards.
 *
 *  A store with per-slice subscriptions fixes both halves:
 *
 *   - a consumer that reads only the snapshot is not notified when the stream
 *     health or the freshness flags change, so it does not re-render; and
 *   - `useSyncExternalStore` decides whether to re-render by comparing the
 *     SELECTED value with `Object.is`, so a selector that returns a stable
 *     reference (or a shallow-equal object) keeps the consumer still even
 *     while the rest of the state churns.
 *
 *  The store is deliberately plain and framework-free so the slice contract
 *  can be tested without a DOM — this repo's vitest setup is node-only (no
 *  jsdom, no testing-library; see app/console/lib/console-load-state.ts for
 *  why that has already bitten this codebase once). */

import type { DashboardSnapshot } from "../../dashboard-types";
import { deriveConsoleLoadState } from "./console-load-state";

export type ConsoleStreamStatus = "unsupported" | "connecting" | "live" | "reconnecting";

export interface ConsoleStreamHealth {
  status: ConsoleStreamStatus;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  lastErrorAt: Date | null;
}

export const UNSUPPORTED_STREAM: ConsoleStreamHealth = {
  status: "unsupported",
  connectedAt: null,
  lastEventAt: null,
  lastEventType: null,
  lastErrorAt: null
};

/** Everything the console's data layer knows. Consumers subscribe to a SLICE
 *  of this, never to the whole thing (see useConsoleData.tsx). */
export interface ConsoleState {
  /** The last good dashboard snapshot. `null` until the first fetch lands. */
  snapshot: DashboardSnapshot | null;
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** A fetch came back 401 — the browser is being sent to /login. */
  sessionExpired: boolean;
  /** True while an attempt is in flight right now. */
  fetching: boolean;
  /** The first snapshot is late (past the slow threshold) but still coming. */
  slowFirstLoad: boolean;
  /** Health of the SSE stream used for push refreshes. */
  stream: ConsoleStreamHealth;
  /** Browser online state. False means show the last snapshot honestly. */
  online: boolean;
  /** Force a refetch now (used after every mutation). Stable for the life of
   *  the store, so subscribing to it never causes a re-render. */
  refresh: () => Promise<void>;
}

export type ConsoleListener = () => void;

/** Shallow equality for the small objects the selectors return (the status
 *  slice and friends). `Object.is` first, then a key-by-key compare — enough
 *  to keep a selected object's identity stable while its fields are equal,
 *  which is what stops `useSyncExternalStore` from re-rendering. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

export class ConsoleStore {
  private state: ConsoleState;
  private readonly listeners = new Set<ConsoleListener>();

  constructor(initial: ConsoleState) {
    this.state = initial;
  }

  getState = (): ConsoleState => this.state;

  subscribe = (listener: ConsoleListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Merge a patch and notify subscribers ONCE.
   *
   *  A patch whose fields are all unchanged is dropped without notifying, so a
   *  redundant write (the same snapshot arriving twice, say) costs nothing.
   *
   *  The patch may be a plain object or an updater that receives the current
   *  state — the updater form is for writes that depend on what is already
   *  there (e.g. "keep the first error"). */
  setState = (patch: Partial<ConsoleState> | ((state: ConsoleState) => Partial<ConsoleState>)): void => {
    const resolved = typeof patch === "function" ? patch(this.state) : patch;
    const next = resolved as Record<string, unknown>;
    const current = this.state as unknown as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(next)) {
      if (!Object.is(current[key], next[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...resolved };
    // Copy first: a listener may unsubscribe (or subscribe) while we notify.
    for (const listener of Array.from(this.listeners)) listener();
  };
}

/** The initial state a provider starts from: nothing loaded, no stream, and
 *  a `refresh` that resolves immediately (replaced with the real one as soon
 *  as the provider wires its fetch machinery up). */
export function initialConsoleState(refresh: () => Promise<void> = async () => {}): ConsoleState {
  return {
    snapshot: null,
    fetchedAt: null,
    error: null,
    sessionExpired: false,
    fetching: false,
    slowFirstLoad: false,
    stream: UNSUPPORTED_STREAM,
    online: true,
    refresh
  };
}

/* ── The slices ──────────────────────────────────────────────────────────────
 * Pure selectors over the state. A consumer subscribes to ONE of them, so a
 * change in another slice cannot re-render it. */

/** The status slice — freshness and failure, but not the data. */
export interface ConsoleStatus {
  /** When the current snapshot was fetched (client clock). */
  fetchedAt: Date | null;
  /** True only before the very first snapshot arrives. */
  loading: boolean;
  /** An attempt is in flight right now. */
  retrying: boolean;
  /** The first snapshot is late (past the slow threshold) but still coming. */
  slowFirstLoad: boolean;
  /** Last fetch error (the previous snapshot stays rendered). */
  error: string | null;
  /** A fetch came back 401 — the browser is being sent to /login. */
  sessionExpired: boolean;
  /** Browser online state. */
  online: boolean;
}

/** The action slice — stable for the life of the store. */
export interface ConsoleActions {
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
}

export function selectConsoleSnapshot(state: ConsoleState): DashboardSnapshot | null {
  return state.snapshot;
}

export function selectConsoleStatus(state: ConsoleState): ConsoleStatus {
  // The loading/slow/failed decision lives in a pure module so it is actually covered by tests
  // — see console-load-state.ts for why that mattered here.
  const load = deriveConsoleLoadState({
    hasSnapshot: state.snapshot !== null,
    error: state.error,
    fetching: state.fetching,
    slowElapsed: state.slowFirstLoad
  });
  return {
    fetchedAt: state.fetchedAt,
    loading: load === "loading" || load === "slow",
    retrying: state.fetching,
    slowFirstLoad: load === "slow",
    error: state.error,
    sessionExpired: state.sessionExpired,
    online: state.online
  };
}

export function selectConsoleStream(state: ConsoleState): ConsoleStreamHealth {
  return state.stream;
}

export function selectConsoleActions(state: ConsoleState): ConsoleActions {
  return { refresh: state.refresh };
}

/* ── Reading one slice ──────────────────────────────────────────────────────
 * React's `useSyncExternalStore` re-renders a consumer only when the value
 * its selector returns changes identity. `ConsoleSliceReader` is that rule,
 * written out: it caches the selected value and hands back the SAME reference
 * while the selection stays equal.
 *
 * The React hook (useConsoleSelection, in useConsoleData.tsx) drives a reader
 * like this one, and the unit test drives it directly — this repo's vitest
 * setup is node-only (no jsdom, no testing-library), so the re-render
 * contract is asserted at the store boundary rather than through a DOM. */

export class ConsoleSliceReader<T> {
  private cached: { value: T } | null = null;

  constructor(
    private readonly read: () => T,
    private readonly isEqual: (a: T, b: T) => boolean = shallowEqual
  ) {}

  /** The value the consumer sees. Referentially stable while the slice is
   *  unchanged — which is what makes `useSyncExternalStore` skip the
   *  re-render. */
  value = (): T => {
    const next = this.read();
    const cache = this.cached;
    if (cache && this.isEqual(cache.value, next)) return cache.value;
    this.cached = { value: next };
    return next;
  };
}
