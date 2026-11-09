# 2026-07-06 - persist-pool-v2

## Summary

- Persist the PRE-`rankPool` candidate pool (`matches` in `retrieveContextDetailed`,
  `src/lib/vector-db.ts`) together with a per-candidate DISPOSITION naming the exact stage that
  dropped it (or `used`/`kept_not_used` for survivors), so "why did we drop this candidate" is
  finally analyzable — not just "did the final top-N cut lose an otherwise-qualified survivor"
  (the honest, narrower scope of #979/v1, `RAG_PERSIST_CANDIDATE_POOL`).
- `rankPool` (`vector-db.ts`) gained an OPTIONAL 5th-shape param on `RankPoolOptions`:
  `onDispositions?: (dispositions: Map<string, CandidateDisposition>) => void`. When supplied,
  `rankPool` tracks every input candidate through each stage as it filters
  (minScore → asOf → rerank-truncate → post-rerank relevance floor → dedupe) and invokes the hook
  exactly once with the full map before returning. Every EXISTING call site (production and every
  test in `test/rag-retrieval-regression.test.ts`) passes no hook, so `rankPool` remains a byte-
  identical pure function for them: no `Map` allocation, no key computation, no extra pass over the
  pool, same return value as before this change.
- `retrieveContextDetailed` wires a NEW, INDEPENDENT flag — `RAG_PERSIST_CANDIDATE_POOL_FULL`
  (envFlagOn-parsed, **default OFF**) — distinct from v1's `RAG_PERSIST_CANDIDATE_POOL` so the two
  toggle separately. The flag is checked BEFORE `rankPool` even runs (`wantFullPool`), mirroring
  v1's "no-op, not a suppressed write" posture: off means no hook is even constructed, so `rankPool`
  runs its exact pre-v2 path.
- New `recordCandidatePoolFull(record, userId)` in `src/lib/rag/candidate-pool.ts` persists via the
  existing `audit()` primitive under a NEW, distinct event kind `"rag_candidate_pool_full"` (v1's
  kind, `"rag_candidate_pool"`, is untouched) — no new table. Each candidate entry carries only
  `id`/`score`/`relevanceScore`/`docType`/`asOf`/`disposition` — never raw chunk text, same posture
  as v1/`hashQuery`.
- Dispositions (`CandidateDisposition` union): `dropped_minscore`, `dropped_asof`,
  `dropped_rerank_truncate` (Voyage's own `topK` cut, BEFORE the relevance floor runs),
  `dropped_rerank_floor`, `dropped_dedupe`, `kept_not_used` (survived rankPool, cut only by the
  caller's final top-`limit` slice), `used` (in the final slice).

## Why

- #979/v1 was built and merged with an explicit, honest limitation documented in its own rollout
  note: it captures `rankPool`'s OUTPUT (`ordered`), which is already POST minScore/asOf/hybrid/
  rerank/dedupe. Anything dropped by those stages never enters `ordered` and so was invisible to
  v1 — worse, in the FLAGSHIP production caller (`strategy.ts`'s filings pass: `dedupeSimilarity`
  = 0.6 non-null, `limit` = 3), both `dedupeSimilar` and `rerankMatches` already hard-cap their own
  output at `limit`, so `ordered.length <= limit` always holds there and essentially every
  persisted v1 row is `used:true` — near-zero `used:false` rows in exactly the path the feature was
  meant to illuminate, and ZERO visibility into the actually-interesting minScore/asOf/dedupe/
  rerank drops. v2 closes that gap by capturing the raw PRE-rankPool pool instead, with a drop
  reason attached to every candidate that didn't survive.
- The #822 multi-query/HyDE fan-out (`RetrieveOptions.queries`) fuses every query variant's matches
  into ONE pool (`matches` -> `rankPool` -> `ordered`) BEFORE `rankPool` runs, so capturing at the
  `matches` stage (same as v1's capture point relative to `ordered`) automatically covers the fused
  pool with no special-casing — exactly one record per `retrieveContextDetailed` call, matching v1's
  contract.

## Files

- `src/lib/rag/candidate-pool.ts` — added (below the existing v1 code, which is untouched):
  `candidatePoolFullPersistEnabled()`, `CandidateDisposition` (exported union type),
  `CandidatePoolEntryV2`/`CandidatePoolRecordV2` types, `recordCandidatePoolFull()`.
- `src/lib/vector-db.ts` — two distinct touched regions (see "Coordination" below for why this
  matters to the merge-forward):
  1. **`rankPool` region** (`RankPoolOptions` interface + the `rankPool` function body, roughly
     lines 2091-2320 pre-edit numbering): added the `onDispositions` option and threaded disposition
     tracking through the existing minScore filter, the existing as-of filter (WRAPS the existing
     `isWithinAsOf` call — does not replace or re-derive its logic), a new rerank-truncate detection
     (comparing `fusedPool` against `ordered` by a stable key, since `rerankMatches` returns new
     spread objects), the existing relevance-floor filter, and the existing dedupe call. All
     tracking is gated behind `typeof options.onDispositions === "function"` so it costs nothing
     when absent.
  2. **`retrieveContextDetailed` capture region** (immediately AFTER v1's existing capture block,
     before `const finalChunks = ...`): the `wantFullPool`/`capturedDispositions` wiring around the
     `rankPool(...)` call, and the new `recordCandidatePoolFull(...)` call block. Does not touch the
     query-filter-building code earlier in the function (imports, `buildExtraFilters`, the
     multi-query fan-out block) at all.
- `test/persist-candidate-pool-v2.test.ts` (new) — 9 tests: flag-off no-op (default unset + explicit
  `off`), flag-on capture with correct dispositions across a mixed pool (minScore/asOf/final-slice/
  used, dedupe off to isolate it), a dedicated dedupe-drop test, a rerank-truncate test, a combined
  rerank-truncate + relevance-floor test, the #822 multi-query fused-pool case, both-flags-on
  independence (v1 and v2 persist separately with different payloads), and queryHash stability.
- `test/rag-retrieval-regression.test.ts` — extended (v1's own suite, untouched otherwise) with a
  new `persist-pool-v2 — rankPool's optional onDispositions hook` describe block (7 tests): every-
  candidate-gets-one-disposition, dedupe-drop, rerank-truncate (distinct from the relevance floor),
  combined truncate+floor, id-less-candidate distinct-key hardening, and a pure-function-regression
  test proving `rankPool`'s return value is unaffected by whether a hook is passed.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/persist-candidate-pool.test.ts test/persist-candidate-pool-v2.test.ts
  test/rag-retrieval-regression.test.ts` — 43/43 passed (8 v1 + 9 v2 wiring + 26 regression-net,
  confirming v1 is unaffected and `rankPool`'s as-of/rerank/hybrid fail-safes still hold).
- Spot-checked beyond the task's required set (still scoped, not full `npm test`):
  `test/rag-retrieval-eval.test.ts`, `test/rag-retrieval-status.test.ts`,
  `test/vector-db-rerank-floor.test.ts`, `test/vector-db-rerank-overfetch.test.ts`,
  `test/vector-db-hybrid.test.ts`, `test/vector-db-asof-strict.test.ts`,
  `test/rag-multi-query-retrieval.test.ts`, `test/rag-multi-query.test.ts`,
  `test/rag-dedupe-similar.test.ts`, `test/vector-db.test.ts`, `test/vector-db-retrieval.test.ts`,
  `test/vector-db-provenance.test.ts` — 138/138 additional tests green, no regressions.
- Full `npm test` / `npm run build` intentionally NOT run in this worktree per task scope — a
  central operator/`scripts/land.sh` runs the full gate at landing time.

## Coordination (for the merge-forward)

Sibling lane `claude/server-asof-filter` also edits `src/lib/vector-db.ts` + `rankPool`'s as-of
stage (adds a Pinecone server-side as-of filter, so fewer future chunks reach `matches`, and may
adjust the `isWithinAsOf`/asOf-drop logic) and lands BEFORE this one. This lane:
- Keeps disposition tracking WRAPPED around whatever as-of logic exists at merge time — the
  `dropped_asof` disposition is assigned from the SAME `kept`/`isWithinAsOf(...)` boolean the
  filter already computes, not a re-derived check. If the sibling lane changes what counts as
  "kept" under as-of, `dropped_asof` inherits that change for free.
- Keeps the `retrieveContextDetailed` capture edits in their own region, distinct from wherever the
  sibling lane's query-filter-building changes land (that lane's likely region is earlier in the
  function, around `buildExtraFilters`/the Pinecone `index.query(...)` filter objects — not touched
  by this lane at all).
- Net effect: the merge-forward should be a clean 3-way merge (sibling's as-of-stage edit ABOVE
  this lane's disposition-tracking additions in the same filter block) rather than an overlapping
  edit to the same lines, but re-run `test/rag-retrieval-regression.test.ts` and
  `test/persist-candidate-pool-v2.test.ts` after merging forward to confirm.

## Follow-ups

- No new table was added (`audit_events` via `audit("rag_candidate_pool_full", ...)`), matching v1's
  precedent. A dedicated indexed table would be a future migration in `db.ts` + a new `db-*` module
  if volume/query-pattern needs later warrant it.
- This is observability-only, same as v1: nothing here changes retrieval, ranking, or what gets
  injected into any prompt. Both flags default OFF and are independent; enabling v2 does not require
  or imply enabling v1.
- Not yet pushed or PR'd (per task scope) — committed locally on `claude/persist-pool-v2` in worktree
  `trading-wt-pool-v2`, off `origin/main` at `b76b11ae`.

## Review fixes (2026-07-06, second commit)

A review pass found four issues in the original v2 landing above — all observability-only fixes,
none change which chunks are returned/used by retrieval.

**1. `dropped_dedupe` mislabeled limit-cap truncation as near-duplicate removal (the main fix).**
`dedupeSimilar` (`src/lib/rag/dedupe-similar.ts`) drops candidates for TWO structurally different
reasons that the original disposition loop conflated into one label: a genuine Jaccard-similarity
near-duplicate judgment, and its OWN internal `if (kept.length >= limit) break` top-`limit` cap
(same shape as the caller's final slice, just one stage earlier). On the FLAGSHIP production config
(`strategy.ts`: `limit=3`, `dedupeSimilarity=defaultDedupeSimilarity()=0.6`), the cap fires on
almost every run, so distinct non-duplicate candidates cut purely by that cap were mislabeled
`dropped_dedupe` — falsely implying they were near-duplicates of something already kept.
  - `dedupeSimilar` gained an optional 4th param, `report?: DedupeSimilarReport` (`{
    genuineDuplicateIndices: number[]; neverReachedIndices: number[] }`), populated only when
    passed — every pre-existing caller (there is exactly one, `rankPool`'s dedupe stage) that
    omits it sees zero behavior change; the function's return value is identical either way.
  - Semantics: an index only ever lands in `neverReachedIndices` if it was NEVER compared against
    the kept set in either the first pass or back-fill (pure cap truncation). An index that WAS
    compared and judged similar in the first pass stays a genuine duplicate even if back-fill's own
    cap fills up before it gets a second look — the first judgment stands; back-fill only
    un-classifies it if it turns out NOT similar on re-check.
  - New disposition `dropped_dedupe_truncate` added to the `CandidateDisposition` union
    (`src/lib/rag/candidate-pool.ts`), documented alongside `dropped_dedupe` in the same doc
    comment explaining the distinction. `rankPool` (`src/lib/vector-db.ts`) now requests the
    `report` out-param only when `wantDispositions` is true (zero extra cost otherwise) and emits
    `dropped_dedupe` for `genuineDuplicateIndices` / `dropped_dedupe_truncate` for
    `neverReachedIndices`.
  - Tests: `test/rag-dedupe-similar.test.ts` gained a 5-test `report` out-param describe block
    (5-distinct/limit=3 cap case, genuine-duplicate case, a mixed case, report-vs-no-report parity,
    and the early-return-shape case). `test/rag-retrieval-regression.test.ts` gained 2 tests
    exercising the exact flagship shape (`limit=3`, `dedupeSimilarity=0.6`, 5 distinct candidates ->
    the 2 cut ones are `dropped_dedupe_truncate`) and a mixed genuine-dup + cap-truncate case.
    `test/persist-candidate-pool-v2.test.ts` gained 1 end-to-end test through
    `retrieveContextDetailed` proving the same flagship-shape distinction at the full-stack level.

**2. Id-less match that SURVIVES rerank was mislabeled `dropped_rerank_truncate`, losing its
relevanceScore.** `rerankMatches` (`src/lib/vector-db.ts`) returns a NEW spread object
`{ ...match, _rerankScore }` for EVERY candidate Voyage assigns a numeric relevanceScore to —
including id-less ones, not just real-id ones. The v2 capture block's identity-based lookup
(`finalSliceIdentitySet`/`rerankScoreByIdentity`, built against the ORIGINAL pre-rerank `matches`
array) assumed an id-less match could only survive rerank by keeping its original object identity,
which is false — so an id-less rerank-survivor was invisible to both sets and got mislabeled
`dropped_rerank_truncate` with no relevanceScore even though it was actually `used`. The exact same
root-cause assumption (an incorrect comment claiming this case was impossible) also existed inside
`rankPool`'s own internal `resolveKey`, affecting its `dropped_rerank_truncate` detection.
  - Fix: `retrieveContextDetailed` now stamps a stable, own-enumerable `__poolKey` string (e.g.
    `__cand_3__`) onto every id-less match in `matches` BEFORE `rankPool`/rerank runs — but ONLY
    when `wantFullPool` (v2 enabled), so this is a true no-op otherwise. A plain object spread
    always copies own enumerable properties, so `__poolKey` survives rerank's copy intact,
    giving every id-less match a stable identifier exactly like a real Pinecone `id` would.
  - `rankPool`'s `resolveKey` gained a third lookup table (`keyByPoolKey`) checked after the
    identity and real-id maps, so its OWN disposition tracking (used for `dropped_rerank_truncate`
    detection and the final `kept_not_used` pass) is now also unaffected by this ordering.
  - The v2 capture block in `retrieveContextDetailed` was rewritten to key EVERY lookup
    (`finalSliceKeySet`, `rerankScoreByKey`) off a single `keyOf(m) = m.id || m.__poolKey`
    function, replacing the old real-id/identity split entirely. The persisted `id` field is
    still always `String(m?.id ?? "")` — `__poolKey` is a purely internal disambiguation key and
    is asserted (in the new test) to never leak into the persisted payload.
  - Test: `test/persist-candidate-pool-v2.test.ts` gained a dedicated test with 2 id-less matches +
    1 real-id match, `limit=2`, rerank ON, where Voyage returns the id-less match as the TOP-scored
    survivor (reordered ahead of the real-id one) and truncates the other id-less match — asserts
    the survivor is `used` with the correct `relevanceScore`, the truncated one is
    `dropped_rerank_truncate` with no `relevanceScore`, and `__poolKey` never appears in any
    persisted candidate row.

**3. Observability capture could turn a successful retrieval into an empty one.** Both the v1 and
v2 capture blocks in `retrieveContextDetailed` ran before the function's `return finalChunks`,
protected only by the function's OUTER catch — which returns `[]` on any throw. A throw anywhere
inside either capture block (mapping, hashing, key computation) would have silently discarded a
fully successful retrieval, which is backwards for an advisory-only feature.
  - Both blocks are now wrapped in their own local `try/catch` that swallows any throw (logs a
    `console.warn`, never re-throws), so retrieval proceeds to `return finalChunks` regardless.
    Applied to BOTH v1 (defense in depth — same exposure existed on `main` before this lane) and v2.
  - Tests: `test/persist-candidate-pool.test.ts` and `test/persist-candidate-pool-v2.test.ts` each
    gained a test that makes the mocked `audit()` throw specifically for that version's event kind
    (`"rag_candidate_pool"` / `"rag_candidate_pool_full"`) and asserts `retrieveContextDetailed`
    still returns the full, correct chunk set.

**4. Defensive hard cap on the v2 persisted payload.** `recordCandidatePoolFull` persisted
`matches.length` candidates uncapped, and `matches` is bounded by `fetchK` — which for the rerank
path is `rerankOverFetchK(limit)`, env-tunable ABOVE its 150 default via
`VECTOR_RERANK_OVERFETCH_K` with no upper clamp. An operator setting that env var very high would
let the audit payload balloon 1:1 with it.
  - `src/lib/rag/candidate-pool.ts` added `MAX_PERSISTED_CANDIDATES_V2 = 500` (a generous backstop,
    not a normal operating limit) and `recordCandidatePoolFull` now slices its `candidates` array to
    that cap before persisting. `candidateCount` in the payload still reports the TRUE (pre-cap)
    length, so a capped payload is honestly labeled as coming from a larger pool rather than
    silently presented as complete.
  - Tests: a new `recordCandidatePoolFull: defensive hard cap` describe block in
    `test/persist-candidate-pool-v2.test.ts` (2 tests) — a 600-candidate input is truncated to
    <=500 persisted rows while `candidateCount` still reports 600; a normal-sized (5-candidate)
    input is untouched.

### Files touched (review fixes only)

- `src/lib/rag/dedupe-similar.ts` — `DedupeSimilarReport` type + optional `report` param on
  `dedupeSimilar`.
- `src/lib/rag/candidate-pool.ts` — `dropped_dedupe_truncate` added to `CandidateDisposition`
  (with updated doc comment); `MAX_PERSISTED_CANDIDATES_V2` cap in `recordCandidatePoolFull`.
- `src/lib/vector-db.ts` — `rankPool`'s dedupe-stage disposition tracking now uses the `report`
  out-param; `rankPool`'s `resolveKey`/`keyFor` gained the `__poolKey` fallback lookup;
  `retrieveContextDetailed` stamps `__poolKey` on id-less matches pre-rerank (v2-only); the v2
  capture block's key resolution was rewritten around `keyOf(m) = m.id || m.__poolKey`; both the
  v1 and v2 capture blocks are now wrapped in their own try/catch.
- `test/rag-dedupe-similar.test.ts` — 5 new tests for the `report` out-param.
- `test/rag-retrieval-regression.test.ts` — 2 new tests for `dropped_dedupe_truncate` at the
  `rankPool` level.
- `test/persist-candidate-pool-v2.test.ts` — 5 new tests: flagship dedupe-truncate distinction
  (end-to-end), id-less rerank-survivor correctness, capture-throw-safety, and 2 defensive-cap
  tests.
- `test/persist-candidate-pool.test.ts` — 1 new test: v1 capture-throw-safety (defense in depth).
- `docs/rollouts/2026-07-06-persist-pool-v2.md` — this section.

### Verification (review fixes)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/persist-candidate-pool.test.ts test/persist-candidate-pool-v2.test.ts
  test/rag-retrieval-regression.test.ts` — **51/51 passed** (9 v1 + 14 v2 + 28 regression-net; up
  from the original 43 by the review-fix tests above).
- `npx vitest run test/rag-dedupe-similar.test.ts` — **15/15 passed** (10 original + 5 new).
- `npx eslint src/lib/vector-db.ts src/lib/rag/candidate-pool.ts src/lib/rag/dedupe-similar.ts
  test/persist-candidate-pool.test.ts test/persist-candidate-pool-v2.test.ts
  test/rag-retrieval-regression.test.ts test/rag-dedupe-similar.test.ts` — 0 errors (54
  pre-existing-pattern `no-explicit-any` warnings, consistent with the rest of the file; the repo
  gate only fails on errors).
- Spot-checked the same broader RAG suite the original landing checked (unaffected):
  `test/rag-retrieval-eval.test.ts`, `test/rag-retrieval-status.test.ts`,
  `test/vector-db-rerank-floor.test.ts`, `test/vector-db-rerank-overfetch.test.ts`,
  `test/vector-db-hybrid.test.ts`, `test/vector-db-asof-strict.test.ts`,
  `test/rag-multi-query-retrieval.test.ts`, `test/rag-multi-query.test.ts`, `test/vector-db.test.ts`,
  `test/vector-db-retrieval.test.ts`, `test/vector-db-provenance.test.ts` — 128/128 passed.
- Full `npm test` / `npm run build` intentionally NOT run in this worktree, matching the original
  landing's stated scope — a central operator/`scripts/land.sh` runs the full gate at landing time.
- Scope discipline: no edits to `policy.ts`, `deterministicBearFilter`, `regime-watch.ts`,
  `app/**`/`src/app/**`, workflows, `AGENTS.md`/`CLAUDE.md`, `scripts/*.sh`, or
  `chat/orchestrator.ts`. Edits to `src/lib/vector-db.ts` were kept localized to the same two
  regions (`rankPool` body + the `retrieveContextDetailed` capture region) the original landing
  already isolated, per the "Coordination" note above — the sibling `claude/server-asof-filter`
  lane's likely touch points (query-filter-building, `buildExtraFilters`) were not touched.
