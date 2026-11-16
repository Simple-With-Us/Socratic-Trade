# 2026-08-13 — Litestream remote inventory: durable cross-instance cache (PR #2665's monitor was structurally blind)

## 1. Context & Objective

`docs/rollouts/2026-08-12-backup-tier-monitor-real-coverage.md` (PR #2665) replaced the
zero-coverage "unknown" tier monitor with a two-source design: level 0 read locally, levels
1/2/3/9 read from a scheduled remote-replica inventory collected by
`src/lib/litestream-remote-inventory.ts`.  That note's own "Next Steps" section predicted
`checks.storage.litestreamTierCoverage.observed` would reach `5` "up to 30 minutes in."  It
never did — production kept reporting `remoteInventoryState: "missing"` indefinitely, which
forces levels 1/2/3/9 back to `not-observable` / `remote-inventory-missing` forever.  This PR
fixes that regression so the monitor PR #2665 shipped actually reports.

## 2. Changes Made

### Root cause (re-confirmed against live evidence before touching code)

Read-only `task_journal` query against production (2026-08-13): the `litestream-remote-inventory`
scheduler lane logged **932 runs in 24h, 0 errors**, max duration 68,422ms, with 32 runs slower
than 3s (real B2 listings) — the collector genuinely works and the internal 30-minute gate is
firing correctly (932 ticks / ~63s cadence, only 32 real collections ≈ every 30 min).  Yet
`getLitestreamRemoteInventory()` returned null/undefined to every `/api/health` request the
entire time — the only way `remoteInventoryState` becomes `"missing"` (a failed/skipped
collection surfaces as `"failed"`/`"skipped"` instead, since `refreshLitestreamRemoteInventoryIfDue`
always assigns a snapshot on those paths too).

The cause: `cachedInventory` was a **module-level variable**, and the file's own comment claimed
"`next start` serves the scheduler and every API route from one process, so the reader and the
writer are the same [instance]."  That is false under Next's build: the scheduler (reached via
`instrumentation.ts`'s `register()`) and the API route handlers get **separate instantiations**
of `litestream-remote-inventory.ts`, each with its own `cachedInventory` binding, even though
both run inside the same OS process.  The writer's assignment and the reader's lookup were never
the same variable.

### The fix

`src/lib/litestream-remote-inventory.ts` now persists the snapshot through
`src/lib/db-durable-state.ts` (the existing `durable_state` table / `getDurableStateValue` /
`setDurableStateValue` / `deleteDurableStateValue` primitives — no new table, no migration):

- `getLitestreamRemoteInventory()` reads the durable row on every call (source of truth for
  every module instance / process on the box). Falls back to the in-process `cachedInventory`
  only if the durable read itself throws (e.g. a momentary DB error) or the row is genuinely
  absent.
- `refreshLitestreamRemoteInventoryIfDue()` (the scheduler entry point) persists through a new
  internal `persistLitestreamRemoteInventory()` helper on every successful collection.  A
  **thrown** collection still does not call it, preserving the pre-existing "don't wipe a
  previous good snapshot on a total failure" behavior exactly as before.
- `setLitestreamRemoteInventoryCache()` (the pre-existing test/refresh seam) now routes through
  the same helper, so tests that prime a snapshot get the identical durable-write behavior
  production code uses — no parallel code path to drift out of sync.
- The file's header comment claiming reader/writer share one process instance is corrected in
  place (not just deleted) — it now explains what is actually true, cites the production
  evidence above, and documents the one behavioral consequence: a snapshot now **survives a
  process restart** instead of resetting to "not collected yet."  That is intentional (the app
  auto-deploys on every merge to `main`, so restarts are frequent — resetting to "missing" on
  every deploy would recreate this exact production symptom) and never shown as fresher than
  reality: `assessLitestreamTierFreshness`'s existing `LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS`
  (90 min) ages any snapshot out into `remote-inventory-stale` regardless of source.
- Honest-state design is unchanged: a tier with no usable signal still reports
  `state: "not-observable"` with a machine-readable `reason` — nothing is fabricated.

### `lastAttemptAtMs` (the 30-minute collection gate) — deliberately left in-memory

This is the one piece of module-level state NOT moved to durable storage.  Reasoning, documented
in a code comment at the call site (`refreshLitestreamRemoteInventoryIfDue`):

- `refreshLitestreamRemoteInventoryIfDue` is only ever invoked from `src/lib/scheduler.ts`'s
  `tick()`, which itself is only ever called by the single `setInterval(tick, TICK_MS)` that
  `startScheduler()` registers once at process boot.  Node's `setInterval` keeps calling the
  exact same closure — over the exact same module instance's `lastAttemptAtMs` /
  `cachedInventory` bindings — for the entire life of the process.  There is no second writer
  instance for this cadence gate to ever lose track of.
- The production evidence above already proves this holds: 932 ticks / 24h, but only 32 real
  (multi-second, B2-listing) collections — exactly the 30-minute cadence, which is only possible
  if `lastAttemptAtMs` survived every one of those 932 ticks correctly in memory.
- The cross-instance problem is specific to code that other module instances must observe.
  Route handlers never call `refreshLitestreamRemoteInventoryIfDue` and have no need to see
  `lastAttemptAtMs` at all — only the snapshot itself needs to cross instances, which is exactly
  what moved.
- Making it durable would add a DB round trip to every ~60s tick for zero correctness benefit,
  and risks the opposite failure: a debounced/delayed durable write not yet visible by the next
  tick could make the gate re-fire far more often than every 30 minutes — turning ~430 B2 LIST
  calls/day (this file's own cost estimate) into potentially tens of thousands, which costs real
  money and hammers the replica. Not worth the risk for a gate that is already provably correct.

### Files touched

- `src/lib/litestream-remote-inventory.ts` — durable persistence for the snapshot; corrected
  header comment; `lastAttemptAtMs` durability reasoning documented in place.
- `test/litestream-remote-inventory.test.ts` — `beforeAll` now sets a per-run temp
  `DATABASE_URL` (the module touches `durable_state` now); two new tests under
  "cross-module-instance durability (the production bug)" using `vi.resetModules()` +
  fresh `await import(...)` to force genuinely independent module instances (the same
  technique `test/trigger-durability.test.ts` uses for a different durable-state consumer) —
  one round-trips a primed snapshot across instances, the other runs a real
  `refreshLitestreamRemoteInventoryIfDue()` collection through a fake `litestream` binary and
  asserts a **fresh reader instance** sees `remoteInventoryState: "ok"` (not `"missing"`) and
  every non-level-0 tier grades `"known"`. Both were confirmed to FAIL against the pre-fix code
  (see Verification State below) — pre-existing tests (collector unit tests, `not-observable`
  reason coverage) are unchanged.

No changes were needed to `app/api/health/route.ts`, `app/api/admin/backup-status/route.ts`,
`src/lib/runtime-health.ts`, `test/runtime-health.test.ts`,
`test/connection-health-routing.test.ts`, or `test/backup-status-route.test.ts` —
`getLitestreamRemoteInventory()` keeps its existing synchronous signature, so every caller is
unaffected. `test/runtime-health.test.ts`'s coverage of `assessLitestreamTierFreshness` and its
`not-observable` reasons is a pure-function suite that takes `remoteInventory` as a direct
parameter and never calls `getLitestreamRemoteInventory()`, so it needed no DB setup and was
re-run unmodified to confirm it still passes.

## 3. Decisions & Trade-offs

- **Static top-level import of `db-durable-state.ts`, not the dynamic `await import("./db")`
  pattern already used in this file for `databasePath()`.** Considered dynamic import for
  consistency, but `scheduler.ts` (the only place that pulls this module into a webpack graph
  per the file's own header comment) already statically imports `./db` directly for many other
  functions, so `db.ts` (and therefore `db-durable-state.ts`) is unavoidably part of that bundle
  regardless of what this file does — there was no bundling risk to avoid. A static import also
  keeps `getLitestreamRemoteInventory()` synchronous, so no caller in `app/api/health/route.ts`
  or `app/api/admin/backup-status/route.ts` needed to change.
- **No in-memory read-through cache on the read path.** `getLitestreamRemoteInventory()` reads
  `durable_state` on every call rather than caching for N seconds. A single indexed SQLite
  `SELECT` via better-sqlite3 (synchronous, sub-millisecond) is cheap enough at `/api/health`'s
  request volume that the correctness risk of a cache going stale wasn't worth taking on. The
  in-memory `cachedInventory` that remains is a same-process fallback for a failed DB read, not
  a performance optimization — see the task's explicit permission for "an in-memory read-through
  cache... fine as an optimisation but MUST NOT be the source of truth"; this implementation
  simply doesn't need one to be fast enough.
- **`lastAttemptAtMs` stays in-memory.** Full reasoning above — production evidence shows the
  in-memory gate already works correctly, because the writer side never suffers the
  multi-instance problem the reader side had.
- **Reused the existing `setLitestreamRemoteInventoryCache` test seam as the one production write
  path too**, via a shared internal `persistLitestreamRemoteInventory` helper, rather than adding
  a second, parallel persistence call in `refreshLitestreamRemoteInventoryIfDue`. One code path
  writing the durable row means tests exercise the exact same logic production uses.
- **No new migration.** `durable_state (namespace, key, value, updated_at)` already exists in
  `db.ts`'s baseline `migrate()`; this just adds a new `(namespace: "litestream", key:
  "remote-inventory")` row under it, the same pattern `src/lib/durable-state.ts`'s
  `createDurableMap` callers already use for other cross-restart state.

## 4. Verification State

Worktree `/Users/jay/apps/trading-monet-inventory`, branch `monet/durable-inventory-cache`, node
24 pinned (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`; default homebrew node is v26 and
mass-fails the suite on a better-sqlite3 ABI mismatch — confirmed `node --version` reports
`v24.19.0` for every gate run below).

```
npx tsc --noEmit
```
Clean, no output.

```
npm test
```
`Test Files  566 passed | 1 skipped (567)` / `Tests  6569 passed | 51 skipped (6620)`. The one
skipped file and 51 skipped tests are pre-existing (unrelated to this change). Duration 667.76s.

Targeted pre-check before the full suite, run twice to prove the new tests are load-bearing:

```
npx vitest run test/litestream-remote-inventory.test.ts
```
With the fix: **19/19 passed.**  With `src/lib/litestream-remote-inventory.ts` reverted via
`git stash` (test file kept, i.e. running the new tests against the pre-fix source): **17
passed, 2 failed** — both new tests under "cross-module-instance durability (the production
bug)" failed exactly as expected:
- `a snapshot written by one module instance is visible to a completely separate module
  instance`: `expected null to deeply equal {...}` (the fresh reader instance's `cachedInventory`
  was still `null`).
