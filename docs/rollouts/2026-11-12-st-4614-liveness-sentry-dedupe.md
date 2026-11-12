# 2026-11-12 — ST-4614 trading-liveness Sentry dedupe (SOCRATIC-TRADE-2S)

## Context & Objective

`GET /api/health` called `alertLivenessWarning` on every poll while trading liveness stayed degraded, so Sentry recorded hundreds of near-duplicate events (SOCRATIC-TRADE-2S).  Goal: capture Sentry on state transition or hourly heartbeat only, without changing health JSON or liveness logic.

## Changes Made

- `src/lib/db-health.ts` — `evaluateLivenessSentryCapture`, decoupled Sentry from the 15-minute admin cooldown, stable Sentry message text, episode keys cleared on recovery.
- `src/lib/trading-liveness.ts` — `tradingLivenessSentryStateSignature` for account/reason signatures.
- `app/api/health/route.ts` — pass signatures into `alertLivenessWarning` (response shape unchanged).
- `test/liveness-sentry-dedupe.test.ts` — unit coverage for dedupe rules and fingerprint.

## Decisions & Trade-offs

- Admin push cadence stays 15 minutes; only Sentry reporting changes.
- Dynamic run summaries remain in admin payload context (`detail`), not in the Sentry message title.
- Scheduler stale uses a two-value signature so age-in-seconds drift does not look like a new incident.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/liveness-sentry-dedupe.test.ts test/liveness-warning-escalation.test.ts
```

## Next Steps & Blockers

- Merge after `verify` CI green; watch SOCRATIC-TRADE-2S event rate post-deploy.
