# 2026-07-17 — PR #1669 parser-thread pickup (cap-reset, CLAUDE-sub)

> **Round 2 appended below** ("Round 2 — remaining 21 Codex threads") — same session,
> coordinator-directed continuation covering the rest of the unresolved review threads.

## Summary

Owner-directed pickup of the stalled Antigravity lane (`agent/ag-rag-backfill-p3`,
PR #1669 — SEC/RAG Backfill Phase 3: HTML Cheerio parser + section-aware chunker).
The lane was ~2.5h stale with 6 unresolved Codex review threads. All 6 are now
addressed:

1. **Preserve form-specific Item 1 titles** (threads `PRRT_kwDOS7mOVM6RVirl` +
   design-question twin `PRRT_kwDOS7mOVM6RlMdo`; also duplicated later as
   `PRRT_kwDOS7mOVM6Ro-Ah`). Implemented the coordinating session's decision
   (option 3 of the design question): `parseFilingHtml` now takes
   `options?: { formType?: string }`, and `standardizeTitle` applies the 10-K
   Item-code → canonical-title map ONLY when the caller passes a form type
   matching `/^10-K/i`. All other forms (10-Q, unknown) keep the raw title parsed
   from the filing text — so a 10-Q's `Item 1. Financial Statements` is no longer
   rewritten to "Business". Both production callers now pass the form type:
   `ingestFiling` (`filingRef.docType`) in `src/lib/web-sources/sec-filings.ts`
   and the `validated` checkpoint in `src/lib/rag/sec-ingest-worker.ts`
   (`task.payload.docType`).
2. **Version the accession skip with the parser revision** (threads
   `PRRT_kwDOS7mOVM6RVir4` + twin `PRRT_kwDOS7mOVM6RlMlm`). Implemented decision
   option 3: previously-ingested filings deliberately stay on v1 chunks; only
   filings not yet in the `ingested_accessions` ledger get the v2 (Cheerio,
   section-aware) treatment. No migration, no ledger clears. This is now
   documented in an explicit code comment at the `hasIngestedAccession` preflight
   in `ingestFiling`, including the sanctioned escape hatch (a one-time explicit
   invalidation of ledger rows) should a corpus-wide re-parse ever be wanted.
3. **Recognize standalone SEC section headings** (`PRRT_kwDOS7mOVM6RmSzN`).
   Added a bounded `STANDALONE_SECTION_HEADINGS` set — Risk Factors,
   Management's Discussion (and Analysis...), (Unaudited/Condensed/Consolidated)
   Financial Statements (and Supplementary Data), Legal Proceedings,
   Quantitative and Qualitative Disclosures About Market Risk, Controls and
   Procedures. Patterns are anchored to the FULL trimmed block text (a prose
   cross-reference like "see Risk Factors above" can never match) and run under
   the same structural guards as Item/Part headings (heading tag, leaf block, or
   EDGAR heading wrapper) — mirroring the anchoring discipline pinned by the
   earlier resolved threads. Codes are form-agnostic slugs (`RISK-FACTORS`,
   `MDA`, `FINANCIAL-STATEMENTS`, ...) rather than numeric Item codes, because
   the same title maps to different Item numbers on 10-K vs 10-Q.
4. **Emit valid Markdown for td-only tables** (`PRRT_kwDOS7mOVM6RmSzP`).
   `splitTableRows` with no real header row now synthesizes a neutral
   empty-cell header row of the right width above the delimiter in EVERY split
   block, so chunks are valid GFM tables instead of starting with a bare
   `| --- |` line. The first data row is NOT promoted to a repeated header
   (that approach was explicitly rejected in an earlier resolved thread); every
   data row appears exactly once across splits.

## Why

Auto-merge (squash) is armed on PR #1669 and branch protection requires all
review threads resolved + green `verify`. These 6 threads were the stale
remainder of the Codex review of the parser work; decisions for the two
design-question threads were made by the coordinating CLAUDE session (option 3
in both cases) and are implemented here exactly.

## Files

- `src/lib/web-sources/sec-parser.ts` — form-aware `standardizeTitle` /
  `normalizeItemCode` / `collectBlocks` / `parseFilingHtml(options.formType)`;
  `STANDALONE_SECTION_HEADINGS` + `matchStandaloneHeading`; td-only branch of
  `splitTableRows` synthesizes an empty header row.
- `src/lib/web-sources/sec-filings.ts` — decision comment at the
  `hasIngestedAccession` preflight; `parseFilingHtml` call passes
  `{ formType: filingRef.docType }`.
- `src/lib/rag/sec-ingest-worker.ts` — `parseFilingHtml` call passes
  `task.payload.docType` as `formType`.
- `test/sec-parser.test.ts` — existing Item-normalization test now passes
  `{ formType: "10-K" }`; 3 new regression tests (form-specific Item 1 titles,
  standalone headings incl. anchored-match negative case, valid td-only GFM
  tables with no promoted/duplicated rows).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

Run from the pickup worktree (node_modules symlinked to the main checkout's
install; `cheerio@1.2.0` had to be added there via `npm install --no-save
cheerio@1.2.0` because the shared install predated this branch's new
dependency — package.json/package-lock untouched by --no-save):

- `npx tsc --noEmit` — clean (0 errors).
- `npm test -- test/sec-parser.test.ts` — 9/9 green.
- `npm test` — 407 files / 4,679 tests, all green.
- `npm run lint` — 0 errors (548 pre-existing grandfathered warnings).
- `npm run build` — production Next.js build succeeded.

## Follow-ups / risks

- **PR #1669 is still NOT mergeable after this pickup.** Codex re-reviewed the
  lane's later pushes and posted ~20 additional unresolved threads between
  2026-07-17 00:24 and 03:16 UTC — outside this pickup's scope. They include
  two P1s on the OpenRouter/SiliconFlow embedding-provider work
  (`vector-db.ts`: alternative-provider branch unreachable when a real Voyage
  client exists; BGE vectors mixed into the Voyage Pinecone corpus without
  namespace/revision isolation) plus P2s across `sec-ingest-worker.ts`,
  `sec-facts.ts`, `search-fusion.ts`, `db-learning.ts`, and the eval harness.
  Auto-merge stays blocked until those are addressed or the owner rules
  otherwise.
- The effort-log row marking PR #1669 "COMPLETED 2026-07-16" was corrected in
  place (PR not merged); see `docs/EFFORT-LOG.md`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board) is not
  reachable from this cloud environment — the repo mirror `docs/EFFORT-LOG.md`
  was updated; the next Mac-side session should sync the live board.

