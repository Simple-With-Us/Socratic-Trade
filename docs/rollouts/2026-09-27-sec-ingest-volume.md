# 2026-09-27 — SEC ingest throughput and corpus breadth (seat: MiniMax)

Branch: `minimax/sec-volume-breadth`.  Worktree: `~/apps/st-mm-sec-volume`.  Base: `origin/main`
@ `d0440ed22`.  Two P0 fixes in the SEC/EDGAR ingest tick plus four breadth items, each in its
own commit.

## Context & Objective

The SEC/EDGAR backfill lane had effectively stopped making progress while looking healthy.  A
prior audit against `main` found two starvation bugs in `SecIngestWorker.runTick` and one
per-document throughput bug in `processTask`, and four places where the corpus could not grow
past "1x 10-K + 4x 10-Q primary documents, no abstracts, no 13F, no insider filings".  The
objective was to make the tick fair and make each document cost one tick instead of eleven,
then to widen what the lane can ingest at all — without touching the parser, the chunker, the
dead-letter discipline, the RTH/strategy gates or the EDGAR rate limit.

## Changes Made

### P0-1 — the tick starved every job but the first

`runTick` read `SELECT id FROM sec_ingest_jobs WHERE status = 'running'` with **no ORDER BY** and
handed the ENTIRE per-tick budget to the first job that had claimable tasks
(`claimSecIngestTasks` filters `WHERE t.job_id = ?`).  With ~500 running jobs, issuer #1 took all
5 slots every tick and every other issuer sat at `discovered` forever — the file's own comment
admits 2,156 tasks pending since 2026-08-10.

- **`claimSecIngestTasksAcrossJobs` (new, `src/lib/db-rag-ingest.ts`).**  Takes one fair slice per
  running job using `ROW_NUMBER() OVER (PARTITION BY t.job_id ...)`, so the per-job ceiling is
  applied by the database rather than by a loop over 500 jobs, then orders that union by
  `priority DESC, created_at ASC, id ASC` and takes `limit`.  If the fair window comes back short
  (a lone job is the only thing with work left) the claim tops the tick up from the same order
  *without* the ceiling: fairness bounds starvation, it does not cost throughput when there is
  nothing to be fair to.  Default `perJobLimit` is `ceil(limit / 2)`.
- **`claimSecIngestCandidate` (new, internal).**  The lease-expiry / dead-letter / attempt-receipt
  body is now shared by both claim paths, so the round-robin claim cannot drift from the
  per-job claim on attempt accounting.
- `runTick` now makes one cross-job claim, then reconciles only the jobs that actually produced
  claims (a sweep over all ~500 running jobs every 5s on a box that also serves quotes is waste).
- `SEC_INGEST_TASKS_PER_TICK` (5) is unchanged as the per-tick ceiling.

### P0-2 — one checkpoint per claim cost 11 cycles per document

`advanceSecIngestTask` deliberately RELEASES the lease (it returns the task to `pending` with the
lease cleared) because a checkpoint is a durable handoff point.  Every one of the 11 advance sites
was followed by an immediate `return`, so one document needed 11 separate claim→process→advance
cycles: at 5 tasks/tick, a 5s tick and a serialized `tickInFlight`, ~11x less throughput than the
cap implies.

- **`reclaimSecIngestTaskForStage` (new).**  Re-leases ONE already-advanced task for its next
  stage in the same process, through the same claim accounting: new attempt receipt,
  `total_attempts` bumped, `stage_attempts` re-armed at 1 (advance already reset it to 0), job
  must still be `running`.  Returns `null` when the task is no longer claimable (complete, job
  left `running`, another worker won), and the caller treats that as "stop; the durable state is
  authoritative".
- **`processTask` is now a drain loop around `runTaskStage`.**  Each stage returns `true` only
  when the checkpoint advanced.  The drain stops on any terminal state, deferral, failure or
  budget park — all of which already existed inside the stage body.
- **`SEC_INGEST_TASK_DRAIN_BUDGET_MS` (120s)** bounds one task's drain.  On expiry (or a strategy
  run / RTH boundary) the task is released with `releaseSecIngestTaskForResume`, which REFUNDS the
  stage attempt, so it resumes from whatever checkpoint it reached instead of dead-lettering or
  waiting out a lease.
- The strategy-work and RTH gates are re-checked **at every stage boundary**, not just before the
  drain.  A drain that starts outside RTH (or before a Manual Run once lands) can run many stages
  back to back, so a single pre-drain check is not enough.

### B-1 — `FormType` union (`src/lib/web-sources/sec-filings.ts`)

