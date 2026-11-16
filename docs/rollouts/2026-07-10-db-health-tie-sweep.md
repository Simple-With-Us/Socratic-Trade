# 2026-07-10 — db-health.ts `ORDER BY ts DESC` tie-sweep

**Author:** CLAUDE (sonnet engineer agent) · **Branch:** `claude/db-health-tie-sweep`

## Summary
Swept the remaining `ts`-tie hazards in `src/lib/db-health.ts`. One query (the `getServiceHealthLog`
read, line ~311/321) already ordered `ORDER BY ts DESC, rowid DESC` — landed earlier as a
test-stability fix (`a21015f2 fix(test-stability): tiebreak health-log newest-first by rowid, not
the randomUUID id`). Seven other reads in the same file still ordered by `ts DESC` alone. `ts` is
ms-resolution ISO-8601 text; same-millisecond writes to `api_health_log` (a plausible burst under
load — the circuit breaker and error-pattern updates fire on every `logApiHealth` call) made those
seven reads nondeterministic: absent a tiebreaker, SQLite resolves ties by original scan/insertion
order (ascending rowid — i.e. **oldest-first**, the opposite of "newest N rows").

Most consequential of the seven: `getLaneHealth`'s `last5` query (line ~44), which feeds the
"5 consecutive failures" circuit-breaker trip (`HEALTH_REASON_CONSECUTIVE_FAILURES`). A same-ms
burst of health writes could silently pick the *oldest* 5 rows in the tied window instead of the
newest 5, which can flip the breaker's trip/no-trip verdict depending on which failures happen to
land in that stale window — deterministically wrong, not just imprecise.

## Why
Same file already carries the exact idiom and an explanatory comment (line ~292) for why `rowid`
(not `id`, a `randomUUID` with no ordering relationship to insertion) is the correct tiebreaker.
The remaining seven sites were simply not swept when that fix landed. This closes the gap so every
`ts DESC` read against `api_health_log` in this file is deterministic.

## Fix
Added `, rowid DESC` (matching the line-311 idiom exactly) to all 7 remaining `ORDER BY ts DESC`
sites — all against `api_health_log` (a plain rowid table; confirmed via the `CREATE TABLE`
statement in `src/lib/db.ts`, no `WITHOUT ROWID`, no view/aggregate involved):

- `getLaneHealth` (lines 44/47/50): `last5` (consecutive-failure window), `lastSuccess`,
  `lastFailure`.
- `logApiHealth`'s FIFO-cap `DELETE` subquery (line 142): `SELECT id ... ORDER BY ts DESC LIMIT 500`
  that decides which 500 rows to *keep* per (service, key_source) lane — a same-ms tie at the
  500-row boundary could non-deterministically evict a newer row instead of an older one.
- `getServiceHealthSummaries` (lines 221/229/256): `lastSuccess`, `lastFailure`, `last5`.

Queries ordering by `service` (`listHealthLanes`, `listHealthServices`) and by `last_seen` on the
unrelated `api_health_error_patterns` table were left untouched — out of scope (different table,
no `ts`-tie hazard raised by this sweep; `api_health_error_patterns` ties are resolved by its own
`UNIQUE(service, fingerprint, key_source)` upsert, not a `ts`-ordered read of individual rows).

## Files
- `src/lib/db-health.ts` — 7 `ORDER BY ts DESC` → `ORDER BY ts DESC, rowid DESC`.
- `test/api-circuit-breaker.test.ts` — new `describe("ts-tie tiebreaker — same-millisecond
  api_health_log rows")` block, two tests:
  - Inserts 7 rows directly (bypassing `logApiHealth`, which always stamps the current wall-clock
    time) with an **identical** `ts` and a known insertion order — 2 successes then 5 failures.
    Asserts `getLaneHealth` reports `stoppedWorking: true` with the consecutive-failure reason,
    which only holds if the *last 5 inserted* rows (all failures) are read, not the *first 5*
    (2 successes + 3 failures, which a ts-only ORDER BY would return under SQLite's ascending
    tie-order).
  - Same setup verified against `getServiceHealthSummaries` for parity.
  - Confirmed both new tests **fail** against the pre-fix code (`git stash` of the `db-health.ts`
    diff, tests re-run, both failed with `expected false to be true`) and **pass** with the fix
    restored — this is a real regression test, not a tautology.
- `STATUS.md`, `docs/EFFORT-LOG.md` — protocol updates for this effort.

## Verification
Run under Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH` — the worktree's default `node` is
v26.5.0, and `better-sqlite3`'s prebuilt binary is compiled against Node 24's ABI):
- `npx tsc --noEmit` — clean.
- `npx vitest run test/api-circuit-breaker.test.ts` — 8/8 passed (2 new).
- `npm run lint` — 0 errors (373 pre-existing grandfathered warnings, untouched by this change).
- `npm test` — 311 files / 3286 tests passed.
- `npm run build` — succeeded.
- Regression-proof step: `git stash push -- src/lib/db-health.ts` (fix removed, test kept) →
  the 2 new tests failed as expected → `git stash pop` (fix restored) → full suite re-run green.

## Follow-ups
- None outstanding for this file — all `ts DESC` reads against `api_health_log` now carry the
  `rowid DESC` tiebreaker. If a future table gains the same `ts`-ordered-read pattern without an
  autoincrement-equivalent tiebreaker key, apply the same idiom (never order by a `randomUUID`
  `id` column expecting insertion order — it has none).
- Closes the task-chip suggestion spawned from the #1267 lane (`eb4a742b fix(data): record
  ok:false health for all-transient TwelveData batches (#1267)`, which touched the same
  `api_health_log` write/read paths and is where this residual-hazard sweep was flagged from).