---

# Round 2 — remaining 21 Codex threads (same day, coordinator-directed)

## Summary

Continuation of the same cap-reset pickup: all 21 remaining unresolved Codex review
threads on PR #1669 addressed (2 P1s + 19 P2s). No thread deferred; none declined.

**P1 corpus-integrity pair (`src/lib/vector-db.ts`):**

- **Provider routing** (`PRRT_kwDOS7mOVM6Ro6lJ`): `embedWithRetry` (and the
  same-pattern `rerankMatches`) now route by the ACTIVE provider instead of
  "does the injected client have an embed/rerank method" — the old presence
  check made the OpenRouter/SiliconFlow HTTP branch unreachable whenever a real
  VoyageAIClient existed and sent BGE/cohere model names to Voyage.
- **Embedding-space isolation** (`PRRT_kwDOS7mOVM6Ro6lQ`), implemented
  additively per coordinator decision (no purge/rewrite/re-index, no namespace
  migration): (1) `embeddingSpaceRevisionForModel` — managed vector ids /
  commit ids / receipts keep the historical bare `v1` for the Voyage space and
  get a model-suffixed revision (e.g. `v1-baai-bge-m3`) for any other model, so
  alternative-space writes can never collide with or overwrite Voyage rows;
  (2) `embedSpaceFilterForModel` — retrieval adds an `embed_model` Pinecone
  filter ONLY when a non-Voyage model is active, so a BGE query vector never
  ranks Voyage records; with Voyage active the filter is empty and legacy
  behavior (including pre-`embed_model` vectors) is byte-identical.

**Worker pipeline (`src/lib/rag/sec-ingest-worker.ts`):** serialized ticks
(in-flight guard), raw-artifact write verification before advancing past
`discovered`, acceptance-timestamp pass-through (`payload.acceptanceDateTime` →
`acceptance_datetime`) in both document builds, a 20s lease-heartbeat timer
around the long `storeDocument` call, and FTS indexing MOVED from the
pre-commit chunk stage to the `embed_queued` stage AFTER `storeDocument`
reports a complete committed document.

**Production FTS wiring (`src/lib/web-sources/sec-filings.ts`):** `ingestFiling`
(the active scheduler→refreshFilingBodies path) now mirrors committed chunks
into `document_chunks_fts` after the vector commit + accession receipt, so
hybrid retrieval has a lexical SEC corpus in production (previously only the
never-instantiated worker wrote FTS rows).

