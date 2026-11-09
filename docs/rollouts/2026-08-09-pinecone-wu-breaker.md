# 2026-08-09 — Pinecone monthly write-unit (WU) exhaustion breaker (MONET)

Branch: `monet/pinecone-wu-breaker` (lane `~/apps/trading-monet`). Commit-only; landing
operator runs the full gate + `land.sh`.

## 1. Context & Objective

Production Pinecone upserts have been failing hourly with
`HTTP 429: "…You've reached your write unit limit for the current month (2000000). To
continue writing data, upgrade your plan. Status: 429."` — the Starter plan's monthly write
quota was exhausted by the 10-K backfill. Three concrete costs, every hour until the 1st of
the month: (1) provider_degraded alert spam; (2) **wasted paid spend** — `storeContexts`
dedups by content_hash of *stored* documents, so docs whose upsert failed are re-embedded
through paid OpenRouter every retry cycle before the upsert 429s again; (3) the durable
`sec_ingest` queue grinds retries into a quota that cannot recover before the month reset.

This adds a spend/correctness breaker (same class as the R2 kill-switch — advisory
philosophy preserved: it self-clears, is one deletable settings row, and gates only
provably-unwinnable *writes*; reads/RAG retrieval are untouched).

## 2. Changes Made

**Architecture:** a persistent marker (`settings` key `pinecone:wuExhaustedUntil` = first
day of NEXT month UTC, computed from the error time) is tripped by detection in the Pinecone
error path and checked by an early gate in every vector-write entry point *before any
embedding happens*. Auto-clears two ways: gate expiry (marker date passed → writes resume),
and eagerly when any Pinecone WRITE succeeds (plan upgraded mid-month).

- `src/lib/pinecone-wu-breaker.ts` **(new)** — matcher
  (`/write unit limit for the current month/i` AND a 429/rate-limit signal — deliberately
  narrow so ordinary per-second 429s keep normal retries), marker read
  (`pineconeWuExhaustedUntil`, fails open), `tripPineconeWuBreaker` (transition-gated: ONE
  `storage_warning` notification via `alertStorageWarning` — which itself carries the 12h
  repeat-dedup — plus one `pinecone_wu_breaker_tripped` audit row per episode),
  `notePineconeWriteSuccess` (eager clear, write-shaped ops only), `auditPineconeWuGateSkip`
  (gate audits ≤1×/UTC-day via watermark `pinecone:wuGateLastAuditDay`). ASCII/webpack-safe
  (no `os`/`node:` imports; reachable from scheduler paths).
- `src/lib/vector-db.ts` —
  - `withRagApiHealth` failure path: WU-exhaustion detection on `service === "pinecone"` →
    health row logged **soft** (`[expected-limit]` prefix, so the lane never paints hard red
    STOPPED) and the breaker trip REPLACES the generic hourly
    "Pinecone connection failed" alert for this condition.
  - `withRagApiHealth` success path: `notePineconeWriteSuccess(operation)` (eager clear).
  - `storeContextsImpl`: early gate after input normalization, BEFORE dedup bookkeeping /
    budgets / any embed call → typed result
    `{ attempted: N, indexed: 0, skipped: true, wuExhausted: true, wuExhaustedUntil }`.
  - `storeDocumentImpl`: same gate before provider discovery / commit-ledger rows / embeds;
    result additionally carries `documentComplete: false`.
  - `StoreContextsResult` gains `wuExhausted?: boolean` + `wuExhaustedUntil?: string`.
- `src/lib/db-rag-ingest.ts` — **`deferSecIngestTask` (new)**: cleanly PARKS a leased task
  (status `retry_wait`, `next_retry_at` = caller instant clamped to [now+60s, now+35d]) and
  **refunds the stage attempt** the claim consumed, so waiting out the quota can never march
  a healthy task to dead_letter. `total_attempts` is deliberately NOT refunded (attempt
  receipts key on it via UNIQUE(task_id, attempt_no)). Same owner/lease-token/running-job
  fencing as `failSecIngestTask`; attempt receipt closes with outcome `retry_wait` and
  reason type `wu_exhausted_deferred`.
- `src/lib/rag/sec-ingest-worker.ts` — `embed_queued` stage checks the marker FIRST (before
  artifact reads / any embed) and defers to the marker expiry; if `storeDocument` reports
  `wuExhausted` mid-call (raced the gate), same deferral instead of the old
  throw → `failSecIngestTask` retry storm.
- `src/lib/web-sources/sec-filings.ts` — `ingestFiling` preflights the marker next to the
  existing `hasIngestTextBudget` check (skips the EDGAR fetch/chunk work entirely), and the
  post-store `outOfCapacity` classification includes `result.wuExhausted` so the bulk
  backfill loop stops at the first gated filing (accessions stay un-recorded; retried after
  reset).
- `src/lib/db-health.ts` — `HealthStoppedReasonKind` gains annotation-only kind
  `"expected-limit"`.
- `app/api/admin/connections-health/route.ts` — while the marker is active the pinecone lane
  is annotated `stoppedWorking: true, stoppedReasonKind: "expected-limit",
  stoppedReason: "monthly write units exhausted · resumes <date>"`.
