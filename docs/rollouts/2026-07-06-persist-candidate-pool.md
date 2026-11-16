# 2026-07-06 - persist-candidate-pool

## Summary

- Persist the FULL retrieved candidate pool from `retrieveContextDetailed` (`src/lib/vector-db.ts`)
  — including chunks that survived score-floor/as-of/hybrid/rerank/dedupe but were cut only by the
  final top-`limit` slice — so "what did we retrieve but not inject" is analyzable after the fact.
  Gated behind a new flag, `RAG_PERSIST_CANDIDATE_POOL` (envFlagOn-parsed, **default OFF**). When
  off, the capture block is a true no-op (the flag check runs before any mapping/hashing work) —
  retrieval behavior and its audit-call count are byte-identical to before this change.
- New module `src/lib/rag/candidate-pool.ts` exports `candidatePoolPersistEnabled()` and
  `recordCandidatePool(record, userId)`, which persists via the existing `audit()` primitive under
  a new event kind `"rag_candidate_pool"` — no new table. Each candidate entry carries only
  `id`/`score`/`relevanceScore`/`docType`/`asOf`/`used` — never raw chunk text (mirrors the
  existing `hashQuery` "never persist raw query text" posture already used by
  `recordRetrievalQuality`).
- `RetrieveOptions.runId` added as an additive optional field and threaded from both `strategy.ts`
  retrieval call sites (the filings pass and, via `experience-memory.ts`'s
  `retrieveDecisionExperiences` — which already received `runId` as an input — the episodic pass)
  so a persisted record can be joined back to the strategy run that produced it.

## Why

- Ground truth (verified before starting): today only the post-selection top-5 chunks that
  actually reach a prompt get persisted — `ragAttributionsFromChunks` in `socratic-runtime.ts`
  slices `chunks.slice(0, 5)`, and `strategy.ts`'s `socraticRagAttributions` (lines ~735/~876) are
  built from the already-final `context.chunks`. The pre-slice candidate pool `rankPool` produces
  inside `retrieveContextDetailed` (the `ordered` value right before `.slice(0, limit)`, previously
  at vector-db.ts:1920) was discarded in-function with no trace. This closes that gap for
  after-the-fact retrieval-quality analysis (e.g. "was the right chunk retrieved but simply
  outranked at the final cut, or never recalled/surfaced at all") without changing what actually
  gets injected into any prompt.
- The #822 multi-query/HyDE fan-out (`RetrieveOptions.queries`) fuses every query variant's matches
  into ONE pool (`matches` -> `rankPool` -> `ordered`) before this capture point runs, so a single
  capture here automatically reflects the fused pool — no special-casing needed for multi-query.

## Files

- `src/lib/rag/candidate-pool.ts` (new) — `candidatePoolPersistEnabled()`, `recordCandidatePool()`,
  `CandidatePoolEntry`/`CandidatePoolRecord` types.
- `src/lib/vector-db.ts` — import `candidatePoolPersistEnabled`/`recordCandidatePool`; added
  `RetrieveOptions.runId` (additive/optional); inserted the capture block in
  `retrieveContextDetailed` immediately before the final `.slice(0, limit).map(matchToChunk)...`
  (now reads the already-computed `ordered` pool and the freshly-sliced `finalSlice` to derive each
  candidate's `used` flag).
- `src/lib/strategy.ts` — threaded `runId` (already in scope) into the filings retrieval call's
  options object (~line 719-731).
- `src/lib/experience-memory.ts` — threaded `input.runId` (already an input to
  `retrieveDecisionExperiences`) into its internal `retrieveContextDetailed` call (~line 425-439).
- `test/persist-candidate-pool.test.ts` (new) — 9 tests: flag-off no-op (default unset + explicit
  `off`), flag-on capture of a quality-surviving-but-not-selected candidate with correct `used`
  flags, correct absence of candidates dropped upstream by minScore/asOf (they never enter
  `ordered`), correct absence of a dedupe-dropped candidate, relevanceScore/asOf field mapping from
  rerank/metadata, the #822 multi-query case producing exactly ONE fused-pool record, and
  queryHash stability/never-raw-text.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/persist-candidate-pool.test.ts test/rag-retrieval-regression.test.ts` —
  26/26 passed (9 new + 17 pre-existing regression-net tests, confirming `rankPool` itself and the
  as-of/rerank/hybrid fail-safes are unaffected).
- Spot-checked adjacent suites for regressions from the additive `RetrieveOptions.runId` field and
  the new capture block: `test/rag-multi-query-retrieval.test.ts`, `test/rag-multi-query.test.ts`,
  `test/rag-retrieval-eval.test.ts`, `test/rag-metering.test.ts`, `test/rag-env-flag.test.ts`,
  `test/strategy-rag-quickwins-wiring.test.ts`, `test/rag-hyde.test.ts`,
  `test/experience-memory.test.ts`, `test/strategy-episodic-injection.test.ts` — all green (66 + 6
  + 2 = 74 additional tests, no failures).
- Full `npm test` / `npm run build` intentionally NOT run in this worktree — this lane's assigned
  scope is focused tests only; a central operator runs the full gate at landing time via
  `scripts/land.sh`.

## Follow-ups

- **Known limitation (found in 2026-07-06 hardening pass — read before relying on this for "why
  did we drop X" analysis):** the capture reads `ordered`, `rankPool`'s OUTPUT pool — already
  post-minScore/asOf/hybrid/rerank/dedupe. So `used:false` rows are ONLY final-top-N-slice cuts of
  survivors; candidates dropped upstream by minScore/asOf/dedupe never appear at all, `used:false`
  or otherwise. Worse, the FLAGSHIP production caller — `strategy.ts`'s filings retrieval pass
  (~line 719-731) — passes `dedupeSimilarity: defaultDedupeSimilarity()` (0.6, non-null) with
  `limit: 3`, and both `dedupeSimilar` and `rerankMatches` already hard-cap their output at
  `limit`. So in that DEFAULT strategy config, `ordered.length <= limit` always holds, meaning
  `finalSlice === ordered` and essentially every persisted row is `used:true` — zero/near-zero
  `used:false` rows in exactly the path this feature was meant to illuminate. The genuinely
  interesting minScore/asOf/dedupe drops are simply not captured by this feature as shipped. A v2
  that instead captures the PRE-rankPool `matches` pool with a per-stage drop reason (minScore /
  asOf / dedupe / final-slice) is the real follow-up if "why did we drop this candidate" is the
  actual goal — this v1 only ever tells you "did the final top-N cut lose an otherwise-qualified
  candidate", and in the shipped default config it rarely even shows that.
- Sibling lane `claude/typed-retrieval-status` also edits `retrieveContextDetailed` in
  `vector-db.ts` (the early-return/classification region, not touched here). This lane lands
  AFTER it per the coordination note; if the merge isn't clean, re-verify the capture block still
  sits immediately before the final slice and re-run the two test files above.
- No new table was added (`audit_events` is used via `audit("rag_candidate_pool", ...)`). If
  volume/query-pattern needs later warrant a dedicated indexed table, that would be a follow-up
  migration in `db.ts` plus a new `db-*` module, re-exported from the `db.ts` barrel per repo
  convention.
- This is observability-only: nothing here changes retrieval, ranking, or what gets injected into
  any prompt — advisory/analysis-only per the flag-gated-default-off pattern used throughout the
  RAG backlog.