- `a real scheduler collection persisted by the writer makes remoteInventoryState 'ok' (not
  'missing') for a fresh reader instance`: `expected undefined to be 'ok'` (the fresh reader
  instance never saw the collected snapshot at all).

Every pre-existing test in the file (collector unit tests, config resolution, cache round-trip)
passed unmodified in both runs. Also ran together to confirm no cross-file regression:
```
npx vitest run test/litestream-remote-inventory.test.ts test/backup-status-route.test.ts \
  test/connection-health-routing.test.ts test/runtime-health.test.ts
```
73/73 passed.

```
npm run build
```
Succeeds — full Next.js production build, all routes compiled (including every
`/api/health`/`/api/admin/backup-status` consumer of this module).

```
npm run lint
```
`0 errors, 764 warnings` — the grandfathered backlog (`@typescript-eslint/no-explicit-any`,
etc.) noted in AGENTS.md. Confirmed zero warnings from either touched file
(`src/lib/litestream-remote-inventory.ts`, `test/litestream-remote-inventory.test.ts`).

## 5. Next Steps & Blockers

1. After merge/auto-deploy, confirm production `checks.storage.litestreamTierCoverage.observed`
   actually reaches a non-zero value within ~30 minutes and `remoteInventoryState` leaves
   `"missing"` — the exact outcome PR #2665's own rollout note predicted and that never
   materialized. Read-only: query `GET /api/health` or `GET /api/admin/backup-status`.
2. The underlying wedged-compaction ops question from PR #2665 (whether levels 1/2/3 have
   resumed advancing) is still open and unrelated to this fix — this PR only repairs the
   monitor's ability to report, not backup health itself.

## 6. Zero-Code Findings

- Confirmed via `task_journal` (read-only) that the collector itself has been reliable the whole
  time this bug existed: 932 runs/24h, 0 errors, correct 30-minute internal cadence. The entire
  defect was on the read side.
- `assessLitestreamTierFreshness`'s staleness handling (`LITESTREAM_REMOTE_INVENTORY_MAX_AGE_SECONDS`,
  90 minutes) needed no changes — it already ages out a snapshot regardless of where it came
  from, which is exactly the property that makes durable, restart-surviving persistence safe
  rather than a way to show frozen numbers as live.
