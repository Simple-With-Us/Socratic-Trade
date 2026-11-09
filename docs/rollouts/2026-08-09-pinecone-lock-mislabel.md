# 2026-08-09 - pinecone-lock-mislabel

## Context & Objective

Owner-visible bug (Pushover screenshot, hourly since at least 2026-08-09 04:59): alerts titled
**"Pinecone connection failed"** with body **`inventory fetch: database is locked`** /
`inventory list: database is locked`. Pinecone was never down — "database is locked" is
SQLITE_BUSY from our own better-sqlite3 file, surfacing inside the Pinecone inventory code path
and being reported through the provider-degraded notification lane under Pinecone's name. Two
defects: (1) the SQLite contention itself, which the 60s `busy_timeout` in `db.ts` provably could
not absorb; (2) the mislabelling of a local fault as a vendor outage. This note fixes both.

This closes the follow-up left open by `docs/rollouts/2026-07-20-sqlite-busy-timeout-headroom.md`
("the mislabeling itself ... is a minor observability gap worth a future fix"), and answers its
other follow-up ("identify the specific long-held writer rather than raising the timeout").

## Changes Made

### 1. Root cause: a deferred read-then-write transaction, immune to `busy_timeout`

The alerting path is the hourly `managed-vector-reconcile` scheduler lane:

`src/lib/scheduler.ts` -> `reconcileManagedVectorRecordsIfDue()`
-> `reconcileManagedVectorRecordsUnlocked()` (`src/lib/vector-db.ts`)
-> `inventoryVectorRecordsByMetadata()` -> `withRagApiHealth("pinecone", ..., "inventory list"/"inventory fetch", ...)`
-> `withDurableRagProviderDispatch()` -> `reserveProviderDispatch` / `markProviderDispatchStarted`
   / **`settleProviderDispatch`** (`src/lib/db-provider-dispatch.ts`).

`withRagApiHealth` wraps the WHOLE durable dispatch cycle — reserve -> mark started -> provider
call -> settle. So a SQLite error raised by the LOCAL ledger writes on either side of the network
call arrives in its catch block already labelled `"<operation>: <message>"` and is reported as a
provider failure. `settleProviderDispatch` runs AFTER a successful Pinecone response, which is
exactly why the alert body said Pinecone failed while Pinecone was healthy.

The specific mechanism, and why 60s of `busy_timeout` never helped:

`settleProviderDispatch` opened a **deferred** `database.transaction(...)()` whose first statement
is a `SELECT` (`status, outcome_code, dispatch_owner_token`) and whose later statements are
`UPDATE` + `INSERT`. In WAL mode, the `SELECT` takes a read snapshot; if any other connection
commits before the `UPDATE`, promoting that snapshot to a write returns **`SQLITE_BUSY_SNAPSHOT`
immediately, and SQLite does NOT invoke the busy handler** (waiting can never make a stale
snapshot current, so it is a deadlock SQLite refuses to sit on). better-sqlite3 surfaces that as
the bare message `database is locked` — indistinguishable, in the message, from an ordinary
SQLITE_BUSY that `busy_timeout` WOULD have absorbed. This codebase explicitly expects multiple
connections to share the file (see the "competing app processes" comments in
`db-provider-dispatch.ts` and `usage-monitor-replay.ts`, plus in-container litestream).

Reproduced against this repo's own better-sqlite3, two real processes, `busy_timeout = 60000`
(instrumented script, scratch only — see Verification):

```
deferred:  THREW 42ms SQLITE_BUSY_SNAPSHOT database is locked | child OK 0ms
immediate: OK 63293ms                                          | child THREW 63242ms SQLITE_BUSY
write-first deferred: OK | child THREW SQLITE_BUSY   (i.e. write-first is already immune)
```

Read the second line as: with `BEGIN IMMEDIATE` the settling connection succeeds and the *other*
writer waits on the busy handler instead (the 63s there is an artifact of the harness deliberately
nesting the other writer inside the transaction; in production the competing writer simply waits
its turn). The third line confirms a deferred transaction whose FIRST statement is a write is not
exposed to this failure, which is why `reserveProviderDispatch` (already `.immediate()`),
`markProviderDispatchStarted`, `logApiHealth`, and `reconcileStaleProviderDispatches` were never
the source.

