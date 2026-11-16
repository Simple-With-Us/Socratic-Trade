# 2026-07-04 - Test account option + usage-limit email alerts

## Summary
- Restored an explicit addable `Test Account - Local Mock Paper Account`.
- Kept the test account inactive unless the user explicitly selects it.
- Added a shared usage-limit alert helper for quota/cap/budget events.
- Wired Pinecone Write Unit daily-fuse trips, Voyage/RAG ingest daily-cap trips, provider rate/quota/billing failures, and API Usage Monitor provider budget warnings into `budget_alert` notifications with email-capable fallback.

## Why
The owner wants the local mock test account available for extra simulation/learning trades, but not as a default or hidden fallback. The owner also asked whether a 50k/day Pinecone WU fuse constrains proper usage and requested email alerts whenever that fuse or any other useful provider cap is hit. The answer encoded in docs and alert copy: 50k/day should be enough for normal incremental single-trader use; hitting it outside a planned backfill is a signal to inspect deduping, chunking, repeated writes, and ingest cadence before raising caps.

## Files
- `app/api/connected-accounts/route.ts`
- `app/console/components/chrome.tsx`
- `app/console/lib/derive.ts`
- `app/console/settings/brokers.tsx`
- `app/console/settings/lib.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/execution-mode.ts`
- `src/lib/notifications.ts`
- `src/lib/usage-budget.ts`
- `src/lib/usage-limit-alerts.ts`
- `src/lib/vector-db.ts`
- `test/connected-accounts-route.test.ts`
- `test/usage-limit-alerts.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/prod-config-voyage.md`
- `PLAN.md`
- `STATUS.md`

## Verification
- `npx tsc --noEmit`
- `npx vitest run test/connected-accounts-route.test.ts test/usage-limit-alerts.test.ts test/usage-budget.test.ts test/vector-db-backlog-c-integration.test.ts`
- `npm run lint` (0 errors, existing warning backlog)
- `npm test` (245 files / 2375 tests)
- `npm run build`
- `git diff --check`
- `pm2 restart trading-codex --update-env`

## Follow-ups
- Production email delivery requires Resend env (`RESEND_API_KEY`, `NOTIFY_EMAIL_FROM`) and a destination (`USAGE_LIMIT_ALERT_EMAIL`, `ADMIN_ALERT_EMAIL`, `PRIMARY_USER_EMAIL`, or a user email notification preference).
