# 2026-07-05 - hyde-multiquery-retrieval

## Summary

Adds HyDE (Hypothetical Document Embeddings) + evidence-derived multi-query retrieval for the
filings RAG pass, flag-gated **DEFAULT OFF** — byte-identical retrieval behavior when both flags
are off.

- New `src/lib/rag/multi-query.ts`:
  - `deriveQueryVariants(input)` — pure, deterministic, no I/O. Derives 2-4 focused facet
    sub-queries (risk factors, guidance/earnings, litigation/regulatory, supply-chain/operational)
    for a candidate symbol from its sector/dominant-factor/evidence-bulletins/regime/thesis
    context. Returns `[]` for a bare symbol with no usable context, so the caller falls back to
    its existing static query rather than retrieving with zero variants.
  - `generateHydePassages(queries, opts)` — ONE cheap, fail-open LLM call that drafts 1-3 short
    hypothetical filing-register passages for the given sub-queries (mirrors
    `src/lib/memory/salience-llm.ts`'s pattern: `resolveLlmEndpoint` + `buildLlmRequestBody` +
    `llmAuthHeaders` + `fetch` with `AbortSignal.timeout(LLM_TIMEOUT_MS)` + `extractLlmText`).
    Returns `[]` on ANY failure (no credential, network error, timeout, non-OK response, malformed
    JSON) — a HyDE outage never blocks or degrades retrieval. Records usage via `recordLlmUsage`
    under `context: "rag-hyde"` on success (best-effort; a usage-recording failure doesn't affect
    the returned passages). Cheap default model `gpt-5.4-mini`, overridable via `RAG_HYDE_MODEL`.
  - `multiQueryEnabled()` / `hydeEnabled()` — both route through the shared `envFlagOn` parser,
    both default `false`. Independent flags: `RAG_MULTIQUERY` (facet sub-queries only) and
    `RAG_HYDE` (additionally draft + retrieve on HyDE passages; has no effect unless
    `RAG_MULTIQUERY` is also on, since HyDE passages are generated FROM the derived variants).

- `src/lib/vector-db.ts`:
  - `RetrieveOptions` gains optional `queries?: string[]`.
  - `retrieveContextDetailed`'s embed/query section is refactored into a reusable
    `embedAndMatchOneQuery(q)` closure (embed via the existing query-embed cache, integrity-check,
    Pinecone match against the same per-symbol/shared-tier filters as before). When
    `options.queries` is absent/empty, this runs EXACTLY as before (one embed, one Pinecone query
    round-trip) — the single-query path is unchanged code, just factored into the closure.
  - When `options.queries` is a non-empty array, each query is embedded+matched independently (in
    parallel via `Promise.all`), and the per-query ranked id lists are fused with `rrfFuse`
    (`rag/hybrid.ts` — already generic over N ranked lists, confirmed during recon) into one
    candidate pool. That fused pool feeds the EXISTING `rankPool` pipeline (hybrid BM25/rerank/
    floors/dedup) completely unchanged — the primary `query` argument still drives BM25 fusion and
    rerank scoring; `queries` only affects which Pinecone matches are recalled into the pool.
    A malformed embedding for a given variant is treated as "no result for that query" (filtered
    out); if every variant's embedding is malformed, retrieval returns `[]` (fail-safe, same as the
    existing single-query malformed-embedding path).

- `src/lib/strategy.ts` filings-RAG block (the per-top-candidate `10-k/10-q/8-k/earnings-transcript`
  retrieval pass, ~3 candidates): behind `multiQueryEnabled() && !shouldDegradeForBudget()`, derives
  variants from the candidate's `factorBreakdown` (dominant factor), `marketScan.sectorBySymbol`/
  `candidate.sector`, and `candidate.evidenceBulletins` (mirrors the existing
  `experience-memory.ts` `buildSituationSketch`/`situationCandidates` construction precedent).
  Behind `hydeEnabled()` (additionally, only when variants were derived), calls
  `generateHydePassages(variants, { userId })` and appends the drafted passages to the variant
  list. The resulting `variants` array is passed as `queries` only when non-empty; otherwise no
  `queries` key is added to the options object at all, so the flags-off / no-context path is
  identical to the pre-existing single-query call.

