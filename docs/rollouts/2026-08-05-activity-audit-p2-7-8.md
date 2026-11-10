# 2026-08-05 — Activity-audit P2.7 + P2.8

## Context & Objective

Close remaining gaps on activity-feed audit items:

- **#1320 / P2.7** — stale-exit cancel settle was a single 750ms wait; slow cancels could leave
  exits canceled without a market replacement.
- **#1321 / P2.8** — synthetic-stop failure audit was already coalesced (1h cooldown), but the
  owner only saw audit rows, not a durable alert.

## Changes Made

### P2.7 (`src/lib/order-replacement.ts`)

- `CANCEL_SETTLE_MS` 750 → 2000; multi-poll via `pollCancelSettlement` up to
  `CANCEL_SETTLE_MAX_MS` (10s).
- Tests keep `cancelSettleMs: 0` (one immediate re-list, no wall-clock wait).
- Row stays `cancel_confirmed` when the original is still active after the window (durable
  pending-cancel); next pump tick continues. Activation-age via `updatedAt` was already on main.

### P2.8 (`src/lib/synthetic-stops.ts` + notification labels)

- `auditSyntheticStopError` now takes `policy`, tracks `firstFailedAt` per fingerprint, and
  emits `protective_exit_failing` via `sendNotification` once per cooldown window.
- Placement retry cadence unchanged; `fire_generation` never touched.
- New `NOTIFICATION_EVENT_TYPES` entry + Settings / dashboard labels.

### Files

- `src/lib/order-replacement.ts`
- `src/lib/synthetic-stops.ts`
- `src/lib/types.ts`
- `src/lib/dashboard-ui.ts`
- `app/console/settings/page.tsx`
- `docs/EFFORT-LOG.md`, `STATUS.md`, this rollout

## Decisions & Trade-offs

- Did not rename status to `replacement_pending_cancel` — existing `cancel_confirmed` already
  pumps until settlement; rename would be a migration-only cosmetic.
- Notification is best-effort (`.catch`); audit is the source of truth.

## Verification State

```bash
npx vitest run test/order-replacement.test.ts test/synthetic-stops.test.ts test/stale-limit-orders.test.ts
# 105 passed
# land.sh: tsc → test → build
```

## Next Steps & Blockers

- Close GitHub issues #1320 / #1321 after merge.
- P2.9 (#1322) largely present on main (failover chain + UI + cadence jitter) — verify then close.
- Unstuck phantom-conflict PRs #2459 / #2445 / #2443 re-running CI (separate lane).
