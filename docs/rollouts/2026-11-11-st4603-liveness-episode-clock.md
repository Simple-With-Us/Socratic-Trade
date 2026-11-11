# ST-4603 — per-account liveness escalation episode clock

## Context & Objective

Fleet-wide `livenessDegradedSince:<type>` keys made a newly degraded account inherit another account's escalation age (prod 2026-11-09: Alpaca Paper paged "76h" from Tradier Sandbox's clock).  This change tracks episode start per account for run-failure and trading-liveness warnings.

## Changes Made

- Per-account episode keys `livenessDegradedSince:<type>:<accountKey>` with oldest-open-episode escalation and account named in escalated titles.
- Legacy global keys for per-account types are discarded on touch (upgrade does not page immediately).
- `reconcileLivenessAccountEpisodes` + health-route reconciliation for trading liveness; watchdog clears per account on recovery/re-arm.

**Files**

- `src/lib/db-health.ts`
- `src/lib/run-failure-watchdog.ts`
- `app/api/health/route.ts`
- `test/liveness-warning-escalation.test.ts`
- `test/run-failure-watchdog.test.ts`

## Decisions & Trade-offs

- `livenessEscalatedAt:<type>` remains fleet-wide (stable Sentry fingerprint + escalation cadence).
- `scheduler_stale` keeps the global episode key (out of scope).

## Verification State

```bash
npx vitest run test/liveness-warning-escalation.test.ts test/run-failure-watchdog.test.ts test/health-json-monitors.test.ts
npm run lint
npx tsc --noEmit
```

## Next Steps & Blockers

- Merge after `verify` CI green on PR.

## Zero-Code Findings

- None.