**FTS dedupe (`src/lib/db-learning.ts`):** `insertDocumentChunkFts` deletes by
occurrence identity (symbol+source+accession+hash), not globally by
content_hash — shared boilerplate across filings keeps one lexical row per
occurrence.

**Fusion (`src/lib/rag/search-fusion.ts`):** FTS queries now `ORDER BY bm25(...)
ASC` (smaller = better; the current code shape had NO ordering at all), and the
MMR embedding step uses the ACTIVE alternative provider
(SiliconFlow/OpenRouter) or deliberately selects the Jaccard fallback up front
when neither is configured — never a doomed call sending the Voyage key to a
foreign endpoint.

**SEC facts (`src/lib/web-sources/sec-facts.ts` + DDL in `src/lib/db.ts`):**
XML booleans accept `1`/`true` (owner flags and 10b5-1); document-level
`<aff10b5One>` fallback for transactions without a transaction-level indicator;
`periodOfReport` read as direct element text (child `<value>` still covered);
every `<reportingOwner>` recorded (one row per owner per transaction, owner in
the deterministic id); SEC `transaction_code` preserved in a new column
(v47 CREATE edited — table unmerged/not in production — plus guarded v50
ALTER backfill for dev DBs that already ran v47); `ingestCompanyFacts`
supports `facts.ifrs-full` for 20-F/40-F issuers and PROPAGATES operational
failures (only the explicit 404 no-data path is swallowed) so the worker
retry path works; removed a per-fact `[DEBUG]` console.log.

**Eval harness (`scripts/eval/rag-eval-harness.ts`):** metrics divided by
EVALUATED rows with a separate `skipped` count, and an ESM-safe direct-run
guard (`pathToFileURL(process.argv[1])` comparison) replacing `require.main`.

**Chunker (`src/lib/rag/chunk.ts`):** carried overlap is re-checked after a
flush and dropped when overlap+part would exceed the parent token cap (both
the section-aware and fallback paths).

## Files (round 2)

- `src/lib/vector-db.ts`
- `src/lib/rag/search-fusion.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/rag/chunk.ts`
- `src/lib/web-sources/sec-facts.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/db-learning.ts`
- `src/lib/db.ts` (v47 DDL + new guarded migration v50)
- `scripts/eval/rag-eval-harness.ts`
- Tests: `test/embedding-space-isolation.test.ts` (new),
  `test/search-fusion.test.ts` (+3), `test/sec-facts.test.ts` (+3),
  `test/rag-eval-harness.test.ts` (+1), `test/sec-ingest-worker.test.ts`
  (acceptance + post-commit FTS assertions), `test/sec-parser.test.ts`
  (+1 overlap-cap), `test/persistence-hardening.test.ts` (schema-version pins
  49 → 50 for the new migration).

## Verification (round 2)

- `npx tsc --noEmit` — clean.
- Targeted: 6 affected test files — 25/25 green.
- Full `npm test` — 408 files / 4,690 tests, all green (the only initial
  failure was the schema-version pin, updated 49 → 50 with the new migration).
- `npm run build` — production build succeeded.
- `npm run lint` — 0 errors (grandfathered warnings only).

## Round 2 addendum — 2 fresh threads on the round-1 push

While round 2 was in flight, Codex reviewed the round-1 commit and posted two
more threads (06:06 UTC), both on `sec-ingest-worker.ts` and sharing one root
cause: for multi-document accessions the worker used the bare accession as
`doc_id`, so (P1 `PRRT_kwDOS7mOVM6Rqjrv`) `storeDocument`'s managed-ledger
documentKey defaulted to the accession and document B's commit would supersede
document A's vectors (one active head per document_key), and (P2
`PRRT_kwDOS7mOVM6Rqjrz`) every document's chunks collided on
`<accession>#c001` citation ids. Fixed in one change: the worker now builds
`vectorDocId = `${accession}:${sequence}:${documentName}`` and uses it as
`doc_id` in both document builds — distinct ledger head AND distinct chunk ids
per source document. Worker test asserts the id shape.

## Follow-ups / risks (round 2)

- No production enqueuer sets `payload.acceptanceDateTime` yet (the worker is
  not instantiated in production); the pass-through is wired for when discovery
  starts queueing tasks — set it at enqueue time.
- The 8-K ingest path (`sec8k.ts`) does not FTS-mirror yet; the flagged filing
  body path (`ingestFiling`) does. Extend if 8-K lexical coverage is wanted.
- Switching production to a BGE embedding model remains a deliberate
  backfill/switchover exercise — the isolation shipped here makes the switch
  SAFE (no cross-space ranking, no overwrites) but intentionally does not
  migrate or re-embed the existing Voyage corpus.
