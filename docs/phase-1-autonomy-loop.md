# Phase 1 Spec — Autonomy Loop

**Historical implementation spec.** This was the original Phase 1 handoff for a
fresh implementation session. The core scheduler, run lock, market-session state,
and dashboard controls now exist; keep this file as design history and use
`STATUS.md` plus current code as the live source of truth before changing the
autonomy path.

Current hardening gaps: market holidays ARE now modeled via `getMarketHolidays()`
in `src/lib/market-hours.ts` (the Phase 1 documented limitation is resolved).
Scheduler behavior is local single-process, and any dev-server `EMFILE` watcher
issue is operational rather than a strategy-loop feature gap.

2026-07-21 hardening note: the LLM provider cooldown planner preserves the invariant that a
non-empty Green/Red failover chain never becomes empty when every lane is cooling, including
all-billing cooldowns. A manual billing/credit fix can therefore recover on the next run instead
of waiting out the cooldown TTL.

2026-10-15 broker-call bounds (Linear ST-2570): every broker read and write has a deadline and
an abort signal, order listings are page-capped and row-capped, and quote batches are chunked.
The scheduler launches stops, stale exits, and fill reconcile for every eligible account before
it awaits that account's health probe, so one hung probe cannot delay the next account's
protection.  A hung read releases the stop and exit in-flight guards.  A broker write that has
already started keeps its guard so the next tick cannot send it twice.  A strategy run whose
health probe or pre-decision snapshot never returns is finished `failed` with a timeout summary.
An abort that lands after the stop is claimed, and before `placeEquityOrder`, reverts that claim
and keeps the attempt id, so the position is not left `triggered` until the 15-minute re-arm grace.

## Objective

Make `policy.enabled` actually drive autonomous strategy runs on a schedule, safely:
- A background scheduler calls `runStrategyOnce()` at a configurable cadence when autonomy
  is enabled, the kill switch is off, and the US market is open.
- A run lock guarantees no two runs (scheduled or manual) overlap.
- The `strategy_run` audit event is written for **every** run path, not just the HTTP route.
- The dashboard shows scheduler state (next run, runs today, cadence control).

## Background / current state

- `runStrategyOnce()` lives in `src/lib/strategy.ts`. It is only ever called by
  `app/api/strategy/run/route.ts`, which **also** writes `audit("strategy_run", result)`.
  That audit write must move into the lib so the scheduler path records it too.
- `app/api/strategy/enable/route.ts` sets `enabled: true`; `pause/route.ts` sets
  `enabled: false`. Nothing consumes `enabled`.
- Policy is a single JSON blob in the `settings` table (`src/lib/db.ts` `getPolicy`/
  `setPolicy`, defaults in `src/lib/defaults.ts`, type in `src/lib/types.ts`).
- `package.json` has `"type": "module"`, Next 15.5, React 19. No `next.config.*` and no
  `instrumentation.ts` exist yet. Next 15 instrumentation is stable (no experimental flag).
- The dashboard auto-refreshes `/api/dashboard` every 30s (`app/dashboard-client.tsx`).

## Tasks

### 1. Move the audit write into the domain function

In `src/lib/strategy.ts`, at the **end** of `runStrategyOnce()` (both the success return
and the `catch` path), call `audit("strategy_run", result)` before returning, where
`result` is the `StrategyResult` being returned. Import `audit` from `./db` (already
imported in that file).

Then in `app/api/strategy/run/route.ts`, **remove** the now-duplicate
`audit("strategy_run", result)` line (keep everything else). Verify the audit is written
exactly once per run.

### 2. New policy fields

In `src/lib/types.ts`, add to `TradingPolicy`:

```ts
runCadenceMinutes: number;        // how often the scheduler runs while enabled
runDuringExtendedHours: boolean;  // if true, also run during pre/post market
```

In `src/lib/defaults.ts`, add to `DEFAULT_POLICY`:

