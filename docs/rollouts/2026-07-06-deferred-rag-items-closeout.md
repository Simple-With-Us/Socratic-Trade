# 2026-07-06 — Deferred RAG items closeout (#1019 / #1021)

Agent: CLAUDE. Fresh worktree off `origin/main`, branch `claude/deferred-rag-closeout`. Docs-only
closeout — no `src`/`test` changes.

## Summary

The CLAUDE next-wave RAG retrieval-quality cluster (`docs/rollouts/2026-07-06-claude-nextwave-rag.md`,
board entry "CLAUDE next-wave: RAG retrieval-quality + corpus-integrity cluster") triaged 9 candidate
items same day, shipped 5 as PRs (#970/#973/#974/#977/#979), found 3 already done, and explicitly
**deferred** the 9th — "Server-side numeric as-of epoch filter in Pinecone" — because it needed an
ingest-time numeric-epoch backfill on existing vectors plus a fail-open-vs-fail-closed owner decision
before it could ship. The owner approved both deferred items the same day. Each was then built,
independently reviewed, fixed pre-merge, and landed as its own PR:

- **PR #1019** (`claude/server-asof-filter`) — server-side as-of Pinecone filter.
- **PR #1021** (`claude/persist-pool-v2`) — persist-pool v2 (pre-`rankPool` candidate pool with
  per-stage drop dispositions).

Both are merged to `main` as of 2026-07-06. This note closes out the board bookkeeping: the two
"In Progress" rows each landing left on `docs/EFFORT-LOG.md` are now rewritten as Completed entries
under the "✅ Completed" heading, and the original DEFERRED bullet in the next-wave cluster's board
entry is annotated DONE with pointers to both PRs.

## The problem #1019 solves: empty/small pools in backtests

`retrieveContextDetailed` over-fetches `overFetchK`/`rerankOverFetchK` (~15 non-rerank / ~150 rerank)
candidates from Pinecone by pure vector similarity with **no date filter**, then `rankPool` applies
`isWithinAsOf` **post-fetch** to drop chunks dated after `options.asOf`. In a backtest (`asOf` set to
a past date) the top-K nearest neighbors are dominated by too-recent filings that then get dropped,
leaving a tiny or empty pool — even though the correct older, eligible filings exist in the corpus,
just ranked below the fetch window and therefore never retrieved at all. Pushing the date constraint
INTO the Pinecone query (rather than filtering after the fact) fills `topK` with eligible candidates,
so the older filings that should win are actually fetched.

## Fail-open vs fail-closed decision

Two additive, independently-gated pieces:

- **Ingest**: `cleanMetadata` (`src/lib/vector-db.ts`) additively stamps a numeric `as_of_epoch_ms` on
  every newly-upserted vector, derived from the same precedence the post-fetch guard already uses
  (`acceptance_datetime -> published_at -> as_of -> timestamp`). Absent when no date resolves —
  absence is the fail-open signal, not an error.
- **Query**: `VECTOR_ASOF_SERVER_FILTER` (new flag, **default OFF**) AND-combines a server-side epoch
  clause with the existing symbol/scope/docType filter, on both the shared-tier and user-tier Pinecone
  queries:
  - **FAIL-OPEN (default)**: `$or: [{as_of_epoch_ms:{$lte:X}}, {as_of_epoch_ms:{$exists:false}}]` —
    keeps epoch'd-and-eligible OR un-epoch'd vectors, so an un-backfilled corpus is never silently
    dropped from retrieval.
  - **FAIL-CLOSED** (`VECTOR_ASOF_STRICT=on`, existing flag, escalates the server clause too): plain
    `{as_of_epoch_ms:{$lte:X}}` — drops un-epoch'd vectors server-side, for leakage-certified
    backtests where an operator has confirmed the backfill ran.
  - The post-fetch `isWithinAsOf` guard in `rankPool` **stays as the backstop regardless** of server
    filtering (defense in depth) — `asOf` unset or the flag off means the filter is byte-identical to
    pre-#1019 behavior.
- **Operator step required before the improvement is fully effective**: run
  `scripts/backfill-asof-epoch.ts` (dry-run first via `BACKFILL_DRY_RUN=1`) against production. It's
  idempotent (skips vectors that already have a finite epoch) and safe to re-run. Fail-open means
  retrieval is never broken by skipping this step, but the topK-fill improvement only reaches
  pre-existing (pre-epoch) vectors once the backfill completes.

Fail-open was the owner-approved default specifically so the flag can be turned on safely before the
backfill has run everywhere; fail-closed is reserved for leakage-certified backtest runs.

## persist-pool v2: pre-rankPool dispositions

