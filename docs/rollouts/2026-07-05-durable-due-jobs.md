# 2026-07-05 - durable-due-jobs

## Summary

Adds a durable, generic claimable due-jobs substrate (`due_jobs` table + `src/lib/db-jobs.ts`) so
15m/1h intraday outcome-horizon sampling survives process downtime instead of depending on a
strategy run coincidentally landing inside the narrow sampling window. Wires it into the two
places a decision case / skipped-candidate counterfactual establishes an entry basis
(`counterfactual-learning.ts`'s `insertSkippedCounterfactualCandidate` insert sites, and
`outcome-engine.ts`'s `measureCase` once a placed/blocked/rejected case's fill or ref-price basis
resolves), adds a new worker (`drainDueIntradaySampleJobs`) that drains due jobs by sampling a
live quote and writing through the exact same merge/write path the existing inline
`samplableNow` sampling path uses, and adds one fire-and-forget drain call to `scheduler.ts`'s
`tick()`. The existing inline path is left fully intact — this is belt-and-suspenders, not a
replacement.

## Why

`src/lib/outcome-horizons.ts:22-29` documented the gap explicitly: intraday horizons are
resolvable only by sampling a live quote while the tolerance window is open, and no substrate
guaranteed that sampling would ever be attempted except by accident (a strategy run's cadence
happening to fall inside a 15m-45m or 1h-2h window after a fill/ref-price snapshot).
`matureSocraticDecisionOutcomes` (the only caller of the intraday sampling logic) runs only
piggybacked inside `runStrategyOnce` (`strategy.ts:1420-1428`); `counterfactual-learning.ts`
shares the same gap. The existing `mobile_commands` queue (migration v8, `mobile-api.ts`) is the
closest precedent for a durable job queue in this codebase, but it has no lease/reclaim: a
crashed `running` row is stuck forever. This substrate explicitly avoids copying that gap by
adding `claimed_by` + `lease_expires_at` with atomic stale-lease reclaim, following the CAS idiom
already used by `acquireStrategyLock` (`db-execution.ts`) and the scheduler lease
(`scheduler-lease.ts`).

### Design decisions

