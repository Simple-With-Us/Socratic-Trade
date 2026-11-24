# 2026-11-23 — Wave 2A RAG Dossier Hydration, Lexical FTS5 Expansion, Chunker & Rerank Fixes (ST-4664)

## 1. Context & Objective

Resolve eleven RAG, proposer-dossier, lexical-recall, chunking, SEC backfill, and point-in-time transcript dating defects identified in the Wave 2A (`ST-4664`) audit inside `<install-path>`.  Prior to this change, `hydrateCache` in `assembleProposerDossier` keyed solely on bare accession (causing Item 1A to overwrite Item 7 MD&A from the same 10-K), scout dossiers hardcoded `.slice(0, 1)` (ignoring `scoutFilingsChunkLimit()`), `document_abstracts` queries ignored `asOf` point-in-time bounds, FTS5 corpus-wide lexical search excluded transcripts and document summaries, `chunkDocument` shattered prose on abbreviations (`Inc.`, `U.S.`, decimals), emitted standalone overlap mini-chunks, and left oversized tables unsplit, `SecIngestWorker` embedded raw Form 4 XML and omitted `sections`/`sourceChunks` when generating backfill abstracts, `vector-db.ts` omitted structured context headers from `embeddingText` and truncated `rerankMatches` at `limit` before post-rerank floor/dedupe stages, `dedupe-similar.ts` ran a dead pass-2 loop, `rerank-policy.ts` misclassified default scout limits (`3`) as `"general"`, and transcript ingesters stamped `acceptance_datetime` with the wall-clock fetch timestamp instead of the earnings call `eventDate`.

## 2. Changes Made

- **Proposer Dossier Hydration Key, Scout Limit & Point-in-Time Filtering (`src/lib/rag/proposer-dossier.ts`)**:
  - Keyed `hydrateCache` by `${accession}::${hashFromChunk(chunk) ?? itemCodeFromChunk(chunk) ?? chunk.id}` while keeping `seenAccessions` tracking distinct accessions against `HYDRATE_ACCESSION_CAP` (`8`), ensuring multiple sections/chunks from the same filing hydrate their own local text without colliding.
  - Updated `depth === "scout"` chunk assembly to fill up to `limit` (`[...abstractChunks.slice(0, 1), ...suppressed.slice(0, remainingSlots)]`) so `scoutFilingsChunkLimit()` (`3` by default) is honored.
  - Added `abstractWithinAsOf` filtering on `getDocumentAbstractsForTicker(symbol, 40)` when `asOf` or `retrieveOptions?.asOf` is supplied, and forwarded `asOf` to `retrieve` and `hydrateAccession`.
- **Corpus-Wide Lexical FTS5 Source Expansion (`src/lib/rag/corpus-wide-lexical.ts`)**:
  - Expanded the `o.source IN (...)` filter in `planCorpusWideLexicalQuery` from `('sec-edgar', 'sec-8k')` to `('sec-edgar', 'sec-8k', 'roic-transcript', 'earningscalls-transcript', 'document-summarizer')`.
  - Updated `docTypeFilterSql` and `mapLexicalRows` to project `'earnings-transcript'` for transcript sources and `'earnings-summary'` / `'8k-brief'` / `'document-summary'` for `'document-summarizer'` rows.
- **Structure-Aware Chunker Abbreviation Protection, Overlap Fix & Row-Group Table Splitting (`src/lib/rag/chunk.ts`)**:
  - Added `splitSentencesPreservingAbbreviations(text)` to protect corporate, geographic, honorific, initial, and decimal periods (`Inc.`, `Corp.`, `Ltd.`, `U.S.`, `Mr.`, `Dr.`, `3.14`) before splitting sentences.
  - Removed standalone `yield tail` overlap mini-chunk emission in `splitLongProse` when `tail + clean` exceeds `maxTokens`.
  - Added `splitTableByRowGroups(tableText, maxTokens)` to split oversized markdown tables into token-bounded row groups that repeat the table header (and separator) row.
- **SEC Ingest Worker Form 4 XML Skip & Backfill Abstract Hydration Links (`src/lib/rag/sec-ingest-worker.ts`)**:
  - Stopped synthesizing `{ itemCode: "0", itemTitle: "XML Document", text: content }` for `.xml` Form 4 tasks and skipped vector embedding/FTS mirroring for `.xml` ownership files while preserving `parseAndSaveForm4(content, task.cik, task.accession, task.symbol)` at the `parsed` checkpoint.
  - Passed `sections: doc.sections` and `sourceChunks` (from `chunks.json` or `chunkDocument`) into `tradeHighlightChunksFromText` at `embed_queued` so backfilled filing abstracts preserve section priors and `content_hash` hydration links.
