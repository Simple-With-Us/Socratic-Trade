# 2026-08-09 — EDGAR 403 worker hardening: UA injection, block-aware deferral, dead-letter requeue

## Context & Objective

Minutes after the trial knobs + full-universe seed went live, every SEC ingest worker fetch
started failing `HTTP 403` from `www.sec.gov/Archives`, dead-lettering ~50 healthy tasks and
flipping 10 jobs to `complete_with_errors`. Root cause chain: (1) the worker called
`politeFetchText(url)` with NO headers, so document fetches went out without any User-Agent —
SEC's fair-access policy hard-403s undeclared automated tools (the refresh lane passes
`secUserAgent()` explicitly, which is why it hummed at 13k records/hour while every worker fetch
died); (2) prod had no `SEC_EDGAR_USER_AGENT` secret, so even UA-carrying lanes identified with
the fallback string that has no real contact; (3) the shared `secLimiter` only reacts to 429,
but EDGAR signals blocks with 403; (4) the worker classified 403 as a retryable task failure,
burning stage attempts into an IP-level block until healthy filings dead-lettered.

## Changes Made

- `src/lib/web-sources/http.ts` — `politeFetch` now injects `secUserAgent()` on any `.sec.gov`
  request whose caller didn't set a user-agent (defense in depth: no call site can ship UA-less
  again), and reports SEC 403s to the limiter alongside the existing 429 path.
- `src/lib/web-sources/sec-limiter.ts` — new `report403()` pauses ALL EDGAR requests for a
  cooldown (default 600s, `SEC_403_COOLDOWN_SECONDS`); new `pausedUntilIso()` exposes the pause
  horizon so queued work can defer to it.
- `src/lib/rag/sec-ingest-worker.ts` — a 403 from the document fetch now mirrors the WU-breaker
  deferral (`deferSecIngestTask`, attempt refunded, `reasonType: "edgar_403_deferred"`) instead
  of `failSecIngestTask`; a block can no longer march tasks to dead_letter.
- `src/lib/db-rag-ingest.ts` — new `requeueSecIngestDeadLetters({jobIds?, errorTypeLike?})`:
  flips dead_letter tasks back to retry_wait with a fresh stage-attempt budget and reopens their
  `complete_with_errors` jobs (deliberate direct UPDATE — `JOB_TRANSITIONS` keeps
  complete_with_errors terminal for every other caller).
- `app/api/admin/sec-ingest/route.ts` — new `POST {action:"requeue-dead-letter"}`.
- `test/sec-ingest-worker.test.ts` — two new tests: 403 → defer (status retry_wait, attempt
  refunded, checkpoint intact) and dead-letter requeue (task claimable again, job reopened).

Ops (no code): `SEC_EDGAR_USER_AGENT` set in ST Infisical prod (descriptive UA with real
contact); takes effect on next deploy/restart, i.e. when this PR auto-deploys.

## Decisions & Trade-offs

- 403 detection matches `politeFetchText`'s thrown `HTTP 403 ...` message shape rather than
  threading a typed error through — smallest change; revisit if politeFetch grows typed errors.
- Requeue resets `stage_attempts` to 0 (fresh budget) but leaves `total_attempts` intact, so
  attempt history/audit stays truthful.
- The seed route remains abort-on-first-issuer-error; Cloudflare 524s at ~100s but the handler
  continues server-side — seeding is idempotent, so operators re-POST until `totalJobs` covers
  the manifest. Not changed here.

## Verification State

- `npx vitest run test/sec-ingest-worker.test.ts test/rag-ingest-worker.test.ts
  test/sec-ingest-seeder.test.ts test/sec-backfill-p2.test.ts` — 4 files / 35 tests green.
- `npx tsc --noEmit` — clean. Full lint/test/build run via `scripts/land.sh` gates (see PR).

## Next Steps & Blockers

- After deploy: `POST /api/admin/sec-ingest {action:"requeue-dead-letter"}`, confirm the ~50
  dead-lettered tasks return to retry_wait and jobs reopen; watch worker logs for 403-free
  fetches under the proper UA and checkpoints advancing past `discovered`.
- If 403s persist even with the UA (IP reputation), raise `SEC_403_COOLDOWN_SECONDS` and/or
  lower `SEC_RATE_LIMIT` (limiter default 4 req/s, burst 8) before considering anything else.
