/** What the console shell should show before/while the first dashboard snapshot arrives.
 *
 *  Split out of the provider as a pure function purely so it can be tested: the repo's vitest
 *  setup is node-only (no jsdom / testing-library), so a rule living inside a React hook is
 *  unreachable by tests — and this particular rule shipped WRONG to production for exactly that
 *  reason. See `deriveConsoleLoadState` below. */

export type ConsoleLoadState =
  /** No snapshot yet, still working on it. Show the candlestick load screen. */
  | "loading"
  /** Same as "loading", but past the slow threshold — add a reassurance line. Still NOT a failure. */
  | "slow"
  /** No snapshot and nothing in flight: the load genuinely failed. Show the error card. */
  | "failed"
  /** A snapshot is in hand; staleness/refresh errors are the freshness strip's business, not this. */
  | "ready";

export interface ConsoleLoadInput {
  hasSnapshot: boolean;
  /** Last fetch error, if any. On its own this does NOT mean the load failed — see below. */
  error: string | null;
  /** An attempt is in flight right now (including a deadline-triggered immediate retry). */
  fetching: boolean;
  /** The first-load slow timer has fired. */
  slowElapsed: boolean;
}

/** The rule that matters: **an error while a fetch is still in flight is not a failure.**
 *
 *  The console used to flip to a full-screen "Couldn't load the autonomy desk" card the moment
 *  `error` was non-null. Two things set `error` during a perfectly healthy slow load — a 15s
 *  first-load watchdog, and the 35s per-attempt deadline that aborts and *immediately retries* —
 *  so a first load that took longer than 15s (routine: the server's broker chain is sequential
 *  and self-bounded at ~24s) showed a failure screen while the request was still running and
 *  about to succeed. The native iOS client hits the same `getDashboardSnapshot` through
 *  /api/mobile/snapshot but simply waits, which is why it loaded fine at the same moment the
 *  website "failed" — the split was never server-side.
 *
 *  So: only report "failed" once nothing is in flight to rescue it. */
export function deriveConsoleLoadState(input: ConsoleLoadInput): ConsoleLoadState {
  if (input.hasSnapshot) return "ready";
  if (input.fetching) return input.slowElapsed ? "slow" : "loading";
  if (input.error !== null) return "failed";
  // No snapshot, no error, nothing in flight: the very first attempt hasn't started yet (the
  // provider's mount effect runs after first paint). That is loading, not failure.
  return "loading";
}
