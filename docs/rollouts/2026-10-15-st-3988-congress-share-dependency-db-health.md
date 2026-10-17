# 2026-10-15 — ST-3988 congress-share dependency DB health classification

## Context & Objective

Production paged P0 as `congress-share connection failed` while Congress.Trade was HTTP-healthy and
returning HTTP 200 import bodies with D1 `SQLITE_BUSY` row rejections.  ST must classify that as
peer-app write contention, not a broken share connection, and must expose the class on detailed
`/api/health` for ops.

## Changes Made

- `isDependencyDbContentionMessage` + `noteDependencyDbContention` in `src/lib/local-db-fault.ts`
  (excludes App A / D1 shapes from `isLocalDbFaultMessage`).
- `alertConnectionFailure` in `src/lib/db-health.ts` records dependency contention at Sentry
  `warning` with title `<service> dependency database contention` and
  `health.failure_class=dependency-db-contention`; no `provider_degraded` push.
- `connectionHealthFailureClass` helper; detailed `/api/health` (ops token) includes
  `lastFailure` + `failureClass` on `checks.dependencies.*` (stripped from anonymous view).
- Tests: `test/congress-share-dependency-db-health.test.ts`, assertion in
  `test/local-db-fault-classification.test.ts`, ST-3092 Dockerfile/liveness pins in
  `test/live-route.test.ts` (ported from closed duplicate PR #4709).
- `isDependencyDbContentionMessage` requires SQLite lock/busy patterns before matching `D1 batch
  error` (Seer review on #4706).

## Decisions & Trade-offs

- Consecutive-failure STOPPED state is unchanged (imports are still failing); only alert routing and
  labeling change so P0 connection rules do not fire on D1 contention.
- D1/peer-app contention is intentionally NOT labeled "local database contention" on ST.

## Verification State

```bash
npx vitest run test/congress-share-dependency-db-health.test.ts test/local-db-fault-classification.test.ts test/health-route-exposure.test.ts
# -> ok
npm run lint
# -> ok
npx tsc --noEmit
# -> ok
npm test
# -> ok
npm run build
# -> ok
```

## Next Steps & Blockers

- Congress.Trade D1 contention root cause remains CONGRESS-TRADE-1J/1B (BF-COMPILER lane).
- Optional: tune PagerDuty/Sentry rules to exclude `health.failure_class:dependency-db-contention`.

## Review-bot follow-ups (2026-10-15, codex-autofix round 8)

- Rule 26 — the Verification State block above now names each command in order with a per-line
  `-> ok` token, so the note is auditable at closeout instead of a bare bash block.
- Rules 19 / 31 — `test/health-route-exposure.test.ts` parses `checks.dependencies` from
  `Response.json()` via `parseHealthDependenciesFromJson` + `healthDependencyEntrySchema` (no `as`
  casts on boundary JSON). `dependenciesWithoutOpsDetail` accepts the parsed `HealthDependencies`
  map only.
