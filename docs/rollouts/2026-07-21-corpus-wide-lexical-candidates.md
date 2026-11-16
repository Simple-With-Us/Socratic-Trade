# 2026-07-21 — Corpus-wide lexical candidates

## Summary

Added a focused, read-only `src/lib/rag/corpus-wide-lexical.ts` foundation for the existing
SQLite FTS5 filing-text corpus. It returns deterministic lexical candidates with the occurrence
vector ID, accession, source, section, form, accepted timestamp, raw BM25 score, and explicit
`retrievalSources: ["lexical"]` provenance.

## Why

The current hybrid path applies BM25 only to dense candidates. It cannot recover an exact filing
term, accession, item label, or issuer-specific term that never entered Pinecone's dense top-k.
The repository already persists filing text to `document_chunks_fts`; this slice exposes that
corpus safely without changing retrieval behavior yet.

## Contract and decisions

- The adapter tokenizes, case-insensitively de-duplicates, and quotes every untrusted query term
  before emitting an FTS5 OR expression. Operators and punctuation cannot change the FTS grammar;
  empty, oversized, invalid-symbol, and invalid-as-of inputs return no candidates. OR preserves
  recall when a natural-language question matches only a filing's discriminative terms.
- The join uses all FTS occurrence coordinates (`content_hash`, `symbol`, `source`, `accession`) to
  retain identical boilerplate in different filings as separate candidates.
- `chunk_occurrences.accepted_at` is the point-in-time authority. With `asOf`, strict undated
  handling is on by default; callers can select the explicit lenient compatibility mode with
  `strictUndated: false`, whose returned rows remain labeled `availability: "undated"`.
- Lexical BM25 is not cosine similarity, so candidates retain `score: 0` and expose `lexicalScore`.
  A later fusion layer must use RRF or another calibrated method rather than a dense score floor.
- No schema, `vector-db.ts`, strategy, provider, corpus-write, re-embed, or purge behavior changed.

## Files

- `src/lib/rag/corpus-wide-lexical.ts`
- `test/corpus-wide-lexical.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/rollouts/2026-07-21-corpus-wide-lexical-candidates.md`

## Verification

- `./node_modules/.bin/vitest run --reporter=verbose test/corpus-wide-lexical.test.ts`
- `./node_modules/.bin/eslint src/lib/rag/corpus-wide-lexical.ts test/corpus-wide-lexical.test.ts`
- `nice -n 19 ./node_modules/.bin/tsc --noEmit`
- `git diff --check`

## Follow-ups and risks

- Land only after current SEC ingestion and BGE re-embed lanes reconcile; this work performs no
  corpus operation itself.
- A later retrieval integration should run lexical and dense recall in parallel, RRF-fuse the
  independent lists, then rerank once. It must keep lexical candidates out of raw cosine floors.
- FTS rows currently contain filing occurrence text, not every RAG source family. Expand scope only
  with source-specific availability and provenance rules.