`FilingRef.docType` was the literal `"10-K" | "10-Q"`, duplicated into `FilingTypeLimits`,
`resolveFilingLimits`, `parseRecentFilings` and `fetchRecentFilings`.  `FormType` now names the
forms the app can route, and stays OPEN via a `(string & {})` member on purpose: a form EDGAR adds
— or one already persisted in `ingested_accessions` / a stored `doc_type` — stays a valid value
rather than a type error, and every existing caller still compiles.  `secAbstractSourceType` and
`secAbstractFormHint` replace the duplicated ternaries and preserve 10-K/10-Q keys exactly
(`document_abstracts` is keyed by (accessionOrEventId, sourceType); changing those strings would
orphan every stored abstract).

### B-2 — the backfill lane now produces abstracts (`src/lib/rag/sec-ingest-worker.ts`)

`document-summarizer.ts` is deliberately extractive (`DOCUMENT_HIGHLIGHT_MODEL =
"extractive-highlights-v2"`, no LLM on the ingest path) and is unchanged.  The missing piece was
the caller: the worker never invoked it, so every backfilled filing landed with no abstract while
`information-routing.ts` reads abstracts to decide a document answers a question.  The highlighter
now runs in `embed_queued`, right next to `storeDocument`, mirroring `sec-filings.ts` / `sec8k.ts`.
Guarded by `abstractNeedsUpgrade` (idempotent across resumes) and wrapped in a catch: the document
is already embedded at that point, so an abstract failure must never cost the vectors.

### B-3 — 13F and ownership forms reach the vector corpus

- `thirteen-f.ts` had **no `storeDocument` call anywhere in the file**.  Each successful filer
  period now writes one holdings document through the same `storeDocument` → `chunkDocument` →
  embed path as 10-K/10-Q, capped at 60 positions ranked by reported value, stamped with the
  FILING date from the EDGAR directory `last-modified` (never the period end — a 13F is filed up
  to 45 days later, and the text states that lag explicitly), best-effort and strictly after the
  durable DB write.
- Form 4/3/5: the worker already parses, chunks and embeds `.xml` ownership documents, but nothing
  discovered them.  The seeder now reads the filing directory for ownership accessions and
  enqueues the RAW `<ownershipDocument>` XML (reusing `pickOwnershipXml` from the incremental
  insider lane, because the submissions API reports the XSL-rendered path the parser cannot read).
- `information-routing.ts` `filing_narrative` gains `def 14a`, `s-1`, `13f-holdings`,
  `insider-filing` alongside 10-K/10-Q/8-K.  doc_type is a filter: a corpus form routing cannot
  name is exactly how the 13F positions stayed invisible.

### B-4 — seeder breadth (`src/lib/rag/sec-ingest-seeder.ts`)

`SEC_INGEST_BASELINE_FORM_LIMITS` (one submissions-API call per issuer): 10-K x1 and 10-Q x4
(unchanged), 8-K x2, DEF 14A x1, S-1 x1, ownership ("4") x2.  `selectMaterialExhibits` adds up to
2 material exhibits per 8-K/10-K accession — EX-99 then EX-10 then EX-19, 5 KB–5 MB, HTML only —
and refuses EX-21/EX-23/EX-31/EX-32, `R*.htm` rendered pages and images.  `fetchFilingDirectory`
previously had zero callers in the repo; exhibits were not "not selected", they were structurally
impossible.

Caps chosen deliberately: ~3x the v1 document count and ~3x its embed spend.  The corpus is
starved, not overflowing, and the 5-per-tick ceiling means a wider seed drains over time instead
of arriving as a burst.  Ownership is bounded at 2 per issuer because it is EDGAR's
highest-volume form and the structured `insider_transactions` table already serves the querying
side.  `SEC_INGEST_BASELINE_CORPUS_REVISION` is bumped to `sec-ingest-baseline-v2-breadth` —
required, not cosmetic: the v1 jobs are already sealed, and without a new natural key the wider
scope would fail to enqueue into them or silently redefine a sealed contract.  The v1 scope is
still runnable with `formLimits: {"10-K": 1, "10-Q": 4}`.

## Files

- `src/lib/db-rag-ingest.ts` — `claimSecIngestCandidate`, `claimSecIngestTasksAcrossJobs`,
  `reclaimSecIngestTaskForStage`, `claimLimit`.
- `src/lib/rag/sec-ingest-worker.ts` — cross-job claim, `SEC_INGEST_TASK_DRAIN_BUDGET_MS`,
  `processTask` drain loop, `runTaskStage`, `releaseForLaterTick`, B-2 abstract.
- `src/lib/web-sources/sec-filings.ts` — `FormType`, `DEFAULT_FETCH_FORM_TYPES`,
  `secAbstractSourceType`, `secAbstractFormHint`.
- `src/lib/web-sources/thirteen-f.ts` — `buildThirteenFHoldingsText`, `pick13FFilingDate`,
  `storeThirteenFHoldingsDocument`, `THIRTEEN_F_EMBED_MAX_POSITIONS`, wired into
  `refreshThirteenF`.
