# 2026-07-10 — Durable state: make in-memory rate-limiters/cooldowns survive a restart

## Summary

Auto-deploy went live fleet-wide today (every merge to `main` now redeploys `socratic-trade-prod`
immediately, replacing the running container mid-session). This surfaced a real gap: several
in-memory rate-limiter/circuit-breaker/cooldown Maps existed specifically to bound a real external
cap or prevent a real duplicate financial action, but reset to empty on every process restart —
silently re-granting a budget/cooldown a redeploy has no business handing out.

Per owner directive ("persist all variables/counts... have that be the standard... for all things"),
built ONE shared write-behind SQLite-backed persistence primitive (`createDurableMap`, in
`src/lib/durable-state.ts`) and used it to make every genuinely-at-risk in-memory guard survive a
restart, after a full-codebase discovery sweep to find them all.

## Discovery (multi-modal sweep, 32 candidate sites)

A 4-way parallel workflow swept: (1) the already-known provider-rate-limit/AV-key-pool/circuit-
breaker family, (2) scheduler/notifications/congress-share/order-replacement/synthetic-stops, (3)
LLM/red-team/model-rotation, (4) a broad grep for module-level `Map`/counter patterns app-wide.
Verified two of its conclusions directly rather than trusting them blind: `twelveDataWindowStartByCred`
(flagged as still-existing dead code) had actually already been removed by the earlier unified-quota
PR; and `congress-share.ts`'s `refSentAt` got contradictory verdicts from two sweep agents — read the
actual code/comments and confirmed it's genuinely idempotent-safe (low priority, not high-risk).

**Persisted (real consequence if reset):**
- `provider-rate-limit.ts`'s `RequestQuota.hits` — tracks REAL server-side rate caps (twelvedata
  8/min+800/day, tiingo 50/hour+1000/day). A restart re-granting a burned budget risks real 429s/
  throttling. *(This was the one already flagged before this sweep — see the 2026-07-10 unified-quota
  rollout note.)*
- `usage-budget.ts`'s `alertSentAt` — was the ONE alert-cooldown in the codebase using a bare
  in-memory Map while every sibling (`db-health.ts`, `usage-limit-alerts.ts`,
  `broker-minimum-guard.ts`, `vector-db.ts`) already persists via `getInternalSetting`/
  `setInternalSetting`. An inconsistency, not a deliberate choice — fixed to match.
- `congress-share.ts`'s `refSentAt` — the per-symbol 6h send throttle. Low priority (App A's import
  endpoint is idempotent — worst case of losing this is redundant, harmless network calls), persisted
  anyway for completeness now that the primitive exists (`debounced` flush; no financial/safety risk
  either way).

**Superseded by independent parallel work found during rebase (dropped from this PR):**
- `order-replacement.ts`'s double-sell cooldown — while this branch was in flight, another agent
  landed a full rewrite of the stale-exit remediation flow onto a durable, transactionally-safe
  `order_replacements` table (resumable `cancel_requested → cancel_confirmed → replacement_claiming →
  replacement_submitted → replacement_confirmed` state machine, with an in-SQL check-and-insert guard
  using the same 5-minute window). It supersedes my `recentlyRemediatedExits` durable Map outright —
  the whole in-memory cooldown/in-flight-lock approach (including `inFlightMarketReplaces`) is gone
  from that file now, replaced by a DB row that was never in-memory to begin with. Deferred to it;
  dropped my wiring and the test I'd added for it (redundant with that table's own coverage).
- `triggers.ts`'s hourly/daily caps + dedup — another agent independently landed a more complete
  durable design (`DURABLE_TRIGGER_STATE_KEY`/`DurableMaterialTriggerState`, via `getDb()` directly)
  that persists not just the caps/dedup counters but the WHOLE pending-event queue with claim/retry
  semantics (`claimOwner`/`claimExpiresAtMs`/`retryAfterMs`) — strictly more complete than my
  caps-only design, which explicitly chose not to persist buffered events. Deferred to it; dropped my
  wiring and tests entirely.

Both were caught by diffing every touched file against `origin/main` before merging (all 6 files this
branch modifies had also changed upstream during the time this work was in flight) rather than
force-pushing a stale branch over newer work — see the cherry-pick-based rebase note below.

