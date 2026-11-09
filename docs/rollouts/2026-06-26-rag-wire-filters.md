# 2026-06-26 — Wire RAG metadata filters + minScore floor (improvement program items #1/#6)

Branch `agent/claude-rag-wire-filters`. Second PR of the improvement program (see
`docs/improvement-program-2026-06-26.md`).

## Summary
`buildExtraFilters` (doc_type/section/source → Pinecone filter) and the `minScore` cosine floor were fully
implemented in `vector-db.ts` but **every production caller passed `undefined`**, so they were dead code. This
PR wires them in:
- Added `defaultMinScore()` to `vector-db.ts` — env `VECTOR_MIN_SCORE` (default 0.30, clamped [0,1]; `0`
  disables the floor).
- `strategy.ts` per-symbol RAG fetch now passes `{ docType: ["10-k","10-q","8-k","earnings-transcript"],
  minScore: defaultMinScore() }`.
- `chat/orchestrator.ts` `searchKnowledge` now forwards the intent classifier's `doc_type` (previously
  extracted then dropped) + `minScore`, alongside the existing `asOf`.
- `.env.example`: documented `VECTOR_MIN_SCORE=0.30`.

## Why
RAG retrieval quality + relevance. The strategy loop was retrieving with no relevance floor and no doc-type
scoping; the chat path classified a `doc_type` intent but never used it. Advisory path only — RAG fills the
`ragContext` string injected into the LLM prompt; it never directly gates sizing or execution. No flag needed
(worst case: fewer, more-relevant chunks; `VECTOR_MIN_SCORE=0` restores prior behavior).

## Deviation from the planned spec (important)
The spec hardcoded a **lowercase** docType filter list. But stored `doc_type` casing is **inconsistent**:
`web-sources/sec-filings.ts` writes `"10-K"/"10-Q"` (uppercase), `web-sources/sec8k.ts` writes `"8-k"`
(lowercase), and `rag/chunk.ts` stores `doc.doc_type` verbatim (no normalization). Pinecone `$in` is
exact-match, so a lowercase filter would have **silently excluded every uppercase-stored 10-K/10-Q chunk** —
worse than the no-filter status quo. Fix: made `buildExtraFilters` **casing-tolerant** — each requested type
expands to original + lower + upper (deduped) in the `$in`. Robust to the existing mixed-casing data without a
re-ingestion. (Follow-up worth considering: normalize `doc_type` to one canonical casing at ingestion so the
data converges — not required now.)

## Files
- `src/lib/vector-db.ts` — `defaultMinScore()`; casing-tolerant `buildExtraFilters`.
- `src/lib/strategy.ts` — thread docType + minScore into `retrieveContextDetailed`.
- `src/lib/chat/orchestrator.ts` — forward doc_type + minScore; import `defaultMinScore` + `RetrieveOptions`.
- `.env.example` — `VECTOR_MIN_SCORE=0.30`.
- `test/vector-db-retrieval.test.ts` — casing-tolerance test (replaces the old single-casing assertion) +
  `defaultMinScore` env/clamp test.
- `docs/improvement-program-2026-06-26.md` — marked items #1/#6 DONE; appended the 4 recovered opus specs.
- `STATUS.md` — new entry.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/vector-db-retrieval.test.ts test/chat-orchestrator.test.ts` — 21 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups
- Program continues: langfuse-evals next (Batch 1), then rag-hybrid-bm25 + rag-embed-congress-insider (Batch
  3; both share/extend the same `vector-db.ts` retrieval region, so they land after this).
- Optional: normalize `doc_type` casing at ingestion to converge stored values (low priority given the
  casing-tolerant filter).