- `src/lib/rag/sec-ingest-seeder.ts` — breadth map, exhibit limit, `selectMaterialExhibits`,
  ownership-XML discovery, corpus revision bump.
- `src/lib/rag/information-routing.ts` — wider `filing_narrative` document types.
- `test/sec-ingest-worker.test.ts` — 3 fairness + 3 drain regressions, abstract assertion,
  updated "one tick → complete" expectation.
- `test/sec-ingest-seeder.test.ts` — 3 breadth regressions, updated contract test.
- `test/idea-sources-13f-ark.test.ts` — 3 holdings-document regressions.
- `test/rag-information-routing.test.ts` — updated document-type expectations.
- `STATUS.md`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

- **The fair window is a full scan, not a bounded one.**  A pre-limited window over the oldest N
  rows would reintroduce starvation the moment one job owned the whole window.  At production
  queue sizes (~2–3k claimable rows) the window function is a few ms; a future queue large enough
  for that to matter wants an index, not a smaller window.
- **The per-job ceiling is topped up when nothing else is claimable.**  A hard ceiling would cap
  throughput for a single-job queue for no fairness benefit.
- **The drain re-leases instead of holding one lease across the document.**  Holding the lease
  would be simpler but would break the crash-recovery contract: a crash mid-document must be
  recoverable by any worker, and the checkpoint is where that handoff lives.
- **A released drain task refunds its stage attempt.**  Otherwise a drain that repeatedly hits
  the 120s wall on a large 10-K would burn all 6 stage attempts and dead-letter a document that
  only ever needed more time.
- **B-2 runs the summarizer on the worker path even though the direct path already did.**  The
  two entry points disagreed; making the worker call the same helper is smaller than unifying the
  callers, and the abstract is idempotent.
- **13F is stamped with the filing date, not the period end.**  Period-end stamping is simpler and
  would silently break as-of retrieval, which is a correctness property this corpus has been held
  to elsewhere (the Form 4 availability floor).
- **`formLimits` replaces the breadth map wholesale** rather than merging, so "run the v1 scope"
  is expressible without a second option flag.

## Verification

Run in this order in `~/apps/st-mm-sec-volume`:

- `npx tsc --noEmit` — clean (0 errors).  (The pre-existing `test/alternative-data.test.ts`
  `mockFetcher` / `URL | RequestInfo` mismatch was NOT present on this branch's base; tsc is
  fully clean.)
- `npx vitest run test/sec-ingest-worker.test.ts` — 41/41 pass (6 new regressions).
- `npx vitest run test/sec-ingest-seeder.test.ts` — 10/10 pass (3 new).
- `npx vitest run test/idea-sources-13f-ark.test.ts test/rag-information-routing.test.ts` — 21/21.
- `npx vitest run test/sec-backfill-p2.test.ts test/sec-ingest-priority.test.ts test/sec-filings.test.ts test/rag-sec-document.test.ts test/disclosure-rag.test.ts` — pass.
- `npm run lint`, `npm test` (full), `npm run build` — see the PR body for the recorded results.

## Deliberately NOT done (deferred, listed so they are not re-litigated)

- **The universe manifest is untouched.**  It is 100% sentinel data frozen 2026-07-12 and
  `demand-first-symbols.ts` reads issuer rank from it.  Regenerating it needs live provider data
  and is a separate effort.  Every change here is manifest-independent.
- **The EDGAR rate limit stays at 4 req/s** (`sec-limiter.ts`), not raised toward SEC fair-access
  10 req/s.  Separate PR.
- **`PINECONE_SIGNAL_ITEM_CODES` Item 8 question** (`pinecone-write-class.ts:13`) needs an owner
  ruling, not a code change.
- **No new index** on `sec_ingest_tasks` for the cross-job claim.  The existing
  `idx_sec_ingest_tasks_claim` leads with `job_id`, so a status-only filter is a scan; a migration
  is the right fix if the queue ever outgrows that.

## Review round (Sentry code review, 2026-09-27) — two real findings, both fixed

Both were verified against the code rather than waved through, and both were introduced by this
branch:

1. **HIGH — a mid-drain stage failure was recorded against a stale lease token.**  The drain
   re-leases between stages (`reclaimSecIngestTaskForStage` issues a NEW token), so the
   `failSecIngestTask` in `runTick`'s catch — which carries the token from the original claim —
   matched nothing once a LATER stage threw.  The failure was dropped, the task sat `leased` until
   the lease expired, and the lease-expiry path then re-claimed it and marched it into a
   dead-letter: a transient error reported as a permanently dead document.  Fixed by
   `runStageRecordingFailure`, which records the failure against the CURRENT lease (and warns if
   even that does not apply); `runTick`'s catch stays as the fallback for non-stage errors.
   Regression: a task driven to throw at `facts_extracted` (fifth stage, four re-leases in) lands in
   `retry_wait` with `worker-error`, lease columns cleared, not dead-lettered.
