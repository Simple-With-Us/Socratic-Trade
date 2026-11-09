# RAG / Knowledge / Retrieval — Expansion & Design Review

**Status:** design / expansion (2026-07-01)
**Subsystem:** RAG / Knowledge / Retrieval (voyage-finance-2 → Pinecone; cosine floor; as-of point-in-time guard; optional hybrid BM25/RRF; optional cross-encoder rerank; salience extraction; corpus ingest)
**Companion to:** `docs/reviews/2026-07-01-audit-work-split.md` §"Chat C — RAG / Embedding / Knowledge Framework" and `docs/reviews/2026-06-30-improvement-audit.md` §6.3.

## Summary

An expert panel (IR/eval methodology, embeddings/vector-DB engineering, financial-corpus domain, LLM-integration systems) proposed refinements to the seven **audit** items already assigned to Workstream C, plus a set of **net-new** improvements adjacent to that scope. A skeptic pass then dropped duplicates and unsafe sub-parts, and a completeness pass added integrity/dedup gaps nobody else caught. This doc consolidates the survivors into:

- **(A)** must-fix **corrections** to relay to the in-flight Workstream C implementer for the seven audit items (pitfalls that will otherwise ship as silent bugs), and
- **(B)** a prioritized (P0/P1/P2) backlog of **new** improvements — each with effort, a default-off flag, and a code-grounded spec.

**Meta-theme (consistent with the parent audit):** the RAG path repeatedly computes a signal and then discards or fails to gate on it — the reranker throws away `item.relevanceScore`, `defaultMinScore()` is a helper never auto-applied, the as-of guard fails **open** on undated chunks, and `storeContexts` re-truncates already-budgeted chunks. Closing these is higher-leverage and lower-risk than new machinery. Every behavior change here is **default-off**; the Phase-0 byte-identical invariant holds when flags are unset.

## Relationship to the audit workstream

Workstream C (audit items C1–C7) is authoritative and in progress. This doc does **not** re-scope it. Section 1 below is a correction layer *on top of* C1–C7 (the implementer should read it before writing code). Section 2 is a separate backlog of new items that sit around C1–C7 and are safe to sequence after the eval harness (C1) lands. Nothing here touches the order/execution path; per the audit's inline note, `strategy.ts` RAG context is *advisory only — not a money-path gate*, so retrieval-integrity items are framed as backtest/research-honesty hygiene, not live-trading safety.

---

## 1. Item-refinement corrections (must-fix pitfalls for the C1–C7 implementer)

These are the pitfalls the panel verified against current code that would otherwise ship as silent defects. Ordered by the audit item they attach to.

### C1 — retrieval-quality eval harness
- **Score the real pipeline, not `matchToChunk` in isolation.** `retrieveContextDetailed` returns `[]` when `getClients()` has no keys (`vector-db.ts:~621`) and would embed the query live. Recall@k/MRR are properties of the *ordered* candidate list, so the harness must run a recorded fixture through the real post-recall stages — score floor (`:706-707`), `isWithinAsOf` (`:709-711`), optional `fuseHybrid` (`:715-717`), rerank (`:718-720`), slice — ideally via a small pure `rankPool(...)` helper refactored out of `:704-724`. Assert **no network**: spy on `getClients`/embed and fail if invoked.
- **Key golden expected-ids on `content_hash`, never the chunk UUID.** `chunk.ts` derives `content_hash` = SHA-256 first-16-hex (stable) but `chunk_id` from `randomUUID` — UUID-keyed goldens break on every fixture regeneration.
- **Pin `acceptance_datetime` on every fixture chunk.** The as-of guard drops undated chunks under an active `asOf`; an unpinned fixture flakes. Include at least one explicit-`asOf` case to prove the guard is exercised.
- **Respect the `overFetchK` ≤50 ceiling.** A golden chunk at dense rank 51+ is unreachable; a <1.0 recall baseline may be structural, not a bug. Set a *regression floor* (`>=`), not an equality to today's number.
- **Golden-set hygiene is load-bearing (see P1 item R4).** Author queries the way `strategy.ts`/`orchestrator.ts` phrase them, not as chunk-text paraphrases (leakage → trivially ~1.0 recall). Include hard negatives (same-ticker-different-filing, cross-ticker confusables) and report per-doc_type recall (8-k summaries retrieve very differently from 10-k long-form). With n=25–40, report per-query results; treat the aggregate as a smoke floor.