```ts
runCadenceMinutes: 60,
runDuringExtendedHours: false,
```

`getPolicy()` already spreads `DEFAULT_POLICY` over stored values, so existing rows pick up
the new defaults automatically — no migration needed.

### 3. Market-hours helper

Create `src/lib/market-hours.ts`:

```ts
// Returns the current US market session in America/New_York time.
// Regular session: Mon–Fri 09:30–16:00 ET. Extended: 04:00–09:30 and 16:00–20:00 ET.
// Note: does NOT account for market holidays in this phase (documented limitation).
export type MarketSession = "closed" | "regular" | "pre" | "post";

export function currentMarketSession(now = new Date()): MarketSession { /* ... */ }

// True if a run is allowed now given the extended-hours preference.
export function isRunAllowedNow(runDuringExtendedHours: boolean, now = new Date()): boolean {
  const s = currentMarketSession(now);
  if (s === "regular") return true;
  if (runDuringExtendedHours && (s === "pre" || s === "post")) return true;
  return false;
}
```

Implementation notes:
- Compute ET wall-clock via `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
  hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" })` and parse parts.
  Do **not** rely on the server's local timezone.
- Weekend (Sat/Sun ET) → `"closed"`.
- Add a unit test `test/market-hours.test.ts` (vitest) covering: a Wednesday 10:00 ET →
  `regular`; Wednesday 08:00 ET → `pre`; Wednesday 18:00 ET → `post`; Saturday → `closed`;
  and `isRunAllowedNow(false, ...)` false during pre/post but true during regular.
  Construct deterministic inputs by passing a fixed UTC `Date` that maps to the intended ET
  time (account for the offset; add a comment).

### 4. Run lock

Add a lock so overlapping runs cannot double-count daily limits. Use a DB-backed lock in
the `settings` table (survives across the scheduler and HTTP route, which share one
process but this is the robust choice).

In `src/lib/db.ts` add:

```ts
// Returns true if the lock was acquired. Stale locks older than staleMs are reclaimed.
export function acquireStrategyLock(staleMs = 5 * 60_000, now = new Date()): boolean
export function releaseStrategyLock(): void
```

Implementation:
- Store JSON `{ lockedAt: ISO }` under settings key `strategy_run_lock` (use the existing
  `getSetting`/`setSetting`, or write directly — but note `setSetting` emits a
  `policy_change` audit event, which is noisy for a lock; prefer a direct prepared
  statement that does NOT audit).
- `acquireStrategyLock`: read current lock; if absent or `now - lockedAt > staleMs`, write
  the lock and return true; else return false.
- `releaseStrategyLock`: delete the `strategy_run_lock` settings row.
- This is single-process so a simple read-then-write is acceptable; wrap acquire in a
  `better-sqlite3` transaction (`db.transaction(...)`) to be safe.

In `src/lib/strategy.ts` `runStrategyOnce()`:
- At the very top (before `insertStrategyRun`), `if (!acquireStrategyLock()) return { runId:
  "", status: "failed", summary: "A strategy run is already in progress.", proposals: [] };`
  — and do **not** write a strategy_run audit for the lock-rejected case, and do **not**
  create a strategy_runs row. (Return early before any DB writes.)
- Wrap the rest of the body so `releaseStrategyLock()` runs in a `finally`.

### 5. Scheduler (instrumentation)

Create `instrumentation.ts` at the **project root** (sibling of `package.json`). Next 15
calls the exported `register()` once per server process at startup.

```ts
export async function register() {
  // Only run in the Node.js server runtime, never edge/browser.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();
}
```

Create `src/lib/scheduler.ts`:

- Module-level `let timer: NodeJS.Timeout | null = null;` and `let lastRunAt: string | null`
  and `let nextRunAt: string | null` (exported via a `getSchedulerState()` accessor).
