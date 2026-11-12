# ST-4615 / FLEET-INFRA-F1 — Vercel production catch-up Sentry check-ins

## Context & Objective

Sentry monitor `ci-socratic-trade-vercel-production-catch-up` (schedule `41 * * * *` UTC, 15m margin) paged missed check-ins hourly since 2026-10-18.  Production is Coolify; the repo had no `Vercel production catch-up` workflow or `sentry-ci-report` wiring.

## Changes Made

- Added `.github/workflows/vercel-catch-up.yml` — schedule-only heartbeat (no Vercel CLI, no deploy).
- Wired `scripts/sentry-ci-report.py` (`CRON_SCHEDULES`, `CHECKIN_MARGIN_OVERRIDES` = 75m).
- Updated `.github/workflows/sentry-ci-report.yml` observer list.
- Updated `test/sentry-ci-report-workflows.test.ts`.

## Decisions & Trade-offs

Orphan monitor was created fleet-wide on 2026-10-18 without a matching ST workflow.  Heartbeat preserves the monitor class used on Vercel-hosted repos without spend or deploy behavior changes.  `VERCEL_CATCH_UP_ENABLED` stays unset/false.

## Verification State

```bash
npx vitest run test/sentry-ci-report-workflows.test.ts
python3 -m py_compile scripts/sentry-ci-report.py
```

## Next Steps & Blockers

After merge, confirm `ci-socratic-trade-vercel-production-catch-up` shows in_progress + ok on the next `:41` UTC tick.  Do not arm auto-merge (owner/ST-4615).  Mirror the same delta on Personal-Site, DealDex, BotFleet, and ContactLogo.

## Zero-Code Findings

Root cause: monitor existed; no workflow and no reporter mapping, so zero check-ins.
