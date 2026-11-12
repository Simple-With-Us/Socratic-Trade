# Fleet fully dark detector (SOCRATIC-TRADE-2S)

## Context & Objective

Sentry issue SOCRATIC-TRADE-2S (`trading_liveness_degraded` with copy "fleet is fully dark") was paging while `/api/health` still showed at least one active autonomy account — typically when ask-first (`propose`) was still `active` but every autopilot (`decide`) account was owner-halted.  The darkness counter only looked at autopilot-eligible `active` rows, so `autonomyFullyDark` could be true while `checks.tradingLiveness.activeAccounts` was ≥ 1.

## Changes Made

- `computeAutonomyDarkness()` now tracks `fleetActiveAccounts` (any `systemState === "active"`) and `eligibleDeliberatelyIdle` (owner stop with no app receipt, plus close_only / liquidating).
- `fullyDark` requires zero fleet-wide active accounts and skips the signal when every eligible autopilot account is deliberately idle.
- A halt the app wrote still pages.  `describeAutonomyHaltCause` kinds other than `stopped` (boot interlock, run-failure watchdog, drawdown breaker, broker auto-pause) are not owner stops.  Treating every non-active `SystemState` as deliberate made `fullyDark` unsatisfiable.
- Exported `isDeliberateAutonomyIdleState()` for the state-only check.  Darkness uses the halt-cause lookup for `halted`.
- `/api/health` classifies halted eligible accounts with `batchedHaltCauseKinds` (one `settings` read for the three markers, one indexed `audit_events` read for the breaker and a lost auto-pause).  The kind still matches `describeAutonomyHaltCause`.  A bad marker payload stays `stopped`, so a broken read cannot page the fleet.
- `/api/health` only emits the "fleet is fully dark" message when `autonomyFullyDark` **and** both `autonomyActiveAccounts` and `activeAccounts` are zero (belt-and-suspenders).
- Tests: ask-first + halted autopilot regression; close_only honored; owner halt stays quiet; app boot-halt pages; ask-first still suppresses an app halt.

**Files**

- `src/lib/trading-liveness.ts`
- `src/lib/autonomy-halt-cause.ts`
- `app/api/health/route.ts`
- `test/trading-liveness.test.ts`
- `test/batched-halt-cause.test.ts`
- `docs/rollouts/2026-10-14-fleet-fully-dark-detector.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Owner-halted / close-only / liquidating autopilot fleets do not raise `autonomy_fully_dark`.  An app halt with nothing else active still does.  Per-account stale/failure reasons are unchanged.
- Ask-first activity suppresses the fleet-dark signal even when every autopilot lane is quiet, including when the app halted that autopilot lane.
- A halt-cause lookup that throws counts as deliberate idle, so a broken read cannot page the fleet.
- The health poll does not call `describeAutonomyHaltCause` per account.  Dashboard and ops still do, for one account at a time.  The audit half of that single-account read is the same indexed statement the batch uses.

## Verification State

- `npm run lint` -> ok (0 errors, 866 warnings), including after the halt-cause batch.
- `npx tsc --noEmit` -> ok.
- `npm test` -> 9300 passed, 51 skipped, 1 failed outside this diff on the darkness change.  `test/egress-guard.test.ts` calls real DNS for discord.com and this sandbox rejected it.  Not re-run in full after the batch.
- `npm run build` -> killed (exit 137) while collecting traces, after compile, typecheck, and 43/43 static pages.  This box ran out of memory.  Hosted `verify` is the build gate.  Not re-run after the batch.
- Halt-cause batch: `npx vitest run test/batched-halt-cause.test.ts test/trading-liveness.test.ts test/autonomy-halt-cause.test.ts test/scheduler-halt-cause-tick.test.ts` passed (batch 4, liveness 18, halt-cause 16, scheduler halt-cause 4).

## Next Steps & Blockers

- After deploy, confirm SOCRATIC-TRADE-2S stops receiving new events when health shows `autonomyActiveAccounts >= 1`.
- Resolve stale Sentry issues 2R/2T/2M in UI if no new events after deploy (see PR body).

## Zero-Code Findings

- **SOCRATIC-TRADE-2R** (run failure streak, Sandbox): last event 2026-10-07; streak watchdog still correct — likely quiet after halt/backoff.
- **SOCRATIC-TRADE-2T** (auto-halt Alpaca Paper): last event 2026-10-07; expected one-shot halt notification.
- **SOCRATIC-TRADE-2M** (restart loop): last event 2026-10-11; exit 143 / SIGTERM matches Coolify stop-old-first deploy, not an unclean crash loop.
