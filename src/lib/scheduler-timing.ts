// scheduler-timing.ts — shared scheduler watchdog + leader-lease timing source.
//
// The leader-lease TTL and the tick-watchdog budget used to be two independent
// literals (TTL 90s in scheduler-lease.ts, watchdog 120s in scheduler.ts), so a
// tick body that pinned the event loop (sync SQLite) also pinned the same-process
// setInterval that renews the lease: the lease expired at 90s while the watchdog
// still considered the tick alive until 120s, and a second process during deploy
// overlap could steal leadership mid-tick. Deriving the default TTL from the
// effective watchdog budget here pins the relationship by construction: a live
// leader inside its watchdog budget cannot lose the lease to TTL arithmetic.
// A stale leader still loses leadership once the (finite) TTL passes with no
// renewal. Kept import-free so scheduler.ts and scheduler-lease.ts can both use
// it without a scheduler -> scheduler-lease -> scheduler cycle (same pattern as
// process-instance.ts).

/** Default wall-clock budget for one tick body before the watchdog unwedges. 2 minutes is under
 *  `/api/health` schedulerStale (5 min) and the Sentry checkinMargin (5 min) so autopilot can
 *  resume before those pages. Override with SCHEDULER_TICK_WATCHDOG_MS. */
export const DEFAULT_TICK_WATCHDOG_MS = 120_000;

/** Watchdog poll cadence; also the leader-lease renewal cadence while a tick is in flight. */
export const TICK_WATCHDOG_POLL_MS = 15_000;

/** Grace added on top of the effective watchdog budget to form the default lease TTL.
 *  One 60s tick interval: four watchdog polls of headroom after the budget, so renewal
 *  (every TICK_WATCHDOG_POLL_MS, and at every 60s tick start) stays comfortably inside
 *  the TTL even if the event loop was pinned for the whole watchdog budget. */
export const LEASE_TTL_GRACE_MS = 60_000;

/** Default leader-lease TTL when neither SCHEDULER_LEASE_TTL_MS nor
 *  SCHEDULER_TICK_WATCHDOG_MS is set: watchdog budget + grace (180s). */
export const DEFAULT_LEASE_TTL_MS = DEFAULT_TICK_WATCHDOG_MS + LEASE_TTL_GRACE_MS;

/** Effective tick-watchdog budget: SCHEDULER_TICK_WATCHDOG_MS when finite and > 0, else default. */
export function schedulerTickWatchdogLimitMs(): number {
  const v = Number(process.env.SCHEDULER_TICK_WATCHDOG_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TICK_WATCHDOG_MS;
}

/**
 * Effective leader-lease TTL. An explicit, valid SCHEDULER_LEASE_TTL_MS wins untouched
 * (operator preference, even if it re-opens the gap this derivation closes). Otherwise
 * the TTL is derived from the effective watchdog budget plus grace, so raising
 * SCHEDULER_TICK_WATCHDOG_MS alone can never silently make the TTL shorter than the
 * budget again.
 */
export function schedulerLeaseTtlMs(): number {
  const raw = process.env.SCHEDULER_LEASE_TTL_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return schedulerTickWatchdogLimitMs() + LEASE_TTL_GRACE_MS;
}