Fix: every transaction in the dispatch ledger now takes the write lock at `BEGIN`.
`settleProviderDispatch` and `resolveStaleProviderDispatch` are the two that actually read before
writing (the real defect); `markProviderDispatchStarted` and `reconcileStaleProviderDispatches`
are converted too, where it is a semantic no-op today, so a future statement reorder cannot
silently reintroduce the bug.

### 2. Stop labelling local faults as provider outages

New `src/lib/local-db-fault.ts` (modelled on the just-landed `src/lib/pinecone-wu-breaker.ts`):

- `isLocalDbFaultMessage(message)` / `isLocalDbFaultError(error)` — deliberately narrow matcher:
  `/database is locked/i`, `/database table is locked/i`, `/no such table/i`,
  `/\bSQLITE_(BUSY|LOCKED)\b/`, plus better-sqlite3's `error.code` prefixes `SQLITE_BUSY*` /
  `SQLITE_LOCKED*` (SQLITE_BUSY_SNAPSHOT carries the code but only the bare message). No provider
  HTTP response can produce any of these strings, so genuine outages are untouched.
- `noteLocalDbFault({ lane, operation, message, userId })` — bumps a rolling 6h recurrence counter
  in internal settings, writes a `local_db_contention` audit row (at most once per UTC hour, so a
  contention storm's own logging cannot make the contention worse), and on the 5th occurrence in a
  window raises exactly ONE advisory through `alertStorageWarning("local database contention", ...)`
  — owner-visible title `Storage Warning: local database contention`, never a vendor name. Never
  throws.

`withRagApiHealth` (`src/lib/vector-db.ts`): on a local-DB fault it now writes NO `api_health_log`
failure row for the provider lane and raises NO `provider_degraded` notification; it marks the
error Sentry-captured, calls `noteLocalDbFault`, and rethrows unchanged. Genuine Pinecone/embed/
rerank errors, and the monthly write-unit breaker path, are byte-for-byte unchanged.

`alertConnectionFailure` (`src/lib/db-health.ts`): defense in depth for every non-RAG provider lane
— a failure whose text matches the local-DB signatures is routed to `noteLocalDbFault` instead of
minting a `"<service> connection failed"` push.

### Files touched

- `src/lib/local-db-fault.ts` (new)
- `src/lib/db-provider-dispatch.ts`
- `src/lib/vector-db.ts`
- `src/lib/db-health.ts`
- `test/local-db-fault-classification.test.ts` (new)
- `docs/rollouts/2026-08-09-pinecone-lock-mislabel.md`, `STATUS.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- **No health row at all on a local fault** (rather than a success row or a soft failure row). The
  call proved nothing about the provider: the SQLite error can precede the network call
  (`reserve`/`markStarted`) or follow a perfectly good response (`settle`). Inventing a success
  would be dishonest; a soft failure row still paints the lane yellow via the
  "active this hour, no success" heuristic. Cost: when `settle` fails after a successful Pinecone
  call, that success is not counted. Accepted — under-counting is the honest failure direction, and
  the lane's other calls still log normally.
- **Advisory reuses `alertStorageWarning`** rather than a bespoke notification: it force-enables the
  `storage_warning` event, carries its own 12h repeat-dedup and operator-email fallback, and is the
  same lane the WU breaker uses. Consequence: the title is `Storage Warning: local database
  contention` rather than a fully free-form string. It names the real cause and never a vendor,
  which is the requirement.
- **Threshold 5 occurrences / 6h window before any push.** A single transient lock is normal on a
  busy WAL file and must not page anyone; the point of the alert is a persistent condition.
- **`noteLocalDbFault` pulls `alertStorageWarning` via a dynamic `import("./db-health")`** so
  `db-health.ts` can statically import the classifier without a static module cycle. This mirrors
  `alertStorageWarning`'s own dynamic `import("./db")`.
- **WEBPACK TRAP respected:** `local-db-fault.ts` is reachable from `src/lib/scheduler.ts` and
  imports only bare `"./db"` (no `"os"`, no `node:`-prefixed specifiers).
- **`busy_timeout` left at 60s.** It was never the problem for this failure class and remains
  correct for ordinary contention. Deliberately NOT raised again.
- **Not changed:** any trading, retry, or control-flow behavior. The error still propagates to
  callers exactly as before; only labelling/alerting differs. Guardrail-neutral per the product
  philosophy (this is observability correctness, not a new cage).

## Verification State

Commands run, exactly (Node 24 via `/opt/homebrew/opt/node@24/bin`):

```
npx tsc --noEmit
  -> exit 0, no output

npx vitest run test/local-db-fault-classification.test.ts
  -> Test Files 1 passed (1) | Tests 7 passed (7)

npx vitest run test/provider-dispatch-durability.test.ts test/pinecone-wu-breaker.test.ts \
  test/scheduler-managed-vector-reconcile.test.ts test/vector-db-lease-fencing.test.ts \
  test/vector-db-voyage-dispatch-cost.test.ts
  -> Test Files 5 passed (5) | Tests 36 passed (36)

npx vitest run test/health-lane-cap.test.ts test/health-lane-reprobe.test.ts \
  test/connection-health-routing.test.ts test/connections-health-route.test.ts \
  test/health-route-exposure.test.ts test/notification-repeat-dedup.test.ts \
  test/broker-health-auto-pause.test.ts test/account-deletion.test.ts \
  test/usage-monitor-replay.test.ts
  -> Test Files 9 passed (9) | Tests 83 passed (83)

npx vitest run test/vector-db.test.ts test/vector-db-scope.test.ts \
  test/vector-db-document-receipts.test.ts test/vector-db-provenance.test.ts \
  test/vector-db-retrieval.test.ts test/rag-embed-provider-gate.test.ts test/embed-stage.test.ts
  -> Test Files 7 passed (7) | Tests 110 passed (110)

npm run lint
  -> exit 0; 728 problems (0 errors, 728 warnings)  [pre-existing grandfathered warnings]
```

Per the task scope, `npm test` (full suite) and `npm run build` were NOT run and no push/PR/land
was performed.

**Both new assertions were confirmed discriminating**: with the `withRagApiHealth` classification
branch disabled and `settleProviderDispatch` reverted to a deferred transaction, exactly the two
targeted tests fail ("a local DB failure during vector inventory does NOT fail the pinecone lane
or push provider_degraded", "reserve, markStarted and settle all use BEGIN IMMEDIATE") and the
other five still pass.

New test file `test/local-db-fault-classification.test.ts` (7 tests):

1. classifier accepts the owner's exact strings and rejects real Pinecone/HTTP/WU errors, including
   the `SQLITE_BUSY_SNAPSHOT` code-only shape;
2. a REAL better-sqlite3 error out of the REAL settle path (the `provider_usage_outbox` table is
   dropped for the duration of one call, so the settle after a SUCCESSFUL Pinecone response raises
   `no such table: ...`) writes no pinecone failure row, sends no `provider_degraded`, and does
   write a `local_db_contention` audit row;
3. a real Pinecone network error still logs `inventory list: PineconeConnectionError...` on the
   pinecone lane and still pushes `Pinecone connection failed`, with no `local_db_contention` row;
4. the 5-in-6h threshold raises exactly one advisory whose title contains "local database
   contention" and not "pinecone", and never a `provider_degraded` push;
5. audit throttling is once per hour;
6. the ledger's reserve/markStarted/settle all open `IMMEDIATE`;
7. settle still produces `status='succeeded'` and exactly one `provider_usage_outbox` row.

Fault-injection note: the end-to-end case deliberately uses `no such table` rather than a real held
write lock, because holding a lock across the settle would also block the classifier's own audit
write and make the assertion meaningless. The literal `database is locked` /
`SQLITE_BUSY_SNAPSHOT` shapes are pinned at the classifier boundary, and the root cause itself is
pinned by the BEGIN IMMEDIATE test.

## Next Steps & Blockers

- Landing operator: run the full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`,
  `npm run build`) and `bash scripts/land.sh`. Merging to `main` auto-deploys.
- After deploy, expect the hourly "Pinecone connection failed / database is locked" pushes to stop.
  If `local_db_contention` audit rows keep accruing (query
  `SELECT payload FROM audit_events WHERE kind='local_db_contention' ORDER BY created_at DESC`),
  a second read-then-write deferred transaction exists elsewhere on that path — sweep for
  `database.transaction(` bodies whose first statement is a `SELECT` and convert them to
  `.immediate()` rather than raising `busy_timeout` again.
- Not audited in this pass: the same deferred read-then-write shape in modules outside the dispatch
  ledger. A repo-wide sweep is a reasonable standalone follow-up.
- No blockers.