- **New migration (v11) rather than an unversioned `migrate()` addition** — `due_jobs` is a brand
  new table with no legacy-data backfill concern, so it goes in the versioned `MIGRATIONS` array
  (the pattern `db.ts`'s own comments say to prefer for new schema changes going forward), not the
  baseline `migrate()` exec block.
- **Enqueue-at-basis-establishment, not enqueue-at-case-creation.** For a "placed" decision case,
  the entry basis is the FILL price/time, which is not known at `upsertSocraticDecisionCase` time
  (fills land later via async broker reconciliation) — enqueueing there would either fabricate a
  basis or require a second wiring point. Instead, jobs are enqueued from `outcome-engine.ts`'s
  `measureCase`, the one place in the codebase that already resolves `basisPrice`/`basisAtMs`
  honestly for every case shape (placed-with-fill, blocked/rejected-with-counterfactual,
  blocked/rejected-with-daily-close-fallback). For skipped-candidate counterfactuals, the basis
  (`refPrice` + `snapshotAt`) IS known immediately at insert time, so those are enqueued straight
  from `counterfactual-learning.ts`'s two insert call sites
  (`recordRejectedProposalCounterfactual`, `ingestSignalSnapshot`).
- **Idempotent by construction, not by caller discipline.** `enqueueDueJob` is `INSERT OR IGNORE`
  on `UNIQUE(job_type, dedupe_key)`, with `dedupe_key = "<caseKind>:<caseId>:<horizon>"`. This
  means `measureCase` can safely call the enqueue helper on every pass for a case (it does) without
  ever creating a duplicate row, and a case re-established (e.g. after a schema oddity) can't fork
  into two competing jobs for the same horizon.
- **No duplicate horizon rows when both the inline path and the worker fire.** `mergeHorizonRows`
  already had "existing terminal row wins" semantics; its doc comment was strengthened to say
  explicitly which side wins when both the inline `samplableNow` sampling in `measureCase` and the
  due-jobs worker race for the same horizon: whichever WRITES (persists) first wins, and the other
  reads that persisted row as already-terminal via a fresh DB read (`readExistingOutcomes`) and
  short-circuits with an `"already_resolved"` job-complete, never re-pricing or overwriting.
- **Counterfactual outcome rows need a new low-level writer.** The existing
  `markSkippedCounterfactualMatured` / `markSkippedCounterfactualUnresolvable` writers require an
  exit bar / terminal reason the due-jobs worker doesn't have — sampling one intraday horizon
  doesn't close the whole counterfactual. Added `updateSkippedCounterfactualOutcomes` (db-learning.ts),
  gated the same way (`status = 'pending'`) so it's a harmless no-op once the row has gone terminal.
- **Fire-safe enqueues.** Both enqueue call sites wrap `buildIntradaySampleJobSpecs` +
  `enqueueDueJob` in try/catch with a `console.warn` — a due-jobs failure can never break the
  counterfactual/decision-case pipelines that call it.
- **Retry/backoff semantics in `failDueJob`.** A failed claimed job returns to `pending` with
  `due_at` pushed out by `retryBackoffMs` (default 10 minutes) unless `attempts >= maxAttempts`
  (default 5) or the job is already past its `not_after` deadline, either of which makes it
  terminally `unresolvable` — mirroring the "kill-survivorship" convention the rest of the outcome
  engine already uses (never left pending forever, always countable).

## Files

- `src/lib/db.ts` — new migration v11 (`due_jobs` table + indexes); barrel re-export of
  `db-jobs.ts`.
- `src/lib/db-jobs.ts` (new) — `enqueueDueJob`, `claimDueJobs`, `completeDueJob`, `failDueJob`,
  `markDueJobUnresolvable`, `getDueJobStats`.
- `src/lib/outcome-horizons.ts` — `buildIntradaySampleJobSpecs` (pure spec builder, no I/O);
  strengthened `mergeHorizonRows` doc comment to document which side wins on a race.
- `src/lib/outcome-engine.ts` — `measureCase` now enqueues intraday sample jobs once a case's
  basis resolves; new `drainDueIntradaySampleJobs` worker + its helpers
  (`enqueueIntradayDecisionSampleJobs`, `parseIntradaySampleJobPayload`, `readExistingOutcomes`,
  `writeIntradaySampleRow`).
- `src/lib/counterfactual-learning.ts` — `enqueueIntradaySampleJobs` helper called from
  `recordRejectedProposalCounterfactual` and `ingestSignalSnapshot` after a successful insert.
- `src/lib/db-learning.ts` — `skippedCounterfactualId` (single-sourced id format, exported so
  callers can derive it without a re-read) and `updateSkippedCounterfactualOutcomes` (new
  low-level, pending-gated outcome writer for the intraday worker).
- `src/lib/scheduler.ts` — one fire-and-forget `drainDueIntradaySampleJobs()` call in `tick()`,
  next to the existing `processPendingMobileCommands` call.
- `test/db-jobs.test.ts` (new) — 10 tests covering the queue mechanics.
- `test/outcome-engine-due-jobs.test.ts` (new) — 5 tests covering the enqueue + worker + no-dup
  integration.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — updated per the
  handoff protocol.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/db-jobs.test.ts test/outcome-engine-due-jobs.test.ts` — 15/15 passed.
- `npx vitest run test/db-jobs.test.ts test/outcome-engine-due-jobs.test.ts test/outcome-engine.test.ts test/counterfactual-learning.test.ts test/rejected-counterfactual.test.ts test/performance.test.ts test/per-account-policy-isolation.test.ts` —
  72/72 passed (confirms no regression in the pipelines this change touches).
- `npx vitest run test/db-migration-old-schema.test.ts test/scheduler-lease.test.ts test/scheduler-cadence.test.ts test/persistence-hardening.test.ts test/socratic-db.test.ts test/socratic-memory.test.ts test/socratic-runtime.test.ts` —
  28/28 passed (migration framework + scheduler + Socratic case-file paths unaffected).
- Full `npm test` and `npm run build` were **not** run in this worktree per this branch's
  operating rules (the central landing operator runs those before merge).

## Follow-ups

- The due-jobs table is intentionally generic (`job_type` column), not intraday-sampling-specific —
  a future job type (e.g. a deferred notification retry, or a scheduled re-check) can reuse
  `db-jobs.ts` without another migration.
- `drainDueIntradaySampleJobs` claims globally across all users (like the real scheduler tick,
  and like `processPendingMobileCommands`) rather than per-user — this matches the existing
  single-process scheduler model in this codebase and was validated in tests by asserting on the
  specific case's row rather than aggregate drain counts (multiple tests' due-jobs coexist in the
  same DB `due_jobs` table by design, since `claimDueJobs` has no user-scoping and shouldn't need
  one at this stage).
- No admin/ops UI surfaces `getDueJobStats` yet; it's available for a future receipts/ops-snapshot
  addition but isn't wired into `/api/ops/snapshot` in this change (out of scope — this lane owns
  the substrate + outcome-engine wiring only, per the task's KEEPOUT on `app/console/**`).
- `updateSkippedCounterfactualOutcomes`'s pending-only guard means an intraday sample that arrives
  AFTER the counterfactual has already gone terminal (matured/unresolvable) is a silent no-op by
  design (the terminal row's `outcomes` are owned by whichever writer closed it) — this mirrors the
  existing `markSkippedCounterfactualChecked`/`markSkippedCounterfactualMatured` gating and was not
  treated as a bug to fix in this pass.
- **Pre-existing, unrelated to this change:** `test/account-deletion-coverage.test.ts` currently
  fails on this branch because the `due_jobs` table (added by this same commit) is not yet wired
  into `DELETE_TABLES_BY_USER_ID` / the account-deletion coverage allowlist. Confirmed via
  `git stash` that the failure exists at `4b105e5a` before any review-fix commit — it is not caused
  by the fixes below. Flagged as a separate follow-up task rather than folded into this PR's
  otherwise-precise fix list.

## Review fixes

A second pass (still on this branch, second commit — HEAD `4b105e5a` untouched/not amended) applied
7 previously-diagnosed review findings, no other scope:

1. **Lost-update race (BLOCKER).** `measureCase` builds `outcome.outcomes` from a pass-start
   snapshot and holds it across awaits; `processDueOutcomes`'s wholesale write could erase a
   worker-sampled 15m/1h row written concurrently by `drainDueIntradaySampleJobs`, even though the
   job had already reported done. Fixed by re-merging against a FRESH read of the persisted row
   immediately before every terminal/partial write:
   - `writeSocraticDecisionOutcome` (`db-socratic.ts`) now re-reads `existing` (already did, for the
     upsert) and sets `outcome.outcomes = mergeHorizonRows(existing.outcome?.outcomes,
     outcome.outcomes)` before persisting.
   - `markSkippedCounterfactualMatured` and `markSkippedCounterfactualUnresolvable`
     (`db-learning.ts`) now do a fresh `SELECT outcomes` (new helper
     `readPersistedCounterfactualOutcomes`) and re-merge the same way before their UPDATEs.
   - `mergeHorizonRows`'s existing-terminal-row-wins semantics make this idempotent regardless of
     write order (first persisted terminal row always survives).
   - Regression tests: `test/socratic-db.test.ts` (writer-level, decision case) and
     `test/counterfactual-learning.test.ts` (writer-level, both matured and unresolvable paths) —
     each persists a worker-written 15m row, then calls the writer with a stale `outcomes` array
     missing that row, and asserts the row survives alongside the caller's own new row.
2. **Claimant-fenced terminal transitions.** `completeDueJob`/`failDueJob`/`markDueJobUnresolvable`
   (`db-jobs.ts`) previously updated `WHERE id = ?` only, so a stale/lease-expired worker could
   resurrect a job another worker had already reclaimed/completed/failed. All three now require
   `AND status = 'claimed' AND claimed_by = ?claimant`, take an explicit `claimant` parameter, and
   return a boolean/status reflecting whether THIS call's row actually transitioned (silently
   ignorable by callers when the fence holds and nothing happened). Call sites in
   `drainDueIntradaySampleJobs` (`outcome-engine.ts`) thread the worker's own `claimant` id through.
   New test in `test/db-jobs.test.ts`: a `done` job cannot be mutated back to pending/done/
   unresolvable by a different claimant through any of the three functions.
3. **Receipt honesty.** The drain receipt's `failed` counter (really "errored this pass, mostly
   retried") collided in name with `getDueJobStats().failed` — a status value nothing ever
   produces. Renamed the drain counter to `erroredRetried`
   (`DrainDueIntradaySampleJobsResult.erroredRetried`), removed the dead `'failed'` value from
   `DueJobStatus` (`db-jobs.ts`) and the v11 `CHECK` constraint (`db.ts`; migration is unreleased on
   this branch so editing in place is safe), and updated `DueJobStats` to drop the `failed` field.
   `failDueJob`'s unknown-id fallback (previously `return "failed"`) now returns `"unresolvable"`
   since `"failed"` is no longer a valid `DueJobStatus`. Updated the one test assertion that read
   `result.failed`.
4. **+5. Exact counterfactual lookup, no more `caseId.split(":")`.** The due-jobs worker
   (`drainDueIntradaySampleJobs`'s `readExistingOutcomes`/`writeIntradaySampleRow`) previously
   parsed `caseId.split(":")` to recover `(ownerUserId, runId, symbol)` and joined via
   `getSkippedCounterfactualByRunSymbol`, which always picks `min(horizon_days)` — silently matching
   the wrong row whenever a run/symbol pair has more than one horizon-day config. Fixed by carrying
   `runId` and (for counterfactual jobs) `horizonDays` as explicit fields in the job payload from
   both enqueue sites (`outcome-engine.ts`'s `enqueueIntradayDecisionSampleJobs`,
   `counterfactual-learning.ts`'s `enqueueIntradaySampleJobs`, threaded through
   `buildIntradaySampleJobSpecs` in `outcome-horizons.ts`), adding a new exact-match lookup
   `getSkippedCounterfactualByRunSymbolHorizon(userId, runId, symbol, horizonDays)`
   (`db-learning.ts`), and deleting the string-splitting entirely. A counterfactual job payload
   missing `runId`/`horizonDays` (e.g. a pre-fix job surviving a deploy) is now treated as malformed
   in `parseIntradaySampleJobPayload` rather than silently falling back to a fuzzy match.
5. **Doc-only.** `enqueueDueJob`'s docstring now says "idempotent ONLY when `dedupeKey` is
   provided" — SQLite's `UNIQUE` constraint treats every `NULL` as distinct, so repeated calls with
   no `dedupeKey` insert a new row each time.

### Files (review-fixes commit)

- `src/lib/db-socratic.ts` — write-time re-merge in `writeSocraticDecisionOutcome`.
- `src/lib/db-learning.ts` — write-time re-merge in `markSkippedCounterfactualMatured` /
  `markSkippedCounterfactualUnresolvable` (+ new `readPersistedCounterfactualOutcomes` helper); new
  `getSkippedCounterfactualByRunSymbolHorizon` exact-match lookup.
- `src/lib/db-jobs.ts` — claimant-fenced `completeDueJob`/`failDueJob`/`markDueJobUnresolvable`;
  `DueJobStatus` union and `DueJobStats` drop `'failed'`; `enqueueDueJob` docstring qualifier.
- `src/lib/db.ts` — v11 `CHECK` constraint drops `'failed'`.
- `src/lib/outcome-engine.ts` — `drainDueIntradaySampleJobs` threads `claimant` through all three
  terminal-transition calls; `erroredRetried` rename; `IntradaySampleJobPayload` carries
  `runId`/`horizonDays`; `readExistingOutcomes`/`writeIntradaySampleRow` use the exact-match lookup
  instead of `caseId.split(":")`.
- `src/lib/outcome-horizons.ts` — `IntradaySampleJobSpec`/`buildIntradaySampleJobSpecs` carry
  `runId`/`horizonDays` through to the payload.
- `src/lib/counterfactual-learning.ts` — `enqueueIntradaySampleJobs` and both call sites
  (`recordRejectedProposalCounterfactual`, `ingestSignalSnapshot`) pass `runId`/`horizonDays`.
- `test/db-jobs.test.ts` — updated all `failDueJob`/`completeDueJob`/`markDueJobUnresolvable` calls
  for the new `claimant` parameter; new claimant-fencing regression test.
- `test/outcome-engine-due-jobs.test.ts` — updated the one `result.failed` assertion to
  `result.erroredRetried`.
- `test/socratic-db.test.ts`, `test/counterfactual-learning.test.ts` — new Finding-1 write-time
  re-merge regression tests.

### Verification (review-fixes commit)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/db-jobs.test.ts test/outcome-engine-due-jobs.test.ts
  test/outcome-engine.test.ts test/counterfactual-learning.test.ts test/socratic-db.test.ts
  test/rejected-counterfactual.test.ts` — 6 files, 33/33 passed.
- `npm run lint` — 0 errors (pre-existing grandfathered warnings only, none new from these files).
- `npm run build` — succeeds.
- `npm test` (full suite) — 2529/2530 passed; the 1 failure
  (`test/account-deletion-coverage.test.ts`) is pre-existing at `4b105e5a` (confirmed via
  `git stash`), unrelated to these 7 findings, and tracked as a separate follow-up above.

6. **Drift-guard fix (third commit).** Added `due_jobs` to `DELETE_TABLES_BY_USER_ID`
  (`src/lib/account-deletion.ts`) so account deletion now cleans up the user's due-jobs rows,
  resolving the `test/account-deletion-coverage.test.ts` failure noted above as a follow-up —
  `npx tsc --noEmit` clean; `test/account-deletion-coverage.test.ts` + `test/db-jobs.test.ts` +
  `test/outcome-engine-due-jobs.test.ts` — 18/18 passed.
