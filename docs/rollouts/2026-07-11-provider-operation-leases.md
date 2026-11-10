# Durable provider/dataset operation leases — 2026-07-11

## Summary

Added durable single-flight below the admin route layer so manual and scheduler/background entrants
cannot overlap the same expensive provider or dataset operation. The four groups are:

- `rag-reindex`: SEC 8-K reindex and 10-K/10-Q filing-body ingest.
- `congress-share`: outbound Congress.Trade daily/history sharing.
- `web-source:congress`: congressional disclosure refresh.
- `web-source:sec8k`: SEC 8-K dataset refresh.

The admin guard acquires the durable group before debiting rate quota, then passes an opaque claim to
the matching core boundary. The core reuses that claim. Direct/background callers acquire at the same
core boundary and receive a typed benign busy result when another owner is active. Admin routes map
that typed result through `operationInFlightResponse`, whose body/status builders come from
`@jaywedgeworth22/congress-trading-shared` v1.5.0.

## Why

The existing route guard excluded duplicate manual admin requests only inside one Node process. A
scheduler tick, a background caller, another process, or an old/new deploy overlap could still start
the same paid scrape/embed/share concurrently. Moving ownership to an immediate SQLite transaction
at the provider/dataset boundary supplies one serialization point for every entrant sharing the DB.

## Decisions

- Reuse the existing `settings` KV; no schema migration or new table.
- Acquire with `transaction().immediate()` so the read/compare/write sequence is atomic across SQLite
  connections/processes.
- Give every entrant a random owner token, renew it on a TTL heartbeat, and delete only when the
  persisted owner still matches. A paused/expired old owner therefore cannot clear its successor.
- Fail closed when ownership cannot be proven. Heartbeat failure aborts the shared claim signal;
  core boundaries revalidate persisted ownership before provider writes and stop cooperatively
  between network steps. A nested opaque claim is rejected if its lease expired or was stolen.
- Recheck every non-forced cadence/daily gate after durable acquisition. The outer precheck remains
  a cheap no-op path, but a process that waited behind another writer cannot repeat the run after
  that writer advanced the marker.
- Treat background contention as a successful benign skip with typed `operationLease` metadata,
  zero work counters/current cached dataset metadata, and no attempt/daily-marker advancement.
- Keep Congress and SEC 8-K refresh groups independent because they mutate separate datasets.
- Share one RAG group across 8-K reindex and filing-body ingest because both consume the same
  embedding/corpus-write capacity.
- Leave `src/lib/scheduler.ts` untouched; exclusion belongs at the underlying functions it already
  calls.
- Preserve `refreshEightK`'s detached best-effort summary/full-body embedding. The primary refresh
  lease releases when the existing refresh promise resolves; detached embedding can continue after
  that point exactly as before.

## Files

- `src/lib/operation-lease.ts`
- `src/lib/admin-operation-guard.ts`
- `src/lib/operation-guard-response.ts`
- `src/lib/congress-share.ts`
- `src/lib/web-sources/congress.ts`
- `src/lib/web-sources/sec8k.ts`
- `src/lib/web-sources/sec-filings.ts`
- `app/api/admin/reindex-8k/route.ts`
- `app/api/admin/reindex-10k/route.ts`
- `app/api/admin/congress-share/route.ts`
- `app/api/admin/refresh-websource/route.ts`
- `test/operation-lease.test.ts`
- `test/provider-operation-boundaries.test.ts`
- `test/admin-operation-guard.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-9-web-sources.md`
- `docs/rollouts/2026-07-11-provider-operation-leases.md`

## Verification

Run under Node 24 after a clean worktree-local `npm ci`:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test -- --run \
  test/operation-lease.test.ts \
  test/provider-operation-boundaries.test.ts \
  test/admin-operation-guard.test.ts \
  test/admin-operation-route-behavior.test.ts \
  test/admin-operation-route-wiring.test.ts \
  test/congress-share.test.ts \
  test/web-sources.test.ts \
  test/sec-filings.test.ts \
  test/sec8k-full-body.test.ts
# PASS: 9 files, 130 tests

PATH=/opt/homebrew/opt/node@24/bin:$PATH node node_modules/typescript/bin/tsc --noEmit --pretty false
# PASS

PATH=/opt/homebrew/opt/node@24/bin:$PATH node node_modules/eslint/bin/eslint.js \
  src/lib/operation-lease.ts src/lib/admin-operation-guard.ts src/lib/operation-guard-response.ts \
  src/lib/congress-share.ts src/lib/web-sources/congress.ts src/lib/web-sources/sec-filings.ts \
  src/lib/web-sources/sec8k.ts app/api/admin/reindex-8k/route.ts \
  app/api/admin/reindex-10k/route.ts app/api/admin/congress-share/route.ts \
  app/api/admin/refresh-websource/route.ts test/operation-lease.test.ts \
  test/provider-operation-boundaries.test.ts test/admin-operation-guard.test.ts \
  test/admin-operation-route-behavior.test.ts
# PASS: 0 errors; 4 pre-existing warnings in congress.ts/sec8k.ts
```

An independent adversarial pass also caught an omitted existing route-behavior test whose full DB
mock hid `getDb` from the new durable guard. The harness now preserves the real DB exports, overrides
only `listIngestedAccessions`, and uses a per-run temp SQLite file; its original 429/409 behavior
assertions pass and the file is included in the focused receipt above.

The same pass tightened the success boundary after every awaited lease callback: it now re-reads the
persisted owner and TTL instead of trusting only the heartbeat `AbortSignal`. This rejects an expired
holder even when an event-loop pause lets its promise continuation run before the overdue heartbeat
timer. The regression test proves the stale holder rejects without deleting its successor, and the
admin-guard suite now uses its own per-run temp SQLite database rather than the ignored dev DB.

The first typecheck attempt preceded dependency installation and invoked npx's placeholder `tsc`;
it made no code assertion. `npm ci` installed the locked worktree dependencies, after which focused
tests and the real TypeScript compiler passed.

The first parent full build then caught a Next bundle-edge error: `operation-lease.ts` imported
`node:crypto` on the scheduler instrumentation graph, which Next also traces for Edge. UUID creation
now uses `globalThis.crypto.randomUUID()` instead. The failed build was not pushed; the complete
ordered gate was repeated after this correction:

- focused provider/route gate — 9 files / 130 tests passed;
- `npm run lint` — 0 errors / 404 inherited warnings;
- `npx tsc --noEmit` — passed;
- `npm test` — 334 files / 3,759 tests passed;
- `npm run build` — passed with only the inherited middleware/Sentry/cache warnings.

## Follow-ups

- Ready PR #1441 at head `eb67f521`; wait for hosted verify/smoke/security before merge.
- Mirror the active-row status to `/Users/jay/apps/TRADING-EFFORT-LOG.md` at commit/PR/merge/deploy
  boundaries.
- Open a ready PR from the owned branch only after the full gate is green.
- Deliberately preserved caveat: `refreshEightK`'s detached summary/full-body embedding does not
  acquire `rag-reindex`, so that best-effort tail can still overlap a later corpus operation. Closing
  that requires a durable pending/retry job (or awaiting the tail), which would change the explicit
  non-blocking contract and was out of scope for this lane.
- Ownership-loss fencing is cooperative between provider/write calls and rejects stale success, but
  the existing long awaited fetch/embed helpers do not all accept an `AbortSignal`. A request already
  in flight when a heartbeat loses ownership can finish before the next checkpoint. Strict immediate
  cancellation requires threading signals through those helper call chains (and cannot undo an
  external provider request already accepted).
