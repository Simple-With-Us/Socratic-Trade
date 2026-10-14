# Fleet fully dark detector (SOCRATIC-TRADE-2S)

## Context & Objective

Sentry issue SOCRATIC-TRADE-2S (`trading_liveness_degraded` with copy "fleet is fully dark") was paging while `/api/health` still showed at least one active autonomy account — typically when ask-first (`propose`) was still `active` but every autopilot (`decide`) account was owner-halted.  The darkness counter only looked at autopilot-eligible `active` rows, so `autonomyFullyDark` could be true while `checks.tradingLiveness.activeAccounts` was ≥ 1.

## Changes Made

- `computeAutonomyDarkness()` now tracks `fleetActiveAccounts` (any `systemState === "active"`) and `eligibleDeliberatelyIdle` (autopilot-eligible halted / close_only / liquidating).
- `fullyDark` requires zero fleet-wide active accounts and skips the signal when every eligible autopilot account is deliberately idle (owner halt / exit-only / liquidating).
- Exported `isDeliberateAutonomyIdleState()` for tests and future monitors.
- `/api/health` only emits the "fleet is fully dark" message when `autonomyFullyDark` **and** both `autonomyActiveAccounts` and `activeAccounts` are zero (belt-and-suspenders).
- Tests: ask-first + halted autopilot regression; close_only honored; halted-only no longer marks `autonomy_fully_dark`.

**Files**

- `src/lib/trading-liveness.ts`
- `app/api/health/route.ts`
- `test/trading-liveness.test.ts`
- `docs/rollouts/2026-10-14-fleet-fully-dark-detector.md`
- `STATUS.md`

## Decisions & Trade-offs

- All autopilot accounts deliberately halted/close-only no longer raise `autonomy_fully_dark` (honors owner intent; per-account stale/failure reasons unchanged).
- Ask-first activity suppresses the fleet-dark signal even when every autopilot lane is quiet.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/trading-liveness.test.ts
npm run build
```

`test/trading-liveness.test.ts`: 16 passed.  Full-suite `npm test` run in cloud session (see STATUS.md snapshot for any unrelated flakes).

## Next Steps & Blockers

- After deploy, confirm SOCRATIC-TRADE-2S stops receiving new events when health shows `autonomyActiveAccounts >= 1`.
- Resolve stale Sentry issues 2R/2T/2M in UI if no new events after deploy (see PR body).

## Zero-Code Findings

- **SOCRATIC-TRADE-2R** (run failure streak, Sandbox): last event 2026-10-07; streak watchdog still correct — likely quiet after halt/backoff.
- **SOCRATIC-TRADE-2T** (auto-halt Alpaca Paper): last event 2026-10-07; expected one-shot halt notification.
- **SOCRATIC-TRADE-2M** (restart loop): last event 2026-10-11; exit 143 / SIGTERM matches Coolify stop-old-first deploy, not an unclean crash loop.