2. **MEDIUM — the ownership-XML directory read was gated on the wrong form's limit.**
   `formLimits["4"]` was gating Form 3/4/5 together, so a caller asking only for "3" (or only "5")
   queued the unparseable browse-edgar URL and silently dropped the raw XML, and an unrequested
   ownership form still spent a directory read.  Fixed by gating on `formLimits[ref.docType]`.
   Regressions: form 3/5 without form 4 enqueues both raw XMLs; an unrequested ownership form makes
   zero directory calls.

Docs updated: STATUS.md, docs/EFFORT-LOG.md, docs/rollouts/2026-09-27-sec-ingest-volume.md

## Incidents during this change

- **Another lane's edit leaked into this branch.**  A `git add -A` on the coverage-test commit swept
  up `ios/SocraticTradeTests/Fixtures/policy-contract.json`, which had been written into this
  worktree by a different MINIMAX session (its commit `307ec6f9c` on `minimax/outcome-closure`).
  It is restored to `origin/main`'s content here so this PR carries only SEC-ingest work; the
  change is preserved on that session's own branch.  Worth knowing that two sessions were writing
  into one worktree tree at the same time.
- **`node_modules` was deleted out from under this worktree** mid-verification (20:00), which made
  `land.sh`'s `tsc` step report thousands of `TS2307 Cannot find module 'vitest'` errors against
  files that had type-checked minutes earlier.  A second worktree (`st-mm-renovate-dedupe`) lost
  its `node_modules` at the same moment and the disk was at 94% (28 GiB free), so this reads as
  disk-pressure cleanup rather than anything this branch did.  `npm ci` restored it and every
  gate re-ran clean from scratch.

## BLOCKER at handoff: `node_modules` keeps being deleted mid-verification

Four separate verify attempts were destroyed by the same external cause.  At ~20:00, ~21:16,
~22:08 and ~23:35 local, this worktree's `node_modules` (and `.next`) were deleted while a gate was
running — 541 packages down to 0, 348, 130, 320.  The symptoms are unmistakable and always of the
form `Cannot find module 'vitest'` / `Cannot find module 'lodash'` / `Cannot find module
'is-plain-obj'` (a `react-markdown` transitive) / `Property 'not' does not exist on type
'Assertion<...>'` (`@types/chai` gone), across files this branch does not touch.  A sibling worktree
(`st-mm-renovate-dedupe`) lost its `node_modules` in the same window, the disk was at 90-94% full,
and CleanMyMac plus the fleet `housekeeper`/`mac-cleanup` job were running.  Nothing in this branch
writes outside its worktree, and the failures reappear identically after a clean `npm ci`.

Consequence: `scripts/land.sh` cannot complete its gate, so the two review-round fixes
(`0d6bd69ae`) are committed and verified locally but NOT yet pushed, and PR #3915 still points at
`60dcc4197`.  What IS proven green, on the exact tree that carries the fixes:
`npx tsc --noEmit` 0 errors; `npm test` 8,801 passed / 51 skipped / 0 failed (run standalone at
22:51 and again inside `land.sh` at 23:32 — "789 test files passed | 1 skipped", "tests pass");
`npm run build` exit 0 at 22:57; `npm run lint` 0 errors (844 pre-existing warnings).  The one
`land.sh` run that failed at `[3/3] npm run build` failed on a missing `is-plain-obj` with
`node_modules` at 320 packages — not on anything in this change.

To finish: stop the disk-cleanup job (or free space), then
`LAND_ALLOW_STALE_OVERLAP=1 bash scripts/land.sh` in `~/apps/st-mm-sec-volume`.  Nothing else is
pending.

## Follow-ups

- After this merges, the 2,156-task backlog starts draining across issuers instead of one at a
  time.  Expect higher EDGAR request volume from the wider seed (one directory call per 8-K/10-K
  and per ownership accession) — watch the 4 req/s limiter and the Pinecone write-unit breaker on
  the first full-universe seed.
- Existing v1 jobs keep their sealed task lists.  Backfilling the new form types for issuers whose
  v1 job is still open works; already-sealed jobs need the v2 corpus revision (a new seed run),
  which is what the bump is for.
- If drain-budget pressure shows up in practice (a large 10-K that legitimately needs more than
  120s of stage time), raise `SEC_INGEST_TASK_DRAIN_BUDGET_MS` before raising
  `SEC_INGEST_TASKS_PER_TICK` — the latter trades the event loop for throughput.