- **Managed `embeddingText` Context Header, Rerank Top-N Window, Dedupe Pass-2 Cleanup, Scout Rerank Intent & Transcript PiT Timestamps (`src/lib/vector-db.ts`, `src/lib/rag/dedupe-similar.ts`, `src/lib/rag/rerank-policy.ts`, `src/lib/web-sources/roic-transcripts.ts`, `src/lib/earningscalls-transcripts.ts`, `src/lib/chat/orchestrator.ts`)**:
  - Prepended structured `[TICKER | FORM PERIOD | SECTION]` context headers into `embeddingText` in `storeDocument` (`src/lib/vector-db.ts`).
  - Passed `rerankTopN = Math.min(rerankPool.length, Math.max(limit * 3, 24))` to `options.rerank!` in `rankPool` (`src/lib/vector-db.ts`) so post-rerank relevance floor and near-duplicate suppression have back-fill headroom.
  - Removed the dead `deferred` second pass in `dedupeSimilar` (`src/lib/rag/dedupe-similar.ts`).
  - Updated `classifyRerankIntent` in `src/lib/rag/rerank-policy.ts` to classify `limit <= SCOUT_RERANK_CHUNK_LIMIT_MAX` (`4`) as `"scout"`.
  - Updated `ingestRoicTranscriptToRag` (`src/lib/web-sources/roic-transcripts.ts`) and `ingestCachedTranscript` (`src/lib/earningscalls-transcripts.ts`) to stamp `acceptance_datetime` from the call's `eventDate` (`published` / `publishedAt`) rather than the fetch wall-clock timestamp.
  - Ensured `searchKnowledge` in `src/lib/chat/orchestrator.ts` defaults `asOf` to the current ISO timestamp via `resolveRetrievalAsOf(args.as_of) || new Date().toISOString()`.

### Exact Touched Files

- `src/lib/rag/proposer-dossier.ts`
- `src/lib/rag/corpus-wide-lexical.ts`
- `src/lib/rag/chunk.ts`
- `src/lib/rag/sec-ingest-worker.ts`
- `src/lib/vector-db.ts`
- `src/lib/rag/dedupe-similar.ts`
- `src/lib/rag/rerank-policy.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/earningscalls-transcripts.ts`
- `src/lib/chat/orchestrator.ts`
- `test/proposer-dossier.test.ts`
- `test/corpus-wide-lexical.test.ts`
- `test/rag-chunk.test.ts`
- `test/sec-ingest-worker.test.ts`
- `test/rag-rerank-policy.test.ts`
- `test/rag-retrieval-regression.test.ts`
- `test/vector-db-chunk-cap.test.ts`
- `test/roic-transcripts.test.ts`
- `test/earningscalls-transcripts.test.ts`
- `STATUS.md`
- `docs/rollouts/2026-11-23-wave2-rag-dossier.md`

## 3. Decisions & Trade-offs

- **Content-hash preservation with structured `embeddingText`**: `chunk.content_hash` continues to hash the raw chunk text so FTS5 occurrence joins and `hydrateAccession` content-hash lookups remain invariant, while `embeddingText` receives `[TICKER | FORM PERIOD | SECTION]\n${chunk.text}` so dense vectors capture issuer, form/period, and section provenance.
- **Form 4 XML checkpoint progression**: Rather than altering the 11-checkpoint state machine contract in `db-rag-ingest.ts`, `.xml` tasks write empty `sections.json` and `chunks.json` artifacts after `parseAndSaveForm4` extracts structured rows into `sec_insider_transactions`, and record a zero-chunk `storeResult.json` at `embed_queued` so job reconciliation completes cleanly with zero wasted embed tokens.
- **Rerank top-N cap**: `rerankTopN` is bounded by `Math.min(rerankPool.length, Math.max(limit * 3, 24))` so small test pools never request more candidates than exist in `rerankPool`, while production pools keep at least `3x` (or `24`) reranked candidates ahead of `minRelevanceScore` and `dedupeSimilar`.

## 4. Verification State

- `npm run lint` — passed (`0` errors)
- `npx tsc --noEmit` — passed (`0` type errors)
- `npx vitest run test/proposer-dossier.test.ts test/corpus-wide-lexical.test.ts test/rag-chunk.test.ts test/sec-ingest-worker.test.ts test/rag-dedupe-similar.test.ts test/rag-rerank-policy.test.ts test/chat-orchestrator-search-knowledge.test.ts test/rag-retrieval-regression.test.ts test/persist-candidate-pool-v2.test.ts test/vector-db-chunk-cap.test.ts test/roic-transcripts.test.ts test/earningscalls-transcripts.test.ts` — passed (`12/12` files)
- `npm run build` — passed (Next.js production webpack build + `stamp-csp-static-hashes.mjs`)

## 5. Next Steps & Blockers

- Open PR from `ag/kk-wave2-rag-dossier` for `ST-4664` and merge after CI `verify` and review pass.
