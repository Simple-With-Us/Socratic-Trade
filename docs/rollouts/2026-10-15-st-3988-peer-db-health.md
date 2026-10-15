# 2026-10-15 — ST-3988 api-health peer D1 contention (congress-share)

## Context & Objective

PagerDuty #313 paged `[P0 production] congress-share connection failed` while both apps were healthy.  App A import bodies returned `D1 batch error: SQLITE_BUSY` per-row rejections; ST misclassified them as local SQLite faults and/or generic connection failures.

## Changes Made

- `src/lib/peer-db-fault.ts` — classifier, `[peer-db-contention]` health prefix, audit + advisory lane for App A write contention.
- `src/lib/local-db-fault.ts` — exclude peer-originated SQLite strings from local classification.
- `src/lib/db-health.ts` — peer path in `alertConnectionFailure` (Sentry `warning`, `health.failure_class=peer-db-contention`, title `peer write contention (App A D1)`); soft streak exclusion; flush loop still calls that path for peer soft rows; peer errors are not double-stamped `[expected-limit]`.
- `src/lib/congress-share.ts` — stamp peer-db errors at `logApiHealth` time.
- `test/peer-db-fault-health.test.ts` — regression for classifier + alert path.

## Decisions & Trade-offs

- Peer contention stays visible (audit + warning Sentry) but does not mint `connection failed` or operator push.  Fixing CT D1 root cause remains a Congress.Trade lane.

## Verification State

```bash
npx vitest run test/peer-db-fault-health.test.ts test/local-db-fault-classification.test.ts
npx tsc --noEmit
```

## Next Steps & Blockers

- Merge after `verify` CI green.  Refs ST-3988.