- `app/admin/connections/connections-health-client.tsx` — `"expected-limit"` counts as SOFT
  in `isHardStopped` (yellow `LIMIT` chip + the resume-date copy, never red STOPPED).
- `test/pinecone-wu-breaker.test.ts` **(new)** — 9 tests, see §4.

## 3. Decisions & Trade-offs

- **One notification per episode, via `storage_warning`.** The trip is transition-gated (an
  active marker never re-notifies) AND `alertStorageWarning`'s existing 12h cooldown backs
  it up. The generic per-detection `alertRagConnectionFailure` (source of the hourly spam)
  is suppressed only for this specific condition; all other Pinecone failures alert as
  before.
- **Eager clear keys on Pinecone WRITE successes only** (`upsert|commit|update|delete|
  erase|purge` operation names). Reads succeed while writes are exhausted, so a query
  success must not clear. Residual edge: if Pinecone permits deletes over quota, an
  account-erasure delete could clear the marker early — the next ingest cycle then wastes
  one embed batch, re-detects, re-trips (notification still deduped). Self-healing and
  bounded; accepted.
- **Deferral refunds `stage_attempts`, not `total_attempts`** — see §2; refunding
  total_attempts would collide attempt receipt UNIQUE keys.
- **Marker computed from error time** (`first day of next month UTC`), not Pinecone
  headers — the 429 body carries no reset instant. If Pinecone's billing month is anchored
  differently, the eager success-clear corrects an over-long marker the moment a write
  succeeds after the true reset (and the daily sec-filings tick retries then).
- **No new admin UI** (per task). Manual clear one-liner against the prod DB
  (`/app/data/app.db` in the container):
  `sqlite3 app.db "DELETE FROM settings WHERE key = 'pinecone:wuExhaustedUntil';"`
  (or upgrade the Pinecone plan — the next successful write clears it automatically).
- Gate placement is *inside* `storeContextsImpl`/`storeDocumentImpl` so every producer
  (socratic-memory lessons/decisions, disclosure embeds, 8-K/10-K/10-Q filings,
  transcripts, document summarizer, corpus re-embed, SEC ingest worker) is covered without
  per-caller wiring; the sec worker/filings ALSO pre-check to skip artifact/EDGAR work.

## 4. Verification State

```
npx tsc --noEmit                                    # clean
npx vitest run test/pinecone-wu-breaker.test.ts     # 9/9 green
npx vitest run test/pinecone-wu-breaker.test.ts test/disclosure-rag.test.ts \
  test/lesson-vectors.test.ts test/rag-embed-provider-gate.test.ts \
  test/vector-db-lease-fencing.test.ts test/rag-ingest-worker.test.ts \
  test/sec-ingest-worker.test.ts test/sec-ingest-seeder.test.ts \
  test/sec-filings.test.ts test/sec-backfill-p2.test.ts \
  test/web-sources-sec.test.ts test/web-sources-sec8k.test.ts \
  test/soft-health-failures.test.ts test/connections-health-route.test.ts \
  test/connection-health-routing.test.ts test/health-lane-cap.test.ts
                                                    # 16 files, 201 tests, all green
npm run lint                                        # 0 errors (728 pre-existing warnings)
```

New tests cover: matcher specificity (prod error string yes; month-text without 429 no;
plain 429 no), marker = first-of-next-month UTC incl. year rollover, once-per-episode
notification + audit dedup, gated `storeContexts` returning the typed skip with **zero
fetch calls** (embed provably never invoked) + once-daily gate audit, eager clear on write
success (reads don't clear), expired-marker auto-resume, `deferSecIngestTask` park/refund/
re-claimable-after-expiry semantics, worker parking at `embed_queued` without calling
`storeDocument`, and the mid-call `wuExhausted` deferral race.

Full `npm test` / `npm run build` deliberately not run here (task scope) — landing operator
runs the complete gate.

## 5. Next Steps & Blockers

- Landing operator: full gate (`npm run lint`, `npx tsc --noEmit`, `npm test`,
  `npm run build`) then `bash scripts/land.sh`.
- After deploy: confirm on prod that (a) the next upsert 429 trips the breaker (one
  storage_warning, `pinecone_wu_breaker_tripped` audit), (b) hourly provider_degraded spam
  stops, (c) `/admin/connections` pinecone lane shows the yellow `LIMIT`
  "monthly write units exhausted · resumes 2026-09-01" state, (d) `sec_ingest_tasks` at
  `embed_queued` move to `retry_wait` with `next_retry_at = 2026-09-01T00:00:00.000Z`.
- Owner decision (not blocking): upgrade the Pinecone plan mid-month vs. wait for the
  Sep 1 reset. Either path resumes ingest automatically.

## 6. Zero-Code Findings

- `isSoftHealthFailure`'s free-text shapes did NOT match this Pinecone message ("Status:
  429" is not "HTTP 429"; "write unit limit" is not "rate limit") — before this change the
  pinecone lane could hard-STOP red on five such rows. Now stamped soft at the source.
- The sec-filings bulk loop already had exactly the right stop semantics
  (`budgetExhausted`) from the 2026-07-10 daily-budget burst; the breaker reuses it.