**Deliberately left as bare in-memory `Map`/`Set` (confirmed correct, not persisted):**
- `ProviderRateLimiter`'s pacer state (`provider-rate-limit.ts`) — in-process burst/concurrency
  pacing; a fresh process correctly starting at 0 in-flight IS the right post-restart state.
- Alpha Vantage key-pool's sticky `currentIndex` rotation pointer — the `exhaustedUntil` half (the
  part that actually matters) is ALREADY durable via `getInternalSetting`; only the round-robin
  starting point resets, which is harmless.
- `api-circuit-breaker.ts`'s `trippedUntil` — a thin in-process cache in front of the durable
  `api_health_log` table; the very next call re-derives real lane health from that table regardless.
- In-flight locks/dedup Sets tied to live async operations (`scheduler.ts`'s
  `stopMonitorInFlight`/`staleExitInFlight`, `data-providers.ts`'s `secXbrlInFlight`,
  `vector-db.ts`'s `indexInitPromises`) — persisting these would resurrect stale locks that can never
  be released, the opposite of correct. (`order-replacement.ts`'s equivalent lock was removed
  entirely by the superseding rewrite noted below — there is no longer an in-memory lock there at all.)
- `congress-trade-events.ts`'s `seenIds`, `rate-limit.ts`'s HTTP-request buckets,
  `usage-monitor-push.ts`'s call-volume telemetry — dedup/rate-limit windows whose correct
  post-restart state is empty, or pure metrics with no external cap behind them.
- `model-rotation.ts` — already durable via `getInternalSetting`/`setInternalSetting`; checked
  directly since its name was the most obvious candidate, confirmed no gap.

## The primitive (`src/lib/durable-state.ts`)

`createDurableMap<T>(namespace, { flush })` — a `Map`-shaped drop-in (`get`/`set`/`delete`/`has`/
`clear`/`entries`/`keys`/`size`) backed by a new generic `durable_state(namespace, key, value,
updated_at)` SQLite table (CRUD in `src/lib/db-durable-state.ts`, migration in `db.ts`).

- **Hydrate once per namespace** on first touch (reads all rows for that namespace into an
  in-memory cache — the source of truth for reads thereafter).
- **`"debounced"` flush (default)**: writes batch and flush ~15s after the last write, or on
  `SIGTERM`/`SIGINT`/`beforeExit`. Right for anything checked/updated frequently — no per-call DB
  latency on the hot path.
- **`"immediate"` flush**: synchronous write-through on every `set`/`delete`. Right for low-frequency
  call sites where losing the last write to an ungraceful crash matters more than the write cost
  (used for the order-remediation double-sell guard).
- All module state (cache, hydration flags, pending writes, the shutdown-hook-registered flag) is
  **globalThis-pinned**, mirroring the pattern already used by `order-replacement.ts`/
  `congress-share.ts`/`triggers.ts`/`scheduler.ts` — needed so Next.js HMR (dev) and vitest's
  per-test-file module isolation don't spawn duplicate `process.once("SIGTERM", ...)` registrations
  (caught via a `MaxListenersExceededWarning` during test development — fixed before landing).

`RequestQuota` (provider-rate-limit.ts) stays a pure, DB-agnostic, unit-testable class (unchanged
constructor/API); the module-level singleton (`admitProviderRequests`/`refundProviderRequests`/
`resetProviderQuotaState`) owns hydration/persistence via `getLane`/`restoreLane` snapshot methods,
gated on `durable-state.ts`'s own `hasHydratedNamespace()` (not a second, parallel flag) so a test's
`resetDurableStateCacheForTests()` is the single source of truth for "forget everything and
re-hydrate," matching every other call site.

## Files

- New: `src/lib/durable-state.ts`, `src/lib/db-durable-state.ts`, `test/durable-state.test.ts`.
- `src/lib/db.ts` — `durable_state` table in `migrate()`; barrel re-export.
- `src/lib/provider-rate-limit.ts` — `RequestQuota.getLane`/`restoreLane`; module-level hydrate/
  persist wiring; `simulateProviderQuotaRestartForTests()` test seam.
- `src/lib/congress-share.ts`, `src/lib/usage-budget.ts` — swapped the relevant bare `Map` for
  `createDurableMap`.
- Tests: `test/durable-state.test.ts` (14, primitive-level: Map API, restart survival, flush modes,
  clear, namespace isolation, corrupt-row handling) + restart-survival tests added to
  `test/provider-rate-limit.test.ts`, `test/congress-share.test.ts`, `test/usage-budget.test.ts`.
- `order-replacement.ts`/`triggers.ts` changes were dropped during rebase — see "Superseded" above.

## Rebase note (~158-commit upstream drift)

This branch was cherry-picked (checkpoint commit `9db6c15e`) onto a fresh `origin/main` rather than
merged, because every one of the 6 files it touches had ALSO changed upstream while it was in flight
(`db.ts` alone had 16 upstream commits). Two of those (`order-replacement.ts`, `triggers.ts`) turned
out to be full supersessions, not just nearby edits — resolved by reading the upstream implementation
in each case before deciding, not by mechanically keeping "both sides."

## Verification

This branch started life as a completely fresh worktree checkout — `node_modules` didn't exist at
all. `npm ci` (with `NODE_AUTH_TOKEN=$(gh auth token)`) built `better-sqlite3` against the Mac's
default node26; rebuilt (`npm rebuild better-sqlite3`) to match `.nvmrc`'s pinned node24 before any
gate ran. Every command below ran under `/opt/homebrew/opt/node@24/bin` on PATH:

- `npm run lint` → 0 errors (489 grandfathered warnings — grew from 377 alongside `main`'s own
  158-commit drift since the earlier unified-quota PR; not this change's debt)
- `npx tsc --noEmit` → clean
- `npx vitest run --maxWorkers=4` → **383/383 files, 4420/4420 tests passed** (first full run caught
  the two real bugs below; confirmed clean after both fixes)
- `npm run build` → succeeded (its own TypeScript pass clean; static pages generated)

### Two real bugs caught by the first full-suite run (both fixed before landing)

1. **Circular-import TDZ crash**: `ReferenceError: Cannot access 'host' before initialization` in
   `durable-state.ts`'s `registerShutdownFlushOnce`. Root cause: `provider-rate-limit.ts`,
   `congress-share.ts`, and `usage-budget.ts` each called `createDurableMap(...)` at MODULE TOP
   LEVEL — and since `durable-state.ts` sits deep in the same import graph these modules are
   themselves imported from (`data-providers.ts` → `provider-rate-limit.ts` → `durable-state.ts` →
   `db-durable-state.ts` → `db.ts`'s barrel), a module evaluating while `durable-state.ts`'s own
   top-level `const host = ...` hadn't run yet could call back into it and hit the TDZ. Fixed by
   converting all three to lazy singletons (`function quotaStore() { return instance ??=
   createDurableMap(...); }`) — constructed on first real call instead of at import time, which
   sidesteps the whole class of import-order hazards since every module has finished loading by
   then.
2. **Hydration crashing tests with an incomplete `./db` mock**: `test/milestone-4-challenger.test.ts`
   (an unrelated, pre-existing FMP/Finnhub cache-poisoning test) mocks `../src/lib/db` without
   `getDb` — previously fine, since `admitProviderRequests` was pure in-memory. Once it started
   hydrating from SQLite via `getDb()`, that mock broke it. Fixed by wrapping
   `durable-state.ts`'s hydration read in a try/catch (matching the write path's existing
   best-effort philosophy: a durable-state read/write must never crash a caller that never intended
   to exercise persistence).

Targeted retest of every file either bug touched (`test/durable-state.test.ts`,
`test/provider-rate-limit.test.ts`, `test/final-size-red-autonomous.test.ts`,
`test/milestone-4-challenger.test.ts`, `test/congress-share.test.ts`, `test/usage-budget.test.ts`) —
151/151 green — before the full-suite re-confirmation above.

## Follow-ups

- None known. The remaining scope (RequestQuota, usage-budget alert cooldown, congress-share ref
  throttle) is bounded to guards with a real external-cap or real consistency consequence;
  deliberately-ephemeral state was left alone per the discovery sweep's per-site reasoning above.
</content>
</invoke>
