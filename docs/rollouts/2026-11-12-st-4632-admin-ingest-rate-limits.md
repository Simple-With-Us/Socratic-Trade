# 2026-11-12 — ST-4632 admin ingest rate limits

## Context & Objective

The expensive admin ingest and backfill routes already require an admin or `x-admin-token`, and several posts also pass through `withAdminOperationGuard`.  They did not call `enforceRateLimit`.  One authorized caller could stampede OpenRouter, Qdrant, or SEC.  ST-4610 only covers the missing-identity 500 on routes such as learning-ledger.

## Changes Made

A dedicated admin-ingest limiter now runs after the existing admin check and before the job.  Job starts are 6 per 10 minutes per admin per route.  Status reads are 30 per minute.  The subject is the middleware email when one is present, and token-only callers share the stable local identity.  The limiter does not call `resolveRequestUser`, so a token-only caller is not failed by the live-bootstrap identity check.  Who may call each route is unchanged, including `requireTokenInProd` on the reindex, reembed, SEC, and earnings-call routes.

- `src/lib/rate-limit.ts`
- `src/lib/admin-ingest-rate-limit.ts`
- `app/api/admin/reembed/route.ts`
- `app/api/admin/reindex-10k/route.ts`
- `app/api/admin/reindex-8k/route.ts`
- `app/api/admin/sec-ingest/route.ts`
- `app/api/admin/refresh-websource/route.ts`
- `app/api/admin/earningscalls/route.ts`
- `app/api/admin/transcript/route.ts`
- `test/admin-ingest-rate-limit.test.ts`
- `docs/ops-observability-security.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

The new cap is in addition to the hourly operation budgets.  Those budgets stay the tighter control where they already exist (2 reindexes per hour, 6 SEC seeds per hour).  The new cap is what stops paths the operation guard does not wrap: corpus reembed, SEC dead-letter requeue, vector-store status reads, and the chat transcript.  Empty 10-K symbol lists and unknown web-source ids still return 400 before the new budget is spent.  Reads and job starts use separate buckets so a transcript refresh does not consume a reindex start.  Learning-ledger and the ST-4610 identity handling were not edited.

## Verification State

Commands:

```
npx vitest run test/admin-ingest-rate-limit.test.ts test/admin-operation-route-behavior.test.ts test/admin-operation-route-wiring.test.ts test/security-admin-timing-safe.test.ts test/admin-honesty-security.test.ts test/reindex-10k-clear-cache.test.ts
npx tsc --noEmit
npm run lint
npm test
npm run build
```

Focused admin tests: 6 files, 74 tests passed, including the new over-limit 429 cases.  Before the route wiring, those over-limit cases returned HTTP 200 and started the job.  Full gate on Node 26: `npm run lint` passed, `npx tsc --noEmit` passed, and `npm test` passed (904 files, 10299 tests, 42 skipped).  `npm run build` passed with `NODE_OPTIONS=--max-old-space-size=4096`, the same heap CI uses for the Next 16 production build.

## Next Steps & Blockers

Open the PR and wait for the required `verify` check.  Do not merge, do not enable auto-merge, and do not deploy.  No Sentry issue is attached to ST-4632.  The evidence is the missing `enforceRateLimit` calls and the new route tests.

## Zero-Code Findings

None.  The routes were unthrottled by `enforceRateLimit` before this change, which the failing tests showed as HTTP 200 on an over-limit call.