- `.env.example`: documents `RAG_MULTIQUERY=off`, `RAG_HYDE=off`, `RAG_HYDE_MODEL=gpt-5.4-mini`.

## Why

The filings RAG pass (item in the composite RAG backlog) has retrieved with one static
per-symbol query since it was built ("Significant financial events, SEC filings, and macro
catalysts for {sym}"). That query is generic and keyword-ish, which is a known recall gap against
filing prose: (1) it doesn't target the specific facets (risk/guidance/litigation/supply-chain)
that differ per candidate, and (2) it doesn't read like the SEC-filing register the dense index
was built from, which HyDE-style hypothetical passages address by drafting text closer in style
to what's actually being searched. Both stages are additive and default-off so the change ships
with zero behavior risk to the existing pipeline; an operator can turn `RAG_MULTIQUERY` on alone
to get the facet fan-out cheaply (no extra LLM cost, just extra embed+match calls), or add
`RAG_HYDE` on top once they've verified it's worth the one extra LLM call per top-3-candidate
filings pass.

`vector-db.ts`'s `RetrieveOptions`/`rankPool` split (from the 2026-07-01 RAG backlog) made this a
clean seam: the multi-query fan-out only needed to touch the embed+match assembly, never
`rankPool` itself, so hybrid/rerank/floors/dedup behavior for every existing caller (strategy.ts's
episodic pass, orchestrator.ts, disclosure-rag.ts) is provably untouched — none of those call
sites pass `queries`, so `options?.queries` is always `undefined` for them and the new branch never
executes.

## Files

- `src/lib/rag/multi-query.ts` (new)
- `src/lib/vector-db.ts` (added `RetrieveOptions.queries`; refactored the embed/query section of
  `retrieveContextDetailed` into `embedAndMatchOneQuery` + a multi-query RRF-fuse branch; imported
  `rrfFuse` from `./rag/hybrid`)
- `src/lib/strategy.ts` (filings-RAG block only: derive variants + optional HyDE passages behind
  both flags, pass as `options.queries` when non-empty)
- `.env.example` (documents `RAG_MULTIQUERY`, `RAG_HYDE`, `RAG_HYDE_MODEL`)
- `test/rag-multi-query.test.ts` (new — 14 tests, pure `deriveQueryVariants` cases incl.
  empty-evidence -> `[]`, facet-count contract, evidence truncation/cap, flag defaults)
- `test/rag-hyde.test.ts` (new — 10 tests, mocked LLM: passage drafting + usage recording under
  `"rag-hyde"`, model override, fail-open on no-key/network-error/non-OK/malformed-JSON, 3-passage cap)
- `test/rag-multi-query-retrieval.test.ts` (new — 5 tests, `vector-db.ts` wiring: flags-off/queries-
  omitted/queries-`[]` byte-identical single-embed-single-query regression, per-variant
  embed+match fan-out, RRF-fusion-ranks-overlap-first case, all-malformed-embeddings -> `[]`)
- `STATUS.md` (dated section)
- `docs/EFFORT-LOG.md` (new In Progress row)

## Verification

- `npx tsc --noEmit` — clean (run after `NODE_AUTH_TOKEN=$(gh auth token) npm ci` restored a
  partially-missing `node_modules`/`.bin` in this worktree; see Follow-ups).
- `npx vitest run test/rag-multi-query.test.ts test/rag-hyde.test.ts test/rag-multi-query-retrieval.test.ts`
  — 29 tests, all green.
- Combined focused run (every RAG/vector-db/salience/disclosure-rag test file plus the strategy
  files most likely to exercise the filings block):
  `npx vitest run test/rag-*.test.ts test/vector-db*.test.ts test/disclosure-rag.test.ts
  test/strategy-rag-quickwins-wiring.test.ts test/salience-llm.test.ts
  test/salience-ticker-binding.test.ts test/run-strategy-offline.test.ts
  test/strategy-episodic-injection.test.ts test/strategy-hardening.test.ts
  test/strategy-money-path-f-g.test.ts test/account-deletion-coverage.test.ts`
  — 33 files / 381 tests, all green (no regressions in existing RAG/vector-db/salience/strategy
  suites after both the `vector-db.ts` refactor and the `strategy.ts` filings-block edit).
- Did NOT run full `npm test` or `npm run build` per this lane's hard rules (focused verification only).

## Review fixes (2026-07-05, same day)

A review of the initial slice found one blocker and several minor issues, all fixed in a second
commit on this branch (no amend):

- **BLOCKER — fan-out was fail-CLOSED, not fail-open (`vector-db.ts`).** The multi-query
  `Promise.all(options.queries.map(embedAndMatchOneQuery))` had no per-item catch, and
  `embedAndMatchOneQuery`'s callees (`withRagApiHealth`/`embedWithRetry`) rethrow on a transient
  Voyage/Pinecone error — so ONE variant's failure rejected the WHOLE `Promise.all`, discarding
  every other variant's already-successful results, hitting the outer `catch`, and returning `[]`
  (empty filings context) even when most variants succeeded. Separately, `if (validResults.length
  === 0) return [];` never fell back to the caller's plain single query, contradicting this
  module's own "always falls back to the caller's original single query, never throws" promise.
  Fixed: each fan-out call is now individually try/caught (a rejected variant -> `null`, dropped,
  same contract as a malformed embedding); when EVERY variant fails or fuses to nothing, retrieval
  now falls back to the plain single-`query` path (i.e. behaves exactly as flags-off) instead of
  returning `[]`. `test/rag-multi-query-retrieval.test.ts`'s "falls back to `[]` on all-malformed"
  test (which pinned the wrong behavior) was rewritten to assert the single-query fallback path is
  taken (still `[]` in that specific all-malformed case, but reached via the fallback, not a
  short-circuit — asserted via the expected embed-call count); a new test asserts that when ONE
  variant rejects, the OTHER variants' results still surface with no throw.
- **Minor — first-occurrence-wins id resolution could keep a lower score (`vector-db.ts`).** When
  building the fused id -> match map, a chunk id appearing in multiple per-query pools kept
  whichever occurrence was seen first, which could feed a LOWER cosine score into `rankPool`'s
  `minScore` floor for that chunk. Fixed: the occurrence with the HIGHER `match.score` now wins.
- **Minor — HyDE endpoint/model incoherence (`multi-query.ts`).** `generateHydePassages` resolved
  its endpoint via `resolveLlmEndpoint(policy, ...)` (keyed off `policy.llmModel`) but then sent
  the separately-configured `hydeModel()` (default `gpt-5.4-mini`, override via `RAG_HYDE_MODEL`)
  in the request body — under an Anthropic `policy.llmModel`, this shipped an OpenAI model id to
  `api.anthropic.com`, got a 400, and returned `[]` silently (non-OK responses weren't audited).
  Fixed: the endpoint is now resolved FOR the HyDE model actually sent (by passing `{ ...policy,
  llmModel: hydeModel() }` into `resolveLlmEndpoint`, so provider/URL/transport/key all agree with
  `endpoint.model`, mirroring how `salience-llm.ts` always sends `endpoint.model` verbatim); the
  request body and `recordLlmUsage` call now use `endpoint.model` instead of the raw `hydeModel()`.
  A non-OK response now also fires the existing best-effort `rag_hyde_failed` audit (previously
  only the network-error/malformed-JSON paths audited).
- **Minor — false "independent flags" claim (`multi-query.ts`, docs only).** The module docstring
  and `hydeEnabled()`'s doc comment claimed `RAG_MULTIQUERY`/`RAG_HYDE` were independent ("either
  can run alone"), but `strategy.ts`'s call site only drafts HyDE passages from the variants
  `deriveQueryVariants` produced inside the `wantMultiQuery` branch — `RAG_HYDE=on` alone is a
  no-op. Fixed the docstrings only (`multi-query.ts`'s header comment and `hydeEnabled()`'s doc
  comment) to state the dependency plainly; `.env.example`'s comment already stated this correctly
  and needed no change. `strategy.ts`'s gating structure itself was intentionally left untouched.
- **Minor — HyDE spend not gated on the daily LLM budget (`multi-query.ts`).** `generateHydePassages`
  only depended on `strategy.ts`'s best-effort per-run `shouldDegradeForBudget()` check, unlike
  `retrieveContextDetailed`'s own durable `isOverLlmBudget` gate. Fixed: `generateHydePassages` now
  short-circuits to `[]` (no request) when `isOverLlmBudget(userId, connectedAccountId)` is true —
  a read-only import from `./llm-budget` (no edits to that file). `strategy.ts`'s call site was
  updated to pass `connectedAccountId: policy.connectedAccountId` through (comment-plus-argument
  addition only, no gating restructure).
- **Nit — primary query dropped from the fan-out (`vector-db.ts`).** Previously only
  `options.queries` (the derived variants/HyDE passages) were embedded+matched when multi-query was
  active; the caller's original `query` string was used solely for BM25/rerank scoring, never for
  its own dense recall pass. Fixed: the fan-out list is now `[query, ...options.queries]` (deduped),
  so the primary query's dense recall is augmented rather than replaced by the variants.

Files touched in this pass: `src/lib/vector-db.ts`, `src/lib/rag/multi-query.ts`,
`src/lib/strategy.ts` (one-line addition + comment only, no gating restructure),
`test/rag-multi-query-retrieval.test.ts`, `test/rag-hyde.test.ts`, this rollout note.

Verification: `npx tsc --noEmit` clean;
`npx vitest run test/rag-multi-query.test.ts test/rag-hyde.test.ts
test/rag-multi-query-retrieval.test.ts test/rag-retrieval-eval.test.ts
test/rag-retrieval-regression.test.ts test/strategy-rag-quickwins-wiring.test.ts` — 6 files / 62
tests, all green; broader safety-net re-run of the original 33-file/381-test combined focused list
(now 384 tests — 3 new fan-out/budget/endpoint-coherence tests) — all green, no regressions.

## Follow-ups

- This worktree's `node_modules` was missing its `.bin` directory and most dependencies at session
  start (only 117 packages present, no `tsc` binary) despite the task brief stating it was already
  installed — likely the disk-janitor launchd agent (see memory) reaping a regenerable artifact
  from an idle worktree. Restored via `NODE_AUTH_TOKEN=$(gh auth token) npm ci`; no code impact,
  noting it here per the "local verify + shared pin" memory precedent in case another session hits
  the same thing in this worktree.
- Line numbers in `strategy.ts`'s filings-RAG block will likely shift once the sibling
  `claude/prompt-safety-fencing` lane lands (it touches `strategy.ts` prompt-assembly elsewhere);
  the diff here was kept intentionally tight (import + a small `if (wantMultiQuery)` block inside
  the existing `topSymbols.map` callback) so a merge should stay mechanical — locate by the
  `retrieveContextDetailed` call site / `multiQueryEnabled` symbol rather than line number.
  Coordinate on `#ag***-s**c` if a real conflict shows up.
- Not yet built (out of scope for this slice, natural next steps): a retrieval-quality eval
  entry comparing single-query vs. multi-query vs. multi-query+HyDE recall@k/MRR on the existing
  `test/fixtures/rag-retrieval-eval-fixture.ts` harness, so a future decision to flip either flag
  on by default has quantitative backing rather than just "should help" reasoning.
- `generateHydePassages` currently derives its sub-topics ONLY from `deriveQueryVariants`'s output
  (i.e. `RAG_HYDE` is a no-op unless `RAG_MULTIQUERY` is also on, since there's nothing to draft
  HyDE passages for when the caller only has one generic query). If a future caller wants a
  standalone-HyDE mode (HyDE on the single static query, no facet variants), that would need a
  small explicit branch in `strategy.ts` — not built here since the task scope treats them as an
  additive pair off the same evidence-derived variants.