### C2 — capture rerank relevance scores + post-rerank floor
- **`rerankMatches` (`vector-db.ts:292-320`) currently discards `item.relevanceScore`** (it reads only `item.index`). Attach the score onto a **shallow-cloned** match (e.g. a sidecar `__relevanceScore`), never by mutating the shared `match.metadata` object (it's upsert-shaped and may be reused). Attribute by `item.index` against the **pre-rerank** `matches` array, preserving reranked order.
- **Do NOT reuse the cosine `0.30` default for the relevance floor.** Voyage rerank-2.5 relevance is a model-specific scale, not a 0–1 cosine. Name it distinctly (`RetrieveOptions.minRelevanceScore` / `VECTOR_MIN_RELEVANCE_SCORE`) and document the two floors as independent axes.
- **Fail-OPEN on the rerank-fallback path.** `rerankMatches` returns cosine order (no scores) on error/empty/`429` (`:316-318`) and rerank only runs when `fusedPool.length > limit` (`:718`). When rerank didn't run, `relevanceScore` is `undefined`; treat `undefined` as **pass**, never as `0`, or a transient Voyage `429` empties every result.
- **Apply the floor AFTER rerank and BEFORE `.slice(0, limit)`.** Document that the floor can return fewer than `limit`; `strategy.ts` (advisory) and `orchestrator.ts` (citations) already tolerate short lists.

### C3 — paid-Voyage corpus enablement (docs/config)
- **Rank levers by trading value, and correct the "starved" framing:** the 6-line **8-K summary** ingest (`sec8k.ts`, `doc_type:'8-k'`) *always* runs — the corpus is thin in *depth*, not empty. Highest-value gated lever is 10-K/10-Q full-body (gated indirectly by `isFreeTier()` reading `VECTOR_EMBED_BATCH_DELAY_MS<=5000`), then 8-K full-body (`WEB_SOURCE_SEC8K_FULL_BODY`, cap 5), then disclosures (`RAG_EMBED_DISCLOSURES`).
- **Document the `isFreeTier()` coupling trap:** setting `VECTOR_EMBED_BATCH_DELAY_MS=0` to speed ingest *also* flips the free-tier gate ON and enables 10-K/10-Q full-body. Say so explicitly.
- **Document the flag-parsing trap:** `disclosureRagEnabled()` requires exact string `'on'` (`disclosure-rag.ts:18-21`), NOT the `1/true/on/yes` set the other RAG flags accept — `RAG_EMBED_DISCLOSURES=true` silently no-ops. (P1 item R6 fixes this in code.)

### C4 — hybrid BM25/RRF evaluation
- **Report per-doc_type / per-intent deltas, not a blended average.** BM25 helps exact-token queries (tickers, GAAP line items, accession/CIK strings) and barely moves paraphrastic ones; an aggregate can read ~0 and wrongly damn hybrid. Include exact-token queries in the golden set or the eval shows no lift by construction.
- **IDF is pool-relative** (`hybrid.ts:13-18` — computed over the ≤50-doc `overFetchK` pool). On the default thin corpus this is the noisy small-corpus regime; treat any lift as indicative, and evaluate hybrid on the **raw** pool (before rerank) to isolate its contribution. Keep default off unless the delta is non-noise.

### C5 — align char cap with the token chunker
- **Scope the fix to already-chunked input; do NOT globally raise `VECTOR_CONTEXT_MAX_CHARS`.** `storeContexts` serves both `storeDocument`→`chunkDocument` output (token-budgeted, tables atomic) and ad-hoc callers (8-K summaries, disclosures) that legitimately want the char ceiling. Thread a `preChunked`/`skipTrim` signal from `storeDocument`.
- **The `[Published: …]` prefix is prepended BEFORE `trimContextText`** (`vector-db.ts:362-368`), so the effective body budget is smaller than 2400 — any round-trip test must include the prefix path.
- **Atomic tables (`is_table:true`, never split by `chunk.ts`) can exceed any reasonable char cap.** Decide explicitly: exempt `is_table` from trimming *or* keep an absolute Voyage-input safety ceiling above a normal 480-token chunk. Truncating a table mid-row corrupts numeric data.
- **Keep `content_hash` and stored text consistent.** `content_hash` is computed on pre-trim chunk text; if the stored text is post-trim, dedup and stored content diverge. The chunked-path exemption keeps them aligned.

### C6 — doc_type casing normalization (low)
- **Verify against real Pinecone data first — current write sites already lowercase** (`sec-filings.ts:254 .toLowerCase()`, `sec8k.ts`, `disclosure-rag.ts:53/73`). This is hardening (a single normalization choke point in `storeContexts`) plus preserving `buildExtraFilters`' upper/lower `$in` expansion as a **legacy shim** for pre-normalization vectors. Do NOT simplify to exact-match — legacy vectors would become unreachable.
- **Do NOT touch the `ingested_accessions` dedup key.** It stores mixed-case `FilingRef.docType` ('10-K') as a *separate* concern (`sec-filings.ts:231/269`); changing its casing flips every accession to "not ingested" and triggers a full re-ingest storm.

### C7 — salience extractor + ticker validation
- **Keep `salience.ts` pure.** It's documented pure/offline-testable (`:1-4`). Do LLM extraction + validation in a new module (e.g. `salience-llm.ts`); **inject** the validator as a predicate so the pure file never imports the DB.
- **The universe validator exists:** `isValidAppSymbol` (`index-universes.ts:289`) or `getImportedRef(ticker)` (`db-securities-import.ts:210`). But **fail-open when the universe is empty** (`imported_securities_ref` is a congress.trade EOD cache, empty in Test/paper mode via `getImportedCacheCounts().refs`), else you strip every ticker. A stopword denylist (`I,A,CEO,CFO,ESG,USA,EPS,ETF,IPO,AI`) is a cheap first-pass complement.
- **First-match-only bug:** `salience.ts:95` uses `text.match(TICKER_RE)` (first token only) — validating just that one token still mis-binds when the first CAPS token is `I`/`CEO`. Use `matchAll`, then pick the first *validated* ticker (P1 item R8 formalizes this).
- **LLM output is untrusted:** route LLM-extracted tickers through the same validator; keep `PII_PATTERNS` skip ahead of any LLM call; fall back to regex on failure/timeout/malformed-JSON; keep the downstream `classify.ts` fail-closed gate.

---

## 2. New-improvement backlog (survived skeptic + completeness)

All items are **default-off** unless marked test-only. Priorities: **P0** = correctness/integrity landmine or protects the entire eval investment; **P1** = high-leverage, low-risk; **P2** = useful but speculative or dependent.

| ID | Title | Priority | Effort | Flag |
|----|-------|----------|--------|------|
| R1 | Fail-closed as-of guard for undated chunks + `published_at` fallback | P0 | S | `VECTOR_ASOF_STRICT` |
| R2 | Embedding integrity guard (dim/finiteness) before upsert | P0 | S | always-on guard (drop+audit) |
| R3 | Golden-set anti-leakage + hard-negative lint (protects C1/C2/C4) | P0 | S | n/a (test-only) |
| R4 | Retrieval regression net for as-of / rerank / hybrid fail-safes | P0 | S | n/a (test-only) |
| R5 | Consolidated per-retrieval telemetry record (subsumes 3 overlapping proposals) | P1 | S | `RAG_RETRIEVAL_TELEMETRY` |
| R6 | Shared fail-closed env-flag parser (fixes `RAG_EMBED_DISCLOSURES`) | P1 | S | n/a (parser consistency) |
| R7 | Index-metric assertion (cosine invariant) at bootstrap | P1 | S | `VECTOR_ASSERT_INDEX_METRIC` |
| R8 | Salience: validate + first-*valid*-ticker (fix first-match-only mis-binding) | P1 | S | reuses C7 validator |
| R9 | Query-embedding LRU (vector-only, never results) | P1 | S | `RAG_QUERY_EMBED_CACHE` |
| R10 | `content_hash` dedup for the `storeContexts` (8-K summary/disclosure) path | P1 | M | `VECTOR_STORECONTEXTS_DEDUP` |
| R11 | Faithfulness / citation-grounding eval (deterministic-first, optional LLM judge) | P1 | M | `RAG_EVAL_FAITHFULNESS_JUDGE` |
| R12 | Centralize default cosine floor for new callers (floor-only, no rerank-on-small-pool) | P2 | S | `RAG_APPLY_DEFAULT_FLOORS` |
| R13 | Provenance-complete citations (doc_type/as_of/section) + optional staleness label | P2 | S | `RAG_CITATION_STALENESS` |
| R14 | Near-duplicate suppression (MMR/shingle) before slice-to-limit | P2 | M | `RetrieveOptions.dedupeSimilarity` |
| R15 | Corpus coverage & freshness report (by doc_type/recency/symbol) | P2 | M | n/a (offline script) |
| R16 | Per-run RAG budget ceiling with graceful degradation | P2 | M | `RAG_RUN_BUDGET_ENABLED` |
| R17 | Fix train/serve text skew (`[Published:]`/header embedded write-side only) | P2 | M | `VECTOR_EMBED_CLEAN_TEXT` |

### P0 — integrity landmines & eval-protection

**R1 — Fail-closed as-of guard for undated chunks + `published_at` fallback** (merged from two lens proposals).
`isWithinAsOf` (`vector-db.ts:509-517`) resolves the stamp as `acceptance_datetime ?? as_of ?? timestamp` and returns **true (include)** when the stamp is missing/unparseable — a silent look-ahead hole for any dated retrieval. Two parts: (1) *unconditional, safe* — add `published_at` to the resolution chain with precedence `acceptance_datetime → published_at → as_of → timestamp` (`chunk.ts` populates `published_at`; the guard ignores it today); (2) *flag-gated* — under `VECTOR_ASOF_STRICT` **and only when `options.asOf` is set**, DROP chunks with no resolvable stamp and emit a drop-count audit so the ingest-dating gap is observable. Never change behavior when `asOf` is unset (chat default). Default off until the drop-count shows the corpus is well-dated enough that strict mode won't empty results. Add a golden as-of tuple (undated chunk excluded under guard, included without).

**R2 — Embedding integrity guard before upsert.**
`storeContexts` (`vector-db.ts:~393-403`) upserts `item.embedding` behind only a truthiness check — no assertion that `embedding.length === EMBEDDING_DIMENSION` (1024) or that values are finite. A Voyage model/config drift (wrong model, partial/NaN response, different dim) would upsert degenerate vectors that poison cosine scoring. Add `isValidEmbedding(v)` = array && `length===EMBEDDING_DIMENSION` && `v.every(Number.isFinite)`; drop-and-`audit` offending records (never throw — one bad vector must not fail a batch), count them in `StoreContextsResult`, and apply the same check to the query embedding at `:635` before `index.query`. This is an always-on guard (no flag) because it only rejects malformed data. Complements R7 (which checks the *metric*, assuming a well-formed vector).

**R3 — Golden-set anti-leakage + hard-negative lint** (test-only; protects C1/C2/C4).
The single biggest risk to the C1 harness is a golden set that leaks (queries paraphrase their own chunk text → trivially ~1.0 recall) or lacks hard negatives. Define a fixture schema `{query, relevant:[{id,grade}], hardNegatives:[id], asOf?}` and a `validateGoldenSet()` run at the top of `test/rag-retrieval-eval.test.ts` that asserts each query has ≥1 relevant + ≥1 hard negative, computes trigram overlap(query, relevant-chunk-text) and **warns** (not hard-fails, initially) past a threshold, and requires ≥K cross-ticker confusable cases. A leaky/negative-free golden set is worse than none — it rubber-stamps regressions.

**R4 — Retrieval regression net for as-of / rerank / hybrid fail-safes** (test-only).
Before C2/R1 modify the pipeline, pin the money-adjacent invariants with network-free unit tests over `matchToChunk`-shaped fixtures: (1) a chunk dated after `asOf` is dropped, an undated chunk kept (lenient) / dropped (strict, post-R1); (2) `rerankMatches` with a throwing mock preserves length+identity (fail-open); (3) `fuseHybrid` on ≤1 match / on error returns input order unchanged; (4) hybrid on-vs-off reorders but never drops. May require exporting a small pure `orderMatches`/`rankPool` helper (which C1 also wants).

### P1 — high-leverage, low-risk

**R5 — Consolidated per-retrieval telemetry record** (subsumes the "recall-proxy telemetry", "per-chunk retrieval trace", and "embed/rerank cost meter" proposals — build ONE, not three).
Emit a single default-off structured record per `retrieveContextDetailed` call: **hashed** query (never raw — PII/private-scope), `k`, candidates fetched, dropped-by-minScore, dropped-by-asOf, hybrid on/off, rerank ran/failed, top cosine, final count (add top `relevanceScore` once C2 lands). Route through a new `recordRetrievalQuality()` in `rag-metering.ts` (which already exists with `recordRagUsage`/`meterEmbed`/`meterRerank`), fire-and-forget + try/catch so it never breaks retrieval. Note: these are **distribution telemetry, not recall** — recall is only measurable against the R3 golden set; name fields accordingly so operators don't read cosine spread as recall.

**R6 — Shared fail-closed env-flag parser.**
`disclosureRagEnabled()` requires exact `'on'` (`disclosure-rag.ts:18-21`) while `rerankEnabled()`/`hybridRetrievalEnabled()` (`vector-db.ts:98-115`) accept `['1','true','on','yes']`. Introduce one `envFlagOn(name, default)` and route all three (plus new RAG flags) through it, preserving every current DEFAULT. The one behavior delta — `RAG_EMBED_DISCLOSURES=true/1/yes` now correctly enables disclosures (a flag the operator already tried to set ON) — must be called out in the rollout/operator note as an intentional, safe-direction change (it triggers embedding cost/corpus growth).

**R7 — Index-metric assertion at bootstrap.**
Every cosine floor (`VECTOR_MIN_SCORE`, C2's relevance floor) is meaningless if the Pinecone index metric isn't `cosine`. `EMBEDDING_DIMENSION` is asserted; the metric is not. On first `getClients()`/`indexExists` success, `describeIndex(indexName())` once, cache the metric; if `!== 'cosine'` emit `audit('vector_index_metric_mismatch', …)` + `console.warn` (WARN/audit, never throw — a legit non-cosine index or transient control-plane failure must not take down retrieval). Optional dev-only canary: assert a sample query-embedding L2 norm ~1.0. Do **not** add per-query normalization to the hot path unless the canary fails (voyage-finance-2 returns normalized vectors; Pinecone cosine normalizes internally).

**R8 — Salience: validate + first-*valid* ticker.**
Formalizes the C7 first-match-only correction as its own testable change. `salience.ts:95` binds the first CAPS token; for `'NVDA is the sole supplier for AMD and INTC'` (or a leading `I`/`CEO`) it mis-binds. Use `text.matchAll(/\b([A-Z]{1,5})\b/g)`, filter through the injected universe validator (fail-open on empty universe per C7), dedupe; if exactly one survives keep `symbol`, else set `symbol=null` (or extend to `symbols[]` only if the `LearnedContextCandidate` shape and `classify.ts` consumer are updated in lockstep — keep back-compat single `symbol` otherwise). Tests: multi-ticker sentence → no single mis-attribution; `I`/`CEO` rejected; single valid ticker unchanged.

**R9 — Query-embedding LRU (vector-only).**
Every `retrieveContextDetailed` embeds the query fresh (`vector-db.ts:632-633`); the strategy scan fans out per top-3 candidate symbol and chat re-issues near-identical queries — repeated Voyage query-embeds under the free-tier 3RPM cap (21s inter-batch stall). Add a TTL+size-bounded LRU keyed on `${VOYAGE_MODEL}:${query.trim()}` caching **only the 1024-dim query vector**, never Pinecone results (results depend on symbol/asOf/filters and stay live). Provably correct + user-independent (per-user scoping lives in the Pinecone filter, not the embedding). Count `meterEmbed` only on a miss. Test asserts the cache key omits `userId` and per-user filters still apply.

**R10 — `content_hash` dedup for the `storeContexts` path.**
Only the chunked `storeDocument` path dedups via `filterNewDocumentChunks`/`insertDocumentChunks` (`vector-db.ts:443-483`, `document_chunks` keyed on `content_hash`). The always-on 8-K **summary** ingest (`sec8k.ts`) and gated disclosure ingest call `storeContexts` directly with **zero** dedup — `refreshEightK` re-embeds the same 6-line summary every refresh cycle (`contextId` is stable so the upsert overwrites, but a fresh Voyage embed is still paid). Give `storeContexts` an opt-in `dedupKeyPrefix`: hash trimmed text (reuse the SHA-256-first-16 helper), skip docs whose hash is already indexed via `filterNewDocumentChunks`, `insertDocumentChunks` for survivors. Key on **text content**, not accession, so a genuinely-updated filing still re-embeds. Default off preserves current re-embed behavior.

**R11 — Faithfulness / citation-grounding eval** (merged from two near-identical proposals).
`docs/chat-assistant-rag-learning.md` §5 asks for "recall@k/MRR + **faithfulness**"; C1 covers only recall/MRR. Add an offline scorer over `(query, retrieved-chunks, model-answer)` tuples: deterministic first pass (each cited `chunk_id` present in retrieval? answer's numeric/entity claim substring-matches a chunk?) plus an optional LLM-judge (default-off, no-op without `OPENAI_API_KEY`, mirroring `scripts/eval/run-offline.ts`). Report a citation-support rate + unsupported-claim count. **Sequence after C1 + R3** (needs a validated, non-leaky golden set). Label the deterministic check a floor, never a verdict; keep the LLM-judge out of the required CI gate to avoid flaky builds.

### P2 — useful but dependent/speculative

**R12 — Centralize default cosine floor for new callers** (floor-only; the "run rerank on small pools" half is dropped as pointless — a full-pool set is returned regardless of ordering).
`defaultMinScore()` (`vector-db.ts:70-72`) is a helper never applied inside `retrieveContextDetailed`; only `strategy.ts:354` and `orchestrator.ts:182` pass it, so a *new* caller silently gets no floor. Add opt-in `applyDefaultFloors?: boolean` (or env `RAG_APPLY_DEFAULT_FLOORS`, default off) that applies `defaultMinScore()` when `options.minScore == null`. Prove the two existing call sites are byte-for-byte unchanged (they already pass it explicitly). Do **not** promote any floor to default-on before C1 can measure the recall cost — the `0.30` default is unvalidated.

**R13 — Provenance-complete citations + optional staleness label.**
`orchestrator.searchKnowledge` (`:174-186`) surfaces cosine `score` + a subset of fields. `RetrievedChunk` already carries `doc_type`/`as_of`/`section`/`url`; surface them as **additive-only** keys in the citation payload (safe, immediately useful for date/type sanity-checking). Gate a heuristic `isStale` boolean behind `RAG_CITATION_STALENESS` (documented, tunable horizons e.g. 10-K>400d, 8-K>90d, transcript>120d) rendered as an advisory recency label only — never a validity judgment, never fed into any numeric/sizing path. Pairs with C2's `relevanceScore` for "semantic confidence + recency" citations.

**R14 — Near-duplicate suppression before slice-to-limit.**
The pipeline never de-dups near-identical chunks; `chunk.ts`'s 12% overlap + duplicate 8-K summaries mean a 3-slot (strategy) or 5-slot (chat) context can be restatements of one passage. Add an opt-in greedy MMR / Jaccard-shingle filter (reuse `hybrid.ts` tokenize) just before `.slice(0, limit)`, dropping candidates ≥T similar to an already-selected one and back-filling from the pool. Conservative threshold + back-fill; O(k²) at k≤50 is trivial. Default unset = current behavior.

**R15 — Corpus coverage & freshness report** (offline script).
No way today to answer "what does the corpus know, how fresh, which symbols have zero coverage?" Add `scripts/eval/corpus-coverage.ts`: counts by `doc_type`, min/max/median `as_of` per type, top-N symbols by chunk count, and watchlist/position symbols with **zero** coverage. Source from `document_chunks` (runs offline without a Pinecone key), optionally augment with `describeIndexStats`. Gives C1/C4 the corpus-size context that makes recall numbers interpretable and is the concrete "how to verify corpus growth" recipe C3 needs. Verify `chunk.ts` populates `ticker[]` before relying on per-symbol counts.

**R16 — Per-run RAG budget ceiling with graceful degradation.**
Rerank is on by default and the strategy scan fans out per candidate; on a large universe this is unbounded embed+rerank+query volume, especially with a paid key (batch-delay 0). Implement as a **default-off, very-high-ceiling** per-process rolling-window counter (avoid threading a `runId` through call signatures initially). On trip, **degrade** by skipping rerank/hybrid only (fallbacks the pipeline already supports at `:715-720`) — never core recall — and emit one audit row. Do not add per-user/day accounting until R5 telemetry shows a real cost problem.

**R17 — Fix train/serve text skew.**
`storeContexts` embeds a literal `[Published: …]` prefix (`vector-db.ts:362`) and `chunk.ts` bakes a `context_header` into stored text, but the query embedding (`:632`) embeds the raw query with none of this boilerplate — a systematic query/document skew in voyage space that dilutes the cosine floor's meaning. The `!text.startsWith("[Published:")` guard also allows a header-prefixed chunk to get *both* header and `[Published:]` (double boilerplate). Behind `VECTOR_EMBED_CLEAN_TEXT`, embed clean chunk text and carry provenance in **metadata only** (`matchToChunk` already reads it). Flag-gate because it invalidates existing vectors' comparability (needs a reindex note); confirm no consumer parses the `[Published:]` prefix out of `chunk.text`.

---

## 3. Cross-file traps (cheap to check, expensive to miss)

- **`rerankMatches` order vs attribution (C2):** attribute `relevanceScore` by `item.index` against the *pre-rerank* `matches`, but return in *reranked* order. Clone the match; never mutate shared `match.metadata`.
- **`storeContexts` is a shared choke point (C5/R10/C6):** it serves chunked and un-chunked callers and can't currently tell them apart. Any cap-relaxation, dedup, or normalization must thread an explicit signal (`preChunked`/`dedupKeyPrefix`) or key on `is_table`/chunk-provenance metadata — a blanket change hits the 8-K summary path unintentionally.
- **Two separate stores, do not conflate (C6):** Pinecone vector `doc_type` metadata vs the `ingested_accessions` dedup key (mixed-case `FilingRef.docType`). Normalizing the former must not touch the latter (re-ingest storm).
- **`isWithinAsOf` fails open on undated stamps (R1):** it currently *includes* undated chunks — the opposite of what point-in-time correctness wants.
- **`salience.ts` purity (C7/R8):** never import a DB module into it; inject the validator. Its offline-testability is the reason its regex path is the deterministic test fallback.
- **`defaultMinScore()` is a helper, not a global floor (R12):** a new `retrieveContextDetailed` caller that forgets `minScore` gets *no* cosine floor.
- **`RetrievedChunk` field additions must stay optional:** `relevanceScore?`, any trace/provenance keys — 27+ construction/citation sites and offline fixtures depend on the current shape.

## 4. Verification / test guidance

- **No live Voyage/Pinecone in tests.** Record fixtures; spy on `getClients`/`meterEmbed` and assert not-called. Voyage rerank → inject a deterministic fake (identity or fixture permutation), not a network mock.
- **Determinism:** round scores before comparison; assert a stable sort so Set/Map iteration + RRF tie-breaks (`hybrid.ts` biases to dense on ties) don't drift run-to-run.
- **Byte-identical default proofs:** for every flag-gated item, a test asserting identical ids+order+scores with the flag unset.
- **Temp SQLite per run** (`DATABASE_URL=file:<tmpdir>/…`), never the dev `data/app.db` — R2/R10/R8/R15 touch `document_chunks`/`imported_securities_ref`.
- **Verify quartet before "done":** `npx tsc --noEmit` → `npm run lint` → `npm test` → `npm run build` (build wipes `.next/`; restart the PM2 preview after).
- **Named new tests:** `test/rag-retrieval-eval.test.ts` (C1+R3), `test/rag-retrieval-regression.test.ts` (R4), plus focused tests for C2, C5, C6, C7/R8, R2, R9, R10.

## 5. Open decisions

1. **Sequencing:** C1 (eval harness) + R3 (golden-set lint) + R4 (regression net) must land before C2/C4/R11, or those items are measured against an unvalidated set. Confirm C1 is scoped to emit a reusable pure `rankPool`/`orderMatches` helper (R1/R4/R12 all want it).
2. **as-of strict default (R1):** ship `published_at` fallback on (safe), but keep `VECTOR_ASOF_STRICT` off until the drop-count audit shows the corpus is well-dated. Owner call on when to flip.
3. **Rerank relevance floor calibration (C2):** the recommended `minRelevanceScore` is model-specific (rerank-2.5) and must be calibrated off the C1 harness — do not ship a numeric default; ship the field + docs only.
4. **Corpus enablement (C3):** flipping `RAG_EMBED_DISCLOSURES`/full-body needs a paid Voyage key — a config/cost decision for the owner, not a code default. R6 makes the flag honor `true/1/yes` (intentional safe-direction change — note it).
5. **R17 reindex:** cleaning embedded text splits old vs new vector representations. Decide whether to accept a transitional split or defer until a full reindex is scheduled.
6. **Multi-symbol learned facts (R8):** keep `symbol` singular (null on ambiguity) vs extend `LearnedContextCandidate` to `symbols[]` — the latter touches `classify.ts`. Default to the conservative singular+null.
