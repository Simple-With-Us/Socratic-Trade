# 2026-07-04 - RAG quick-wins Wave 1 lane: wire dormant stages + provenance + hash/embed-tag/rerank-cap

## Summary

One of four Wave-1 quick-win lanes from the 2026-07-04 composite expert review (section C, "RAG,
data ingestion & memory embedding", lines 233-310 of the source doc). S-effort wiring of RAG stages
that were already built and tested but never actually invoked — no new ingestion sources, no
schema changes.

1. **Wired the dormant relevance-floor + near-duplicate dedupe.** `retrieveContextDetailed`'s
   `RetrieveOptions.minRelevanceScore` (post-rerank floor) and `dedupeSimilarity` (Jaccard-shingle
   near-dup suppression) have existed since the 2026-07-01 RAG backlog, but neither call site ever
   passed them — `strategy.ts` passed only `{docType, minScore, connectedAccountId}` and
   `chat/orchestrator.ts` passed only `{asOf, docType, minScore}`. Added two new tunables in
   `src/lib/vector-db.ts`:
   - `defaultRelevanceFloor()` — env `VECTOR_MIN_RELEVANCE_SCORE`, default `0.3` (the low end of the
     review's suggested 0.3-0.5 band, kept conservative pending golden-set tuning).
   - `defaultDedupeSimilarity()` — env `VECTOR_DEDUPE_SIMILARITY`, default `0.6`. Returns
     `undefined` (not `0`) when the env resolves to `<= 0`: unlike `defaultMinScore`'s
     `VECTOR_MIN_SCORE=0` convention, a literal `0` Jaccard threshold in `dedupeSimilar` is NOT a
     safe "disable" value — `jaccardSimilarity(...) >= 0` is always true, so threshold `0` would
     flag every subsequent non-empty chunk as a duplicate of the first kept one (the opposite of
     disabling). Both are now passed at both real call sites (`strategy.ts`'s advisory RAG context,
     `chat/orchestrator.ts`'s `searchKnowledge` tool).
2. **Provenance headers + stable chunk ids.** New `formatChunkWithProvenance(chunk, symbol?)` in
   `vector-db.ts` prefixes each retrieved chunk's text with a compact header —
   `[10-K · risk-factors · AAPL · 2026-02-01 · rel 0.82]` — built from data `RetrievedChunk` already
   carries (`doc_type`, `section`, `as_of` truncated to date-only, `relevanceScore` falling back to
   the cosine `score`). `strategy.ts` now joins provenance-prefixed chunks into `ragContext` instead
   of raw `c.text`, so the model can weight a fresh 8-K over a stale 10-K and reference which chunk
   it drew from. Missing fields are omitted gracefully (no "undefined" placeholders); a chunk with
   truly nothing to show returns bare text unprefixed. Chunk ids were already stable/real
   (`RetrievedChunk.id` is the real Pinecone vector id, already flowing into
   `SocraticRagAttribution.chunkId` via `ragAttributionsFromChunks`) — left completely unchanged,
   ready for a future `evidenceRefs` citation mechanism to key off. `chat/orchestrator.ts`'s
   `searchKnowledge` tool result was deliberately NOT given a text header: it already returns
   `doc_type`/`section`/`as_of`/`score` as discrete JSON fields to the LLM, so a redundant text
   prefix would add no signal and risks confusion with `chunk_id`.
3. **Content-hash dedup default-on + widen to 128-bit.** Confirmed `VECTOR_STORECONTEXTS_DEDUP` was
   ALREADY default-on everywhere it's checked (`vector-db.ts`, `disclosure-rag.ts`, `sec8k.ts`) —
   traced via `git log -S` to an earlier commit (`3392b13`/`e2ea389`) that predates this branch, so
   the source review's "gated behind ... (default OFF)" description was stale by the time this lane
   started; no code change needed for that half. Widened `hashContent()` (`src/lib/rag/chunk.ts`)
   from the first 16 hex chars of SHA-256 (64-bit) to the first 32 (128-bit) to remove the
   collision-risk half of the item — `document_chunks.content_hash` is a plain `TEXT` primary key
   (`db.ts`), so no schema/migration change was needed; a pre-existing 16-char hash simply won't
   match a newly-computed 32-char hash for the same text, so that one row re-embeds once (harmless,
   `INSERT OR IGNORE` semantics already tolerate it).
4. **Embedding-model version tag on vectors.** `cleanMetadata()` (`vector-db.ts`) now stamps every
   new vector with `embed_model: "voyage-finance-2"` (the existing `VOYAGE_MODEL` constant) plus a
   new `embed_rev: 1` (`EMBED_REV` constant, bump on any future embedding-space-breaking change —
   e.g. a model swap or flipping `VECTOR_EMBED_CLEAN_TEXT`). A caller-supplied `embed_model`/
   `embed_rev` metadata key is explicitly stripped/ignored so it can't spoof the stamped values.
   Legacy vectors written before this change simply lack the field — treat missing as rev 0. Did
   NOT add a per-model-count surface to a `rag-coverage` route: no such route exists in this repo
   yet (only `/api/admin/rag-coverage` for corpus coverage by doc_type/symbol, unrelated to
   embed-model versioning) — that's part of the separate, larger "persist chunk text/date/model/
   vector-id" item (medium/M effort) and is out of scope for this S-effort lane; noted as a
   follow-up below.
5. **Raised the rerank candidate-pool cap.** `overFetchK` used to hard-cap EVERY over-fetch path
   (rerank, hybrid, as-of) at 50 candidates, even though Voyage's `rerank-2.5` cross-encoder is
   cheap to run over hundreds-to-1000 candidates — a flip-the-decision chunk buried at dense rank
   51+ for a mega-cap symbol with a full 10-K plus many 8-Ks never reached the reranker. New
   `rerankOverFetchK(limit)` (env-tunable via `VECTOR_RERANK_OVERFETCH_K`, default `150`) widens
   ONLY the pool actually handed to reranking when rerank will run; the non-rerank over-fetch paths
   (as-of-only, hybrid-without-rerank) keep the original modest `overFetchK` (<=50) cap unchanged —
   this does not change their Pinecone `topK`.

## Why

Per the 2026-07-04 composite expert review (section C): the RAG retrieval pipeline had built and
tested a relevance floor, near-dup suppression, provenance-aware prompting groundwork, and a
128-bit-capable hash function, but every one of these sat dormant because no call site ever
exercised the opt-in path, or (for the hash) the truncation was never widened. Each item here is a
narrow, low-risk "turn on what's already built" change, deliberately scoped to avoid new ingestion
sources or schema changes (those are separate, larger Next-phase items per the review's
impact/effort table). Owner philosophy: nothing here adds a hard gate — every new default (relevance
floor, dedupe threshold, rerank pool cap) is env-tunable and fails open/safe on omission, consistent
with the "advisory guardrails, easy override" pattern already established elsewhere in this repo.

## Files

- `src/lib/vector-db.ts` — `EMBED_REV` constant + `cleanMetadata()` embed_model/embed_rev stamping;
  `rerankOverFetchK()` + `fetchK` computation; `defaultRelevanceFloor()`/`defaultDedupeSimilarity()`;
  `formatChunkWithProvenance()`.
- `src/lib/rag/chunk.ts` — `hashContent()` widened to 32 hex chars (128-bit).
- `src/lib/strategy.ts` — RAG retrieval block wires `minRelevanceScore`/`dedupeSimilarity`, joins
  provenance-prefixed chunk text into `ragContext`.
- `src/lib/chat/orchestrator.ts` — `searchKnowledge` wires `minRelevanceScore`/`dedupeSimilarity`.
- `test/rag-chunk.test.ts` — updated hash-length assertions (16 → 32).
- `test/vector-db.test.ts` — updated `topK` assertion for the new rerank-path over-fetch default;
  added an `embed_model`/`embed_rev` stamping + anti-spoof test.
- `test/vector-db-provenance.test.ts` — new `formatChunkWithProvenance` test suite.
- `test/vector-db-rerank-overfetch.test.ts` — new: env-tunable rerank-path cap, non-rerank paths
  unaffected, never-below-limit floor.
- `test/chat-orchestrator-search-knowledge.test.ts` — new test asserting
  `minRelevanceScore`/`dedupeSimilarity` are forwarded to `retrieveContextDetailed`.
- `test/strategy-rag-quickwins-wiring.test.ts` — new: end-to-end `runStrategyOnce()` integration
  test asserting the wiring + provenance header land in the actual LLM prompt payload.
- `test/persistence-notification.test.ts`, `test/strategy-money-path-f-g.test.ts`,
  `test/strategy-rationale-collapse-gate.test.ts`, `test/redteam-observability-g10.test.ts`,
  `test/strategy-moneypath-drawdown-flip.test.ts`, `test/strategy-bear-fail-closed.test.ts`,
  `test/strategy-llm-failover.test.ts`, `test/strategy-bull-truncation.test.ts` — updated
  `vi.mock("../src/lib/vector-db")` blocks to add the three new exports
  (`defaultRelevanceFloor`/`defaultDedupeSimilarity`/`formatChunkWithProvenance`) so the
  destructuring import in `strategy.ts`'s RAG block doesn't throw against these full-module mocks.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — status/effort-board
  updates for this lane.

## Verification

- `npm run lint` — 0 errors (pre-existing grandfathered warning backlog only, count unchanged at
  308 after fixing one warning this branch introduced and removed).
- `npx tsc --noEmit` — clean, run both before and after `npm run build` regenerated `.next/types`.
- `npm test` — **2388/2388 tests passing across 247 files** (up from the pre-existing 2375/245
  baseline; +13 new tests, 0 regressions). `data/app.db` was removed before each run per the
  handoff note (no `no such column` artifact issues hit).
- `npm run build` — green, clean Next.js production build, no compile errors.

## Follow-ups

- The review's "How" spec for item 1 also calls for "a golden re-run to tune thresholds" — the
  0.3/0.6 defaults chosen here are the review's suggested starting values, not yet validated
  against `test/rag-retrieval-eval.test.ts`'s golden fixture. A follow-up should re-run that harness
  with the new floor/dedupe wired on and adjust `VECTOR_MIN_RELEVANCE_SCORE`/
  `VECTOR_DEDUPE_SIMILARITY` if recall@k/MRR regresses.
- Item 2's full spec also called for a `usedEvidence: [{ref, effect, why}]` field in the proposal
  schema and merging it onto attributions before persisting (the ground-truth label for a future
  usefulness scoreboard) — out of scope for this S-effort lane per the task's explicit narrowing;
  left for a dedicated follow-up.
- Item 4's "surface per-model counts in the rag-coverage route" half is deferred — no such route
  exists yet; it's part of the separate, larger "persist chunk text/date/model/vector-id" item.
- Confirm on a later pass whether `strategy.ts` should also union `workingPositions` symbols into
  the RAG retrieval scope (a separate medium-impact review item, not in this lane's five items).
- `src/lib/strategy.ts` is shared/high-traffic across the Wave-1 lanes; this lane's edits were
  confined to the RAG retrieval block (~lines 499-533) per the coordinator's scoping — no overlap
  observed with `claude/w1-llm-fixes`/`claude/w1-learning-loops`/`claude/w1-regime-data`'s described
  scopes at the time this branch was cut, but the landing train should still diff carefully since
  all four lanes touch `strategy.ts`.