PR #979/v1 (`RAG_PERSIST_CANDIDATE_POOL`) honestly documented its own limitation: it captures only
`rankPool`'s OUTPUT pool (`ordered`), which is already post minScore/asOf/hybrid/rerank/dedupe. In the
flagship production caller (`strategy.ts`'s filings pass: `dedupeSimilarity=0.6`, `limit=3`), both
`dedupeSimilar` and `rerankMatches` already hard-cap their own output at `limit`, so `ordered.length <=
limit` holds essentially always there — meaning v1 rows are nearly all `used:true`, with zero
visibility into the actually-interesting minScore/asOf/dedupe/rerank drops upstream.

v2 (PR #1021) closes that gap: `rankPool` gained an optional `onDispositions` hook that tracks every
input candidate through each filtering stage (minScore → asOf → rerank-truncate → post-rerank
relevance floor → dedupe → `kept_not_used`/`used`), byte-identical/zero-cost when the hook is omitted
(every existing call site, including every test in `test/rag-retrieval-regression.test.ts`).
`retrieveContextDetailed` wires a new, independent flag `RAG_PERSIST_CANDIDATE_POOL_FULL` (**default
OFF**) that captures the PRE-`rankPool` `matches` pool (raw Pinecone recall, or the #822 fused
multi-query pool) plus the disposition map, persisted via `recordCandidatePoolFull` under a new,
distinct audit kind `rag_candidate_pool_full` — v1's `rag_candidate_pool` kind is untouched, and the
two flags toggle independently. Same "never persist raw chunk text" posture as v1: candidates carry
only id/score/relevanceScore/docType/asOf/disposition.

## Review findings caught pre-merge

Both lanes went through independent review before landing. Findings, all fixed pre-merge:

- **#1021 — `dropped_dedupe_truncate` mislabel.** `dedupeSimilar` drops candidates for two
  structurally different reasons that the original disposition loop conflated into one label: a
  genuine Jaccard-similarity near-duplicate judgment, and its own internal `if (kept.length >= limit)
  break` top-`limit` cap. On the flagship production config (`limit=3`, `dedupeSimilarity=0.6`), the
  cap fires on almost every run, so distinct non-duplicate candidates cut purely by the cap were
  mislabeled `dropped_dedupe` — falsely implying near-duplication. Fixed with a new
  `dropped_dedupe_truncate` disposition, backed by an optional `report` out-param on `dedupeSimilar`
  that distinguishes genuinely-judged duplicates from candidates that never got compared before the
  cap filled.
- **#1021 — id-less rerank-survivor mislabel.** `rerankMatches` returns a new spread object for every
  candidate Voyage scores, including id-less ones — so an id-less match that survives rerank does not
  keep its original object identity. The v2 capture block's identity-based lookup assumed that case
  was impossible, so an id-less rerank survivor was mislabeled `dropped_rerank_truncate` and lost its
  `relevanceScore` even though it was actually used. Fixed by stamping a stable `__poolKey` onto every
  id-less match before rerank runs (v2-only, no-op otherwise), which survives the spread copy and gives
  every id-less match a stable key exactly like a real Pinecone id.
- **Capture-never-breaks-retrieval guard (v1 and v2).** Both the v1 and v2 observability-capture
  blocks in `retrieveContextDetailed` ran before `return finalChunks`, protected only by the function's
  outer catch (which returns `[]` on any throw) — so a throw anywhere inside either capture block
  (mapping, hashing, key computation) would have silently discarded a fully successful retrieval,
  backwards for an advisory-only feature. Fixed by wrapping both capture blocks in their own local
  try/catch that swallows and logs (`console.warn`) rather than re-throwing. Applied to both v1
  (defense in depth — the same exposure existed on `main` before this lane) and v2.
- **#1021 — defensive hard cap.** `recordCandidatePoolFull` persisted `matches.length` candidates
  uncapped; `matches` is bounded by `fetchK`, which for the rerank path (`rerankOverFetchK(limit)`) is
  env-tunable above its 150 default via `VECTOR_RERANK_OVERFETCH_K` with no upper clamp. Added
  `MAX_PERSISTED_CANDIDATES_V2 = 500` as a generous backstop; `candidateCount` in the payload still
  reports the true (pre-cap) length so a capped payload is honestly labeled.
- **#1019 — Pinecone `$exists` verification, not assumption.** Verified against the installed
  `@pinecone-database/pinecone@8.0.0` client that the query `filter` parameter is typed as an opaque
  `object`, so `$or`/`$lte`/`$exists` all typecheck and forward through unmodified — the fail-open
  mechanism needed no design compromise (no two-query union, no forced two-behavior split). Also
  caught and fixed a filter-merge subtlety: the shared-tier base filter already carries a top-level
  `$or` (scope/userId coexistence), and the fail-open epoch clause is itself an `$or` — a naive spread
  would silently drop one (a JS object can't hold two identical keys), so `mergeAsOfEpoch` promotes to
  `$and: [base, epoch]` whenever an epoch clause is present, covered by a dedicated test.

## Files (this closeout PR only)

- `docs/EFFORT-LOG.md` — moved the persist-pool-v2 "In Progress" rows (original + review-fix update)
  to a "✅ Completed" entry for PR #1021; moved the server-asof-filter "In Progress" row to a
  "✅ Completed" entry for PR #1019; annotated the original "Server-side numeric as-of epoch filter in
  Pinecone" DEFERRED bullet with a "(2026-07-06: DONE — PR #1019 / #1021)" pointer.
- `STATUS.md` — prepended a dated "2026-07-06 — deferred RAG items landed" section pointing at both
  PRs and this note (each PR's own landing already added its own detailed STATUS.md section further
  down; this new section is a short top-of-file pointer, not a replacement).
- `docs/rollouts/2026-07-06-deferred-rag-items-closeout.md` — this note.

For the full technical detail of each lane (files touched, exact test names, verification commands),
see the two per-lane rollout notes:

- `docs/rollouts/2026-07-06-server-asof-filter.md`
- `docs/rollouts/2026-07-06-persist-pool-v2.md`

## Verification

Docs-only change. Ran the standard gate via `scripts/land.sh` (tsc/test/build), which re-verifies the
already-merged code this note describes; no `src`/`test` files touched by this PR itself.

## Follow-ups

- **Operationally run the epoch backfill in production** (`scripts/backfill-asof-epoch.ts`, dry-run
  first via `BACKFILL_DRY_RUN=1`) before flipping `VECTOR_ASOF_SERVER_FILTER` on. Fail-open means
  retrieval stays safe either way; the backfill just makes the topK-fill improvement effective for the
  existing (pre-epoch) corpus.
- Both `VECTOR_ASOF_SERVER_FILTER` and `RAG_PERSIST_CANDIDATE_POOL_FULL` remain **default OFF**
  pending eval/operator decision — this closeout does not change either default.
