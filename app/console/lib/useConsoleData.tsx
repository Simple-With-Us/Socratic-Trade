"use client";

/** The console's single data layer: one polled GET /api/dashboard snapshot
 *  shared by every screen via context, refreshed on an interval, after every
 *  mutation, and when the tab becomes visible again. Errors never blank the
 *  screen — the last good snapshot stays up and a visible staleness notice is
 *  derived from `error` + `fetchedAt`.
 *
 *  HOW COMPONENTS SUBSCRIBE (2026-11-23, ST-4642)
 *
 *  The provider used to publish ONE context value bundling the snapshot, the
 *  stream health, the freshness flags and the actions. Every SSE push minted a
 *  fresh stream object, so the bundled value's identity changed and EVERY
 *  consumer re-rendered — including the twenty-odd files that only ever read
 *  `snapshot`. During an active scan (`market-data` events arriving
 *  continuously) that re-rendered the whole console tree several times a
 *  minute, and it defeated the `memo()` wrappers on the expensive cards.
 *
 *  Now the provider publishes a small store (see console-store.ts) and each
 *  consumer subscribes to the ONE slice it reads:
 *
 *   - `useConsoleSnapshot()` — the dashboard snapshot.
 *   - `useConsoleStatus()`   — fetchedAt / loading / retrying / slowFirstLoad /
 *                              error / sessionExpired / online.
 *   - `useConsoleStream()`   — SSE health.
 *   - `useConsoleActions()`  — `refresh` (stable forever).
 *
 *  A component that reads only the snapshot is not notified when the stream
 *  health or the freshness flags change, so it does not re-render.
 *  `useConsoleData()` still exists and still returns everything — it
 *  subscribes to every slice, so prefer the narrow hooks in new code.
 *
 *  The polling itself is also route-aware (audit #5): a route that displays no
 *  market data ignores `market-data` pushes and is polled half as often. See
 *  route-data-profile.ts for exactly which routes and why. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { usePathname } from "next/navigation";
import type { DashboardSnapshot } from "../../dashboard-types";
import { ConsoleApiError, fetchDashboard } from "./api";
import { refreshWaitersReadyForAttempt, shouldSkipDashboardPoll } from "./dashboard-request";
import {
  ConsoleSliceReader,
  ConsoleStore,
  UNSUPPORTED_STREAM,
  initialConsoleState,
  selectConsoleActions,
  selectConsoleSnapshot,
  selectConsoleStatus,
  selectConsoleStream,
  shallowEqual,
  type ConsoleActions,
  type ConsoleState,
  type ConsoleStatus,
  type ConsoleStreamHealth
} from "./console-store";
import { routeDataProfile } from "./route-data-profile";
import { SENTENCE_GAP } from "./format";

export type { ConsoleStreamHealth, ConsoleStreamStatus } from "./console-store";
export type { ConsoleActions, ConsoleStatus } from "./console-store";

// Shown the instant a 401 is detected, replacing whatever freshness copy would otherwise
// describe the last-good snapshot as merely "delayed" — see ShellFrame's sessionExpired branch
// in shell.tsx, which renders this instead of the normal dashboard chrome.
export const SESSION_EXPIRED_MESSAGE = `Your session has expired.${SENTENCE_GAP}Redirecting you to sign in…`;

const POLL_MS = 15_000;
const EVENT_REFRESH_DEBOUNCE_MS = 200;
// Reassurance timer, NOT a failure. When it fires the first snapshot still hasn't arrived, so the
// shell adds a "this is taking longer than usual" line UNDER the load animation — it does not set
// `error`, and it must never flip the shell to the error card.
//
// It used to do exactly that (set `error` at 15s), and that was a real bug the owner hit on every
// single production load: getDashboardSnapshot is self-bounded but its broker chain is SEQUENTIAL
// (~24s worst case — see FETCH_DEADLINE_MS below), so any first load in the 15-24s band showed
// "Couldn't load the autonomy desk" while the request was still in flight and about to succeed.
// The native iOS client, which polls the SAME getDashboardSnapshot via /api/mobile/snapshot but
// just waits out its 30s URLSession timeout, loaded fine at the same moment — that split is what
// the owner reported ("iOS said stale for a few minutes, then Updated; the website errors").
//
// The watchdog's original job — "don't sit on the logo forever if the fetch hangs" — is now owned
// by FETCH_DEADLINE_MS, which aborts and retries a genuinely hung attempt. So this timer no longer
// needs to (and must not) manufacture an error to stay safe.
const FIRST_LOAD_SLOW_NOTICE_MS = 15_000;
// Hard per-attempt ceiling, independent of anything the server does. fetchDashboard has no
// built-in timeout, so a request that hangs at the network layer (an open connection that never
// receives data — exactly the kernel TCP-memory-exhaustion failure mode that caused the prod
// incident this file's coalescing logic exists to fix) would otherwise sit in `inFlight` forever:
// every later SSE/poll/visibility trigger only sets `pendingBackgroundRefresh` and returns (by
// design, to avoid resurrecting the old abort-storm), so nothing would ever start a fresh attempt.
// This timer fires ONCE per attempt (not once per event), so it cannot reintroduce that storm — it
// only kills an attempt that has been stuck well past what any real (even fully degraded) response
// should take.
//
// This ceiling MUST sit above the server's own worst-case self-bounded response. getDashboardSnapshot
// races each upstream against its own deadline, but the broker chain is SEQUENTIAL — gateway.getAccounts
// (6s) → portfolio/positions/orders (8s) → getEquityQuotes (6s) = 20s — and computeSpyBenchmark (4s) runs
// after it, so a slow-but-not-hung account with held symbols can legitimately take ~24s to return a fully
// degraded snapshot. A client ceiling at/below that would abort right as the server is about to respond,
// retry, and keep the console stuck on the watchdog/retry path even though the server deadlines are
// working as designed. 35s leaves headroom over that 24s server bound (plus sync DB work) while still
// killing a genuine network hang, which never resolves at all.
const FETCH_DEADLINE_MS = 35_000;
// Sentinel abort reason so a deadline-triggered abort can be told apart from an explicit refresh()
// superseding this attempt (which aborts with no reason / the default AbortError).
const DEADLINE_REASON = Symbol("dashboard-fetch-deadline");
// Shown while a deadline-aborted attempt is retrying. Setting `error` here is what makes the
// freshness strip flip to "delayed" — without it, a request that keeps hanging past
// FETCH_DEADLINE_MS would retry every ~35s forever with `error` still null, so the console would
// keep labeling an old snapshot "fresh" even though no refresh has actually landed.
const DEADLINE_ERROR_MESSAGE = "The dashboard is taking too long to respond.  Retrying…";

/** The aggregate view, kept for callers that genuinely need every slice (the
 *  shell chrome). Prefer the narrow hooks. */
