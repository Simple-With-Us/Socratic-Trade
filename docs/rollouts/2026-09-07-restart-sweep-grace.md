# 2026-09-07 — Restart-sweep adoption grace + R7 index-metric guard on the Qdrant read path

## Summary

Two P1 money-path regressions traced to PR #3138 (merged 2026-09-01, "default RAG reads to
Qdrant, decouple from Pinecone and sweep restart runs immediately") and its follow-up #3158.

1. **The immediate restart sweep could close a legitimately-running adopted run.**
   `markStaleRunningRuns` selects `started_at < cutoff OR started_at < processBootCutoff`.  The
   second arm selects *every* run that started before this process booted, however young.  The
   only liveness grace that applied to it was `isStrategyRunExecutionLive`, whose map is
   process-local by construction, plus an audit-activity probe that a seconds-old run has not
   populated yet.  On a multi-instance deploy or a rolling restart that is exactly the shape of a
   run another node legitimately adopted — so a live trading run was marked `failed` mid-flight
   and its `strategy_run_requests` row was freed for a duplicate.

2. **The R7 index-metric assertion stopped running once Qdrant reads defaulted on.**
   `assertIndexMetric` verifies the Pinecone index metric is actually `cosine` (every cosine-scale
   floor — `VECTOR_MIN_SCORE`, the rerank relevance floor — is meaningless otherwise) and is the
   only thing that populates the in-process provider-authority cache from a described index.
   #3138 skipped it when no Pinecone client existed; #3158 narrowed it to
   `readBackend === "pinecone"`, so with `RAG_VECTOR_READ_QDRANT` defaulting true the guard
   stopped running in production entirely, silently.

## Fix

- `src/lib/db-execution.ts` — new `hasLiveStrategyRunLease(runId, userId, connectedAccountId, now)`.
  `runStrategyOnce` acquires the strategy run lock with the run id itself as `owner` **before**
  `insertStrategyRun` writes the `running` row, releases it in the `finally` **after**
  `finishStrategyRun`, and `startStrategyLockGuard` renews that lease every 60s with a 5-minute
  TTL.  An unexpired lock owned by the run id is therefore durable, cross-process proof that the
  run is still owned.  The sweep honours it — but only for rows the restart arm alone selected
  (`started_at >= cutoff`).  A run past `STALE_RUN_THRESHOLD_MS` is still swept even while its
  lock-guard interval keeps ticking, because a wedged run whose timer still fires is precisely the
  stuck-run bug #3138 set out to fix.  A `settings` read fault returns "live" so the sweep fails
  closed by leaving the run alone; a genuinely crashed run is swept on the next tick.

- `src/lib/vector-db.ts` — `assertIndexMetric` now runs whenever a Pinecone client and init key
  exist, on **both** read backends.  It is cached per init key and documented never to throw for
  provider/metric faults, so it costs at most one `describeIndex` per process and cannot fail a
  retrieval pass.  Only the *authority* it mints stays backend-specific: on the Qdrant path the
  records were committed under the durable authority from the commit ledger, so that still wins.
  The `indexExists` control-plane preflight #3138 removed from the Qdrant path stays removed.

- `src/lib/vector-db.ts` — the committed-receipts gate fails closed on an *unknown* authority, not
  only a wrong one.  `filterMatchesForCommittedReceipts` now drops every managed match up front
  when `providerAuthority` is missing or blank (previously implied only by a conjunct buried at the
  end of a ~25-term predicate), and the Qdrant branch of the namespace gating no longer queries the
  receipt-bearing namespaces without an authority — `managedAuthorityClause` pins
  `provider_authority: { $eq: stableProviderAuthority }`, and an `undefined` there is dropped by
  JSON serialization, which would widen the server-side half of the gate to "any authority".

## Files

- `src/lib/db-execution.ts`
- `src/lib/vector-db.ts`
- `test/stale-running-runs.test.ts`
- `test/vector-db-document-receipts.test.ts`
- `test/vector-db-qdrant-index-metric.test.ts` (new)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/rollouts/2026-09-07-restart-sweep-grace.md`

## Verification

Run in `~/apps/trading-claude-restart-sweep`.

- `npx tsc --noEmit` — exit 0, no output.
- `npm run lint` (`eslint .`) — exit 0, `801 problems (0 errors, 801 warnings)`; the warning count is the repo's existing baseline.
- Targeted vitest:  `test/stale-running-runs-adoption-grace.test.ts` 4/4, `test/vector-db-qdrant-index-metric.test.ts` 1/1, and
  `test/vector-db-document-receipts.test.ts` + `test/vector-db-qdrant-retrieval.test.ts` + `test/qdrant-read.test.ts` 39/39.
- Both new regression tests were confirmed to FAIL with their fix reverted and pass with it restored.
- Full `npm test` did **not** complete locally.  This Mac was severely degraded during the session — a single test file's
  vitest `transform` took 65s against 17s earlier in the same session — and the 700-file suite made no progress in ~35
  minutes.  The GitHub `verify` check (`tsc --noEmit` -> `npm test` -> `npm run build`) is the authoritative full-suite run
  for this PR.
- Note:  `test/stale-running-runs.test.ts` fails two cases on this machine under that load, reproduced identically on an
  unmodified `git stash` of `origin/main`, so it is a pre-existing environment flake and not caused by this change.  Its
  "started only 1 minute before boot" case depends on the vitest worker's own `process.uptime()` staying under 60 seconds,
  which is why the new adoption-grace cases live in their own file rather than being appended to it.

## Notes and follow-ups

- **Auto-merge was deliberately NOT armed on this PR.**  Merging `main` auto-deploys production
  `socratictrade.com`, this diff touches both run lifecycle and a fraud/receipt gate, and board row
  `bdc2b662` is an open P0 about agent code reaching live trading with no human review.
- Scoped honestly: on current `main` the provider authority is **not** in fact left undefined on
  the Qdrant read path — #3158 added a `qdrantProviderAuthority()` fallback that always returns a
  value, and the client-side receipt predicate already refused managed matches without an
  authority.  The reachable half of defect (2) is the skipped R7 metric guard; the gate changes
  here are fail-closed hardening so the behaviour cannot be weakened by accident later.
- Nothing here validates the **Qdrant** collection's distance metric.  R7's cosine-floor argument
  applies to the Qdrant mirror on the read path just as it did to Pinecone; that check does not
  exist yet.  Filed as a follow-up rather than fixed here.
