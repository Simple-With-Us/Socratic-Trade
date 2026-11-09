# 2026-06-20 — Money-path tranche 3: T6/T9/T11/T12/T13

## Summary

Landed the remaining test-hardening money-path tasks plus the one real code fix (T13 timezone),
on `agent/claude` in a concurrent ~6-session fleet (coordinated via
`docs/rollouts/2026-06-20-money-path-coordination.md`). `tsc` clean; affected suites green.

## Why

Closing out the 14-task money-path plan. T1/T2/T3/T8 (main), T5, T10, T14-policy already done by
other sessions. This session took the separable test files (T9/T11/T12), the notional/db-boundary
work (T6/T13), and left the contended `db.ts` T14-db task to its owner.

## What changed

- **T13 (code, `src/lib/db.ts`)** — the daily-notional reset boundary used `setHours(0,0,0,0)`,
  i.e. the *server process's* local midnight (implicitly `process.env.TZ`). Replaced with an
  explicit, configurable timezone boundary: `startOfDayInTimeZone(now, timeZone)` +
  `DAILY_RESET_TIME_ZONE = "America/New_York"` (the market day). `dailyExecutionStats` now takes an
  optional `timeZone`. Kill-switch notification path already exists (`strategy.ts:389`), so no change.
- **T6 (tests, `test/daily-notional-reset.test.ts`, new)** — `dailyExecutionStats`/
  `notionalInLastMinutes` count opening (buy/short) notional only but every order toward the count;
  tenant isolation by `userId`; and the null-`estimated_notional` fallback to proposal fields. Plus
  `startOfDayInTimeZone` determinism across `America/New_York` (EDT) and `UTC` (T13).
- **T9 (tests, `test/performance.test.ts`)** — `recordFillFromProposal` records a `short` with the
  right side/qty/price and absolute notional; a `cover` books as a partial short close in the projection.
- **T11 (tests, `test/red-team.test.ts`)** — `debateProposal` fail-open contract: no OpenAI key →
  `rejected:false` ("not configured"); LLM request throws → `rejected:false` (a red-team failure must
  never silently drop a trade).
- **T12 (tests, `test/tax.test.ts`)** — pins long-only behavior: a profitable short/cover round-trip
  contributes nothing to realized tax (closed lot side `short` is excluded), with a long round-trip
  control that IS taxed.

## Files

- `src/lib/db.ts` (T13) — `startOfDayInTimeZone` + `DAILY_RESET_TIME_ZONE`; `dailyExecutionStats` tz param.
- `test/daily-notional-reset.test.ts` (new, T6+T13), `test/performance.test.ts` (T9),
  `test/red-team.test.ts` (T11), `test/tax.test.ts` (T12).
- `docs/rollouts/2026-06-20-money-path-coordination.md` — task status updated; this note.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — full suite green prior to the T10-dup revert (383); affected suites
  (policy/performance/red-team/tax/daily-notional-reset) green after (82 passed).
- NOT run: `npm run build` (would wipe the live 4100 dev server's `.next`).

## Follow-ups

- **T14-db** — empty `account_number` normalization (db.ts:1255/1021/1049), user-APPROVED, left to its
  owner per the coordination doc (db.ts is the contended file; one owner rule).
- **T10 UI** — a settings control for `maxGrossExposurePct`/`maxNetExposurePct` (enforcement + defaults
  + tests already in; fields persist via the policy editor). Minor polish.
- **T11 drop/keep filter** — only the fail-open *contract* is pinned here; the strategy-level
  debate drop/keep integration test is still open.
- Merge cadence per the coordination doc: lands on `agent/claude`; integration merges to `main` when
  the worktree settles.