export interface ConsoleData extends ConsoleStatus {
  snapshot: DashboardSnapshot | null;
  /** Health of the SSE stream used for push refreshes. */
  stream: ConsoleStreamHealth;
  /** Force a refetch now (used after every mutation). */
  refresh: () => Promise<void>;
}

/** Exported so a test (or a future provider variant) can publish a store
 *  directly. Consumers should use the hooks below, not this. */
export const ConsoleStoreContext = createContext<ConsoleStore | null>(null);

/* ── The subscription hook ───────────────────────────────────────────────────
 * `useSyncExternalStore` re-renders a consumer only when the SELECTED value
 * changes identity. `ConsoleSliceReader` (console-store.ts) is that rule
 * written out — it caches the selected value and hands back the SAME
 * reference while the selection stays equal, so a stream-only change leaves a
 * snapshot-scoped consumer completely alone. */

function noopSubscribe(): () => void {
  return () => {};
}

function useConsoleSelection<T>(
  selector: (state: ConsoleState) => T,
  isEqual: (a: T | undefined, b: T | undefined) => boolean = shallowEqual
): T | undefined {
  const store = useContext(ConsoleStoreContext);
  // One reader per store, so the selected value stays referentially stable
  // across renders (the cache inside the reader is what keeps it stable).
  const reader = useMemo(
    () =>
      new ConsoleSliceReader<T | undefined>(
        () => (store ? selector(store.getState()) : undefined),
        isEqual
      ),
    [store, selector, isEqual]
  );

  // `selector` and `isEqual` are module-level functions at every call site, so
  // `getSnapshot` stays stable across renders (useSyncExternalStore wants that).
  const getSnapshot = useCallback(() => reader.value(), [reader]);

  const subscribe = store ? store.subscribe : noopSubscribe;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/* ── Public hooks ───────────────────────────────────────────────────────── */

export function useConsoleSnapshot(): DashboardSnapshot | null {
  const snapshot = useConsoleSelection(selectConsoleSnapshot);
  if (snapshot === undefined) {
    throw new Error("useConsoleSnapshot must be used inside ConsoleDataProvider");
  }
  return snapshot;
}

/** The snapshot, or `null` when there is no provider (or no snapshot yet).
 *
 *  For surfaces mounted OUTSIDE the console shell — /admin deliberately skips
 *  the dashboard snapshot fetch (see app/admin/layout.tsx) — and for the route
 *  smoke tests that render a page bare. Pair it with `useHasConsoleData()`
 *  when the difference between "no provider" and "provider, no snapshot yet"
 *  matters. */
export function useConsoleSnapshotOptional(): DashboardSnapshot | null {
  const snapshot = useConsoleSelection(selectConsoleSnapshot);
  return snapshot === undefined ? null : snapshot;
}

export function useConsoleStatus(): ConsoleStatus {
  const status = useConsoleSelection(selectConsoleStatus);
  if (status === undefined) {
    throw new Error("useConsoleStatus must be used inside ConsoleDataProvider");
  }
  return status;
}

export function useConsoleStream(): ConsoleStreamHealth {
  const stream = useConsoleSelection(selectConsoleStream);
  if (stream === undefined) {
    throw new Error("useConsoleStream must be used inside ConsoleDataProvider");
  }
  return stream;
}

export function useConsoleActions(): ConsoleActions {
  const actions = useConsoleSelection(selectConsoleActions);
  if (actions === undefined) {
    throw new Error("useConsoleActions must be used inside ConsoleDataProvider");
  }
  return actions;
}

/** True when a ConsoleDataProvider is mounted above this component.
 *
 *  For surfaces mounted OUTSIDE the console shell (e.g. /admin, which
 *  deliberately skips the dashboard snapshot fetch — see app/admin/layout.tsx).
 *  It reads the store CONTEXT, not the store's state, so it never subscribes
 *  and never re-renders. */
export function useHasConsoleData(): boolean {
  return useContext(ConsoleStoreContext) !== null;
}

export function useConsoleData(): ConsoleData {
  const snapshot = useConsoleSnapshot();
  const status = useConsoleStatus();
  const stream = useConsoleStream();
  const actions = useConsoleActions();
  return useMemo<ConsoleData>(
    () => ({
      snapshot,
      fetchedAt: status.fetchedAt,
      loading: status.loading,
      retrying: status.retrying,
      slowFirstLoad: status.slowFirstLoad,
      error: status.error,
      sessionExpired: status.sessionExpired,
      online: status.online,
      stream,
      refresh: actions.refresh
    }),
    [snapshot, status, stream, actions]
  );
}

/** Non-throwing variant for surfaces mounted outside the console shell (e.g. /admin, which
 *  deliberately skips the dashboard snapshot fetch — see app/admin/layout.tsx). Callers must
 *  treat `null` as "this context has no account data available", not as "no data yet" (that
 *  distinction matters: a section that reads `snapshot` through this hook has to say so
 *  honestly rather than rendering the ordinary "nothing here" empty state a real snapshot's
 *  absence of rows would produce). */
export function useConsoleDataOptional(): ConsoleData | null {
  const store = useContext(ConsoleStoreContext);
  const snapshot = useConsoleSelection(selectConsoleSnapshot);
  const status = useConsoleSelection(selectConsoleStatus);
  const stream = useConsoleSelection(selectConsoleStream);
  const actions = useConsoleSelection(selectConsoleActions);
  if (!store) return null;
  return {
    snapshot: snapshot ?? null,
    fetchedAt: status?.fetchedAt ?? null,
    loading: status?.loading ?? false,
    retrying: status?.retrying ?? false,
    slowFirstLoad: status?.slowFirstLoad ?? false,
    error: status?.error ?? null,
    sessionExpired: status?.sessionExpired ?? false,
    online: status?.online ?? true,
    stream: stream ?? UNSUPPORTED_STREAM,
    refresh: actions?.refresh ?? (async () => {})
  };
}

/* ── The provider ───────────────────────────────────────────────────────── */

export function ConsoleDataProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ConsoleStore | null>(null);
  if (storeRef.current === null) storeRef.current = new ConsoleStore(initialConsoleState());
  const store = storeRef.current;

  // Route-aware freshness (audit #5). The profile is read at EVENT time, not
  // captured at subscribe time, so navigating between routes never re-opens
  // the EventSource.
  const pathname = usePathname();
  const profile = useMemo(() => routeDataProfile(pathname), [pathname]);
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // Mirrors sessionExpired but readable synchronously inside callbacks (state updates are async),
  // so refresh()/backgroundRefresh() can refuse to start another fetch against a session that is
  // already known dead — once the redirect is underway there is nothing left to poll for.
  const sessionExpiredRef = useRef(false);
  // True while runLoop is actively attempting (including its own immediate deadline retries). Only
  // consumed for the no-snapshot case, where it separates "still fetching" from "stopped trying".
  const [isVisible, setIsVisible] = useState(
    typeof document !== "undefined" ? document.visibilityState === "visible" : true
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleVis = () => setIsVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handleVis);
    return () => document.removeEventListener("visibilitychange", handleVis);
  }, []);
  const inFlight = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const queuedRefresh = useRef<number | null>(null);
  // Set when a background trigger (SSE event, poll interval, tab becoming visible) arrives while a
  // fetch is already in flight. Consumed once that fetch settles, to run exactly one more
  // (coalesced) fetch instead of a fresh abort-and-refetch per trigger — see backgroundRefresh below.
  const pendingBackgroundRefresh = useRef(false);
  // Explicit refresh() calls that arrived while a fetch was already running. Released when that
  // fetch (and the one follow-up it queued) settles, so await refresh() still sees the new snapshot
  // without aborting the request that is already on the wire.
  const refreshWaiters = useRef<Array<{ resolve: () => void; seenAttempt: number }>>([]);
  const attemptRef = useRef(0);
  // When the last POLL tick actually fired. The interval runs at the base rate
  // (POLL_MS); a route whose profile asks for a longer cadence simply skips
  // the ticks that fall inside its window.
  const lastPollAtRef = useRef(0);
  const releaseRefreshWaiters = useCallback((finishedAttempt?: number) => {
    if (finishedAttempt == null) {
      const waiters = refreshWaiters.current.splice(0);
      for (const waiter of waiters) waiter.resolve();
      return;
    }
    const split = refreshWaitersReadyForAttempt(refreshWaiters.current, finishedAttempt);
    refreshWaiters.current = split.waiting;
    for (const waiter of split.ready) waiter.resolve();
  }, []);

  // Returns "deadline" when THIS attempt was killed by our own FETCH_DEADLINE_MS timer (distinct
  // from "aborted", which means something else — an explicit refresh() — superseded it). Callers
  // use that distinction to decide whether to retry immediately.
  const runFetch = useCallback(async (controller: AbortController): Promise<"ok" | "deadline" | "aborted" | "error"> => {
    const deadline = window.setTimeout(() => controller.abort(DEADLINE_REASON), FETCH_DEADLINE_MS);
    try {
      const data = await fetchDashboard<DashboardSnapshot>(controller.signal);
      if (!mounted.current || controller.signal.aborted) return "aborted";
      store.setState({
        snapshot: data,
        fetchedAt: new Date(),
        error: null,
        slowFirstLoad: false
      });
      return "ok";
    } catch (err) {
      if (controller.signal.aborted) {
        if (controller.signal.reason !== DEADLINE_REASON) return "aborted";
        // Surface the hung attempt as a refresh error before runLoop retries, so the freshness UI
        // stops calling a stale snapshot "fresh". A successful retry clears this via error: null.
        if (mounted.current) {
          store.setState((prev) => ({ error: prev.error ?? DEADLINE_ERROR_MESSAGE }));
        }
        return "deadline";
      }
      if (err instanceof DOMException && err.name === "AbortError") return "aborted";
      if (!mounted.current) return "error";
      // A 401 is not "refresh failing — showing last good data": the session is gone, not
      // slow. fetchDashboard already kicked off the redirect to /login (api.ts); this only
      // needs to stop the loop from retrying against a dead session and tell the shell to stop
      // presenting the stale snapshot as live for whatever window the navigation takes.
      if (err instanceof ConsoleApiError && err.status === 401) {
        sessionExpiredRef.current = true;
        store.setState({ sessionExpired: true, error: SESSION_EXPIRED_MESSAGE });
        return "error";
      }
      store.setState({
        error: err instanceof ConsoleApiError ? err.message : "Could not refresh data."
      });
      return "error";
    } finally {
      window.clearTimeout(deadline);
    }
  }, [store]);

  // Shared retry loop used by BOTH refresh() and backgroundRefresh(). A caller that finds a request
  // already in flight marks one follow-up instead of aborting it. Each iteration runs one attempt
  // with a fresh AbortController and then decides whether to run another:
  //  - "deadline": THIS attempt hung past FETCH_DEADLINE_MS and was self-aborted — retry immediately
  //    with a fresh connection. This fires once per attempt (never once per SSE event), so it cannot
  //    resurrect the abort-storm that queueRefresh/pendingBackgroundRefresh exist to prevent.
  //  - otherwise: retry only if a background trigger (SSE/poll/visibility) arrived and coalesced
  //    while this attempt was running (pendingBackgroundRefresh) — this also means a trigger that
  //    lands mid-refresh() is drained before refresh()'s own promise resolves, instead of waiting
  //    for the next independent trigger.
  const runLoop = useCallback(async (foreground = false) => {
    if (mounted.current) store.setState({ fetching: true });
    // Every exit path below must clear `fetching`, EXCEPT the "superseded" one — there the newer
    // loop that replaced us is still running and owns the flag, so clearing it here would falsely
    // report "stopped trying" and drop the shell onto the error card mid-fetch.
    const stop = () => { if (mounted.current) store.setState({ fetching: false }); };
    // Tracks consecutive deadline timeouts for exponential backoff — reset to 0 on any non-deadline
    // result so the backoff only applies to repeated hung attempts.
    let consecutiveDeadlines = 0;
    for (;;) {
      if (!mounted.current) {
        releaseRefreshWaiters();
        return;
      }
      // If a 401 was detected mid-iteration (sessionExpiredRef set to true by runFetch), halt
      // immediately — there is nothing left to poll for against a dead session.
      if (sessionExpiredRef.current) {
        stop();
        releaseRefreshWaiters();
        return;
      }
      attemptRef.current += 1;
      const finishedAttempt = attemptRef.current;
      const controller = new AbortController();
      inFlight.current = controller;
      const result = await runFetch(controller);
      if (inFlight.current !== controller) {
        releaseRefreshWaiters();
        return; // superseded by a newer refresh()/backgroundRefresh()
      }
      inFlight.current = null;
      if (result === "deadline") {
        releaseRefreshWaiters();
        consecutiveDeadlines += 1;
        // An AWAITED foreground refresh() must not stay pending across retries: several mutation
        // flows `await refresh()` before clearing their busy state, and a persistently hung
        // /api/dashboard would otherwise wedge those toasts/`finally` blocks forever. The deadline
        // error is already surfaced by runFetch, so hand the immediate retry to a detached
        // background loop and let this foreground promise resolve. (A background trigger arriving
        // meanwhile still coalesces via pendingBackgroundRefresh — the detached loop drains it.)
        if (foreground) {
          // The detached loop takes over and sets `fetching` itself, so do NOT stop here.
          void runLoop(false);
          return;
        }
        // Exponential backoff: 1s * 2^(consecutiveDeadlines-1) capped at 30s, plus ±20% jitter.
        // This prevents a tight spin-loop hammering a degraded backend every 35s.  After 5+
        // consecutive deadlines the delay is ~16-30s between retries rather than near-zero.
        const backoffMs = Math.min(1_000 * Math.pow(2, consecutiveDeadlines - 1), 30_000);
        const jitter = backoffMs * (0.8 + Math.random() * 0.4);
        await new Promise<void>((res) => window.setTimeout(res, jitter));
        continue;
      }
      consecutiveDeadlines = 0;
      // A refresh() that joined an earlier attempt is ready now. One that joined this
      // attempt waits for the follow-up, so it does not resolve on the pre-mutation snapshot.
      releaseRefreshWaiters(finishedAttempt);
      if (pendingBackgroundRefresh.current) {
        pendingBackgroundRefresh.current = false;
        continue;
      }
      stop();
      releaseRefreshWaiters();
      return;
    }
  }, [releaseRefreshWaiters, runFetch, sessionExpiredRef, store]);

  // Explicit foreground refresh: the initial load and every user action/mutation (approve/reject,
  // place/cancel an order, save a setting, etc. — everything callers pull `refresh` from
  // useConsoleActions() for). A second call while a request is already running does not abort it.
  // Aborting here used to leave the server working on the cancelled request and start another,
  // so one page load stacked overlapping snapshot computes. The in-flight response is kept, one
  // follow-up is queued, and this promise resolves when that follow-up settles. A deadline still
  // resolves it immediately so a hung snapshot cannot wedge the caller.
  const refresh = useCallback(async () => {
    if (sessionExpiredRef.current) return;
    if (inFlight.current) {
      pendingBackgroundRefresh.current = true;
      const seenAttempt = attemptRef.current;
      await new Promise<void>((resolve) => {
        refreshWaiters.current.push({ resolve, seenAttempt });
      });
      return;
    }
    pendingBackgroundRefresh.current = false;
    await runLoop(true);
  }, [runLoop]);

  // Background refresh: SSE events, the poll interval, and tab-visibility resync. Must NEVER abort
  // an in-flight fetch — that abort-storm was the root cause of the console taking minutes to
  // first-paint: during an active scan, SSE market-data/run-complete events (and the poll interval)
  // fire every few seconds, so the slow initial fetch kept getting killed and restarted before it
  // could ever finish, until a quiet gap happened to appear. If a fetch is already in flight, just
  // mark that a refresh was requested and let it finish (or hit its own deadline) — runLoop above
  // drains that flag on its own once the in-flight attempt settles, coalescing any number of
  // triggers that arrived in the meantime into a single extra fetch.
  const backgroundRefresh = useCallback(async () => {
    if (sessionExpiredRef.current) return;
    if (inFlight.current) {
      pendingBackgroundRefresh.current = true;
      return;
    }
    await runLoop();
  }, [runLoop]);

  const queueRefresh = useCallback(() => {
    if (typeof window === "undefined") return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (queuedRefresh.current) window.clearTimeout(queuedRefresh.current);
    queuedRefresh.current = window.setTimeout(() => {
      queuedRefresh.current = null;
      void backgroundRefresh();
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [backgroundRefresh]);

  // Leaving a "light" route (one that ignores market-data pushes) for a full
  // one: the snapshot on screen may be a poll interval old, because the light
  // route let the market data go stale. Refetch on the transition instead of
  // carrying that staleness into the route that displays prices — the chrome
  // (market session state, scan stamps) would otherwise be out of date for up
  // to one poll interval. The first render never fires this (the previous
  // cadence equals the current one).
  const previousPollMsRef = useRef(profile.pollMs);
  useEffect(() => {
    const previous = previousPollMsRef.current;
    previousPollMsRef.current = profile.pollMs;
    if (profile.pollMs < previous) void backgroundRefresh();
  }, [profile, backgroundRefresh]);

  // The action slice is stable for the life of the store, so publishing it
  // once here is enough — subscribers to `actions` never re-render.
  useEffect(() => {
    store.setState({ refresh });
  }, [store, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      // Skip the tick while a request is in flight, and after a slow response, instead of
      // queueing another snapshot on top of the one the browser is still waiting for.
      if (shouldSkipDashboardPoll()) return;
      // Route-aware cadence (audit #5): the interval ticks at the base rate, and a
      // route that asks for a longer cadence skips the ticks inside its window.
      const now = Date.now();
      if (now - lastPollAtRef.current < profileRef.current.pollMs) return;
      lastPollAtRef.current = now;
      void backgroundRefresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void backgroundRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (queuedRefresh.current) clearTimeout(queuedRefresh.current);
      inFlight.current?.abort();
      releaseRefreshWaiters();
    };
  }, [backgroundRefresh, refresh, releaseRefreshWaiters]);

  // First-load slow notice: while no snapshot has arrived, arm a timer; if it fires the load is
  // running long, so let the shell say so UNDER the animation. This deliberately does not touch
  // `error` — see FIRST_LOAD_SLOW_NOTICE_MS above for why setting it here was the false-failure bug.
  // A successful fetch clears it (runFetch sets slowFirstLoad: false), and `deriveConsoleLoadState`
  // ignores it entirely once a snapshot is in hand. The timer still checks that no snapshot has
  // landed before it writes, so a fast first load does not notify every status subscriber with a
  // flag the load state would only mask.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (store.getState().snapshot === null) store.setState({ slowFirstLoad: true });
    }, FIRST_LOAD_SLOW_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [store]);

  useEffect(() => {
    const sync = () => store.setState({ online: navigator.onLine });
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, [store]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      store.setState({ stream: UNSUPPORTED_STREAM });
      return;
    }
    if (!isVisible) {
      // Prevent background tabs from exhausting the HTTP connection pool. The cleanup of the
      // previous run already closed the EventSource; reflect that in the stream health instead
      // of leaving it stuck at "live" while disconnected.
      store.setState((prev) => ({
        stream: prev.stream.status === "unsupported" ? prev.stream : { ...prev.stream, status: "reconnecting" }
      }));
      return;
    }
    store.setState((prev) => ({ stream: { ...prev.stream, status: "connecting" } }));
    const events = new EventSource("/api/events/stream");

    const markConnected = () => {
      if (!mounted.current) return;
      const now = new Date();
      store.setState({
        stream: {
          ...store.getState().stream,
          status: "live",
          connectedAt: now,
          lastErrorAt: null
        }
      });
    };

    const markEvent = (type: string) => {
      if (!mounted.current) return;
      const now = new Date();
      const previous = store.getState().stream;
      // The stream HEALTH always records the event — the freshness strip shows
      // "Push market-data 3s ago" and that must keep working on every route.
      store.setState({
        stream: {
          ...previous,
          status: "live",
          connectedAt: previous.connectedAt ?? now,
          lastEventAt: now,
          lastEventType: type,
          lastErrorAt: null
        }
      });
      // The DATA refresh is route-scoped: a route that displays no market data
      // ignores market-data pushes instead of re-fetching the whole snapshot
      // (audit #5). Nothing a route displays can change because of an event it
      // has declared irrelevant.
      if (!profileRef.current.relevantEvents.has(type)) return;
      queueRefresh();
    };

    const refreshTypes = ["ready", "run-complete", "order", "proposal", "dirty", "market-data", "pending-learned-change"] as const;
    const handlers = refreshTypes.map((type) => {
      const handler = () => markEvent(type);
      events.addEventListener(type, handler);
      return { type, handler };
    });

    events.onopen = markConnected;
    events.onerror = () => {
      if (!mounted.current) return;
      const previous = store.getState().stream;
      store.setState({
        stream: {
          ...previous,
          status: previous.status === "unsupported" ? "unsupported" : "reconnecting",
          lastErrorAt: new Date()
        }
      });
    };

    return () => {
      for (const { type, handler } of handlers) events.removeEventListener(type, handler);
      events.close();
    };
  }, [queueRefresh, isVisible, store]);

  return <ConsoleStoreContext.Provider value={store}>{children}</ConsoleStoreContext.Provider>;
}
