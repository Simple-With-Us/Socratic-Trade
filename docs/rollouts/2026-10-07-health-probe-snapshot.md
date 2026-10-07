# Health probe snapshot (SOCRATIC-TRADE-S)

## Context & Objective

Sentry uptime issue SOCRATIC-TRADE-S records downtime on `GET https://socratictrade.com/api/health`.  The probe times out at about 8 seconds (681 events).  The issue is resolved in Sentry as a monitor flap, and the stall still recurs.  PagerDuty #383 (Q399OWWAJYMPOW) is the Oct 6 ~13:41Z flap.  This change makes the warm health probe and the Docker liveness probe stop waiting on heavy SQLite work and on the OpenRouter credit fetch.  Extra-ship no.  Do not restart production from this lane.

## Changes Made

A warm `/api/health` returns the last assembled payload from memory (default TTL 2s, `HEALTH_SNAPSHOT_TTL_MS`).  When the snapshot is stale, the handler schedules a refresh and still returns the previous payload.  The refresh yields once before it touches SQLite, then yields again between trading liveness, dependency summaries, and storage checks.  Anonymous vs operator projection (USD figures, byte counts, lease pid) is applied on the way out, so one snapshot serves both audiences.  `ok` and the critical 503s are unchanged; they can lag by about one refresh.

`/api/live` no longer calls `getInternalSetting`.  Docker HEALTHCHECK and the entrypoint watchdog still use it.  200 means the process ran a handler.  A pinned event loop still cannot answer, which is the restart signal.  DB reachability stays on `/api/health` and `/api/ready`.

`getServiceHealthSummaries` prepares its five statements once per call instead of once per lane.

The ~11GB `app.db` is a compounding factor for any synchronous `better-sqlite3` call that still runs on the serving thread (FTS tokenization of one large chunk, filing parse, a long summary refresh).  `api_health_log` already has a per-lane cap and an index on `(service, key_source, ts)`.  This PR does not prune the corpus.  A full async SQLite rewrite is not the smallest safe fix.  A single native call longer than 8s can still delay every in-process HTTP handler, including these probes, because Node accepts the connection on that same thread.

- `app/api/health/route.ts`
- `app/api/live/route.ts`
- `src/lib/health-probe-cache.ts`
- `src/lib/db-health.ts`
- `Dockerfile` (comment only; HEALTHCHECK target stays `/api/live`)
- `test/health-probe-isolation.test.ts`
- `test/live-route.test.ts`
- `docs/runbooks/uptime-health-json-monitors.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-10-07-health-probe-snapshot.md`

## Decisions & Trade-offs

The snapshot is stale-while-revalidate, not a second database.  Vitest keeps TTL 0 unless a test sets `HEALTH_SNAPSHOT_TTL_MS`, so existing health assertions still assemble on every GET.  The first request after boot still assembles inline.  That one request can be slow.  Later Sentry polls are not.

Critical hard-stops (Alpaca, and Pinecone when it is the active vector store) still 503.  They update when the refresh finishes, not inside the warm GET.  Keyword monitors on `schedulerStale`, `tradingLivenessDegraded`, and `litestreamTiersDegraded` keep the same JSON.  A flag can be one refresh behind.

`/api/live` no longer 503s when SQLite is closed or locked.  A restart does not repair a locked database, and it re-halts autonomy.  The public health URL still reports `checks.db` on the refresh.

PagerDuty #383 is not resolved here.  Resolve it only after this merges and the image is actually serving, and leave a non-silent note on the incident.

## Verification State

```
npm run lint          # exit 0, 0 errors (863 pre-existing warnings)
npx tsc --noEmit      # exit 0
npx vitest run test/health-probe-isolation.test.ts test/live-route.test.ts test/health-json-monitors.test.ts test/health-route-exposure.test.ts test/connection-health-routing.test.ts
                      # 47 passed
npm test              # 9101 passed, 11 failed, 51 skipped
npm run build         # exit 0
```

The 11 full-suite failures are the same unrelated seat failures already noted on 2026-10-06 (notify env credentials, Node 22 `.ts` ops script, data-provider and server-metrics assertions).  None are in the health or live routes.  CI `verify` is the merge gate.

The snapshot cache lives in `src/lib/health-probe-cache.ts` because Next.js rejects extra exports on `app/api/health/route.ts` (`__resetHealthSnapshotForTests` failed `next build` typecheck).

## Next Steps & Blockers

Open a normal PR.  Do not force-merge and do not bypass the `verify` ruleset.  After merge and a real production ship, resolve PagerDuty #383 with a note that names the deployed sha.  Do not Coolify-deploy or restart the container from an agent during this work.

Residual: move any remaining multi-second main-thread `better-sqlite3` or HTML/JSON parse off the serving thread.  Lexical FTS off-loop work is a separate effort.  Do not prune `app.db` in a drive-by.

## Zero-Code Findings

Seer's "health does heavy work inline" claim matches the route: sequential SQLite (settings, lease, trading liveness, per-lane health summaries), Litestream IPC and file scans, and `getOpenRouterCreditStatus` with a 1.5s wait (the helper floors `maxWaitMs` at 200ms).  The separate claim that a synchronous `better-sqlite3` call pins the whole event loop is also true and is already documented (`src/lib/sqlite-event-loop.ts`, FTS mirror notes, Dockerfile HEALTHCHECK comment).  Prior pin+yield work (PR #3383) shortened `SQLITE_BUSY` waits.  It does not make an 8s uptime GET safe when the handler itself stacks that work, or when some other native call occupies the thread before the handler starts.  This PR fixes the handler wait.  It does not make the process answer HTTP during a native pin.