- `startScheduler()`: guard against double-start (`if (timer) return`). Use a **fixed short
  tick** (e.g. every 60s) rather than a long `setInterval` tied to cadence, so cadence and
  enabled-state changes take effect without a restart. Each tick:
  1. `const policy = getPolicy();`
  2. If `!policy.enabled || policy.killSwitch || !policy.accountNumber` → set
     `nextRunAt = null`, return.
  3. If `!isRunAllowedNow(policy.runDuringExtendedHours)` → return (market closed).
  4. If `lastRunAt` and `now - lastRunAt < runCadenceMinutes * 60_000` → return (not due
     yet); keep `nextRunAt = lastRunAt + cadence`.
  5. Otherwise: `lastRunAt = now`; `await runStrategyOnce()` (it writes its own audit and
     respects the run lock); set `nextRunAt = now + cadence`. Wrap in try/catch so a thrown
     error never kills the timer.
- Use `.unref()` on the timer so it doesn't hold the process open in dev.
- 2026-08-31:  a whole-tick in-flight guard must not skip lease renew / lastTick / Sentry
  forever.  `startScheduler()` also starts a 15s watchdog (2-minute budget, generation token)
  that unwedges a hung `tickInner`; Sentry Crons opens `in_progress` and closes `ok`/`error`.
  See `docs/rollouts/2026-08-31-hung-scheduler-tick-watchdog.md`.
- Export `getSchedulerState(): { lastRunAt: string | null; nextRunAt: string | null }`.

**Dev caveat to document in code:** Next dev with HMR may call `register()` more than once
across reloads; the `if (timer) return` guard plus module caching makes this safe in
practice. In production (`next start`) it runs once.

### 6. Surface scheduler state

- In `src/lib/dashboard.ts` `getDashboardSnapshot()`, add `scheduler:
  getSchedulerState()` and `marketSession: currentMarketSession()` to the returned object.
- In `app/dashboard-client.tsx`:
  - Extend the `Snapshot` type with `scheduler?: { lastRunAt: string | null; nextRunAt:
    string | null }` and `marketSession?: string`.
  - In the status grid, add readouts: market session (e.g. "Market: regular") and
    "Next run: HH:MM" (or "—" when paused/closed).
  - In the Risk/Controls area, add a cadence control: a `NumberField` (component already
    exists) bound to `runCadenceMinutes` and a toggle for `runDuringExtendedHours`, both
    persisted via the existing `updatePolicy(...)`.

## Out of scope for Phase 1

- Market holiday calendar (documented limitation in `market-hours.ts`).
- Order fill reconciliation (Phase 3).
- Multi-process / serverless scheduling (this app is single-process local).

## Acceptance criteria

These criteria describe the original implementation target. Re-verify them when
touching scheduler, lock, market-hours, or dashboard runtime controls.

- [ ] With `ROBINHOOD_ADAPTER=mock`, enabling autonomy and setting cadence to 1 minute
      causes `runStrategyOnce()` to fire automatically during a simulated open session;
      `strategy_runs` rows and a `strategy_run` audit event appear without clicking
      "Run Once".
- [ ] Pausing autonomy or tripping the kill switch stops scheduled runs within one tick.
- [ ] Two near-simultaneous runs (e.g. manual click during a scheduled run) never both
      proceed — the second returns "already in progress".
- [ ] The `strategy_run` audit is written exactly once per executed run (grep the audit
      feed; no duplicates, none missing).
- [ ] Outside market hours (and with extended hours off), no scheduled runs occur.
- [ ] `npm test` passes, including the new `market-hours` tests.
- [ ] `npm run build` succeeds (instrumentation compiles).
- [ ] Dashboard shows market session and next-run time; cadence + extended-hours controls
      persist across refresh.

## Verify (run the app)

```bash
npm install
npm run dev   # boot; confirm scheduler logs once
```

Then in the UI (mock adapter): select the mock account, set an allowlist, enable autonomy,
set cadence to 1 min, and confirm runs appear in Run History on their own. Also run
`npm test` and `npm run build`.
