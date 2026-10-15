# 2026-10-15 — api-health DB contention vs connection failed (ST-3988)

## Context & Objective

PD #313 paged on `congress-share connection failed` while Congress.Trade D1 was returning
`SQLITE_BUSY` on import rows.  The HTTP share path was healthy; only upstream write contention
failed.  api-health must classify those rows as **degraded: db contention** (warning, no P0 page)
and must not hard-STOP the lane on five D1 busy rows.

## Changes Made

- `src/lib/local-db-fault.ts` — `isDependencyDbContentionMessage()` for App A / D1 busy shapes.
- `src/lib/db-health.ts` — `HEALTH_DB_CONTENTION_PREFIX`, `isDbContentionHealthFailure()`,
  streak exclusion, dependency contention Sentry capture (`failure_class=db-contention`).
- `test/api-health-db-contention-classification.test.ts` — regression suite (ST-3988).
- `test/live-route.test.ts` — asserts tini ENTRYPOINT + HEALTHCHECK `curl --max-time` (ST-3092).

## Decisions & Trade-offs

- Upstream D1 contention is distinct from local `app.db` faults: audit kind
  `dependency_db_contention`, not `local_db_contention`.
- Real transport/auth failures still capture `congress-share connection failed` at error level.

## Verification State

```
npx vitest run test/api-health-db-contention-classification.test.ts test/live-route.test.ts
npm run lint
npx tsc --noEmit
npm test
npm run build
```

## Next Steps & Blockers

- Congress.Trade D1 contention root cause remains CONGRESS-TRADE-1J (BF-COMPILER lane).
- Event-loop hang class from ST-3092 comments is separate from HEALTHCHECK zombie reap (already on
  `main` via PR #3208).
