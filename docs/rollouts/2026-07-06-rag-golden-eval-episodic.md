# 2026-07-06 - rag-golden-eval-episodic

## Summary

- Expanded the RAG retrieval golden eval with 10 new episodic-decision-memory fixture cases
  (`socratic-decision`/`coach-note`/`lesson` doc types) plus two new `describe` blocks in the eval
  test file: an episodic recall@k/MRR suite, and a single-query-vs-multi-query suite exercising
  `RetrieveOptions.queries`/`rrfFuse` (#822) directly against `retrieveContextDetailed`.
- Test/fixture/docs only. No production code changed. No RAG env flag default changed
  (`RAG_MULTIQUERY`/`RAG_HYDE` remain default-off, untouched).

## Why

- Triage-verified ground truth going in: `test/fixtures/rag-retrieval-eval-fixture.ts` (462 lines
  before this change) had ONLY filings doc-type cases (`10-k`/`10-q`/`8-k`) and zero cases over
  `EPISODIC_DOC_TYPES = ["socratic-decision", "coach-note", "lesson"]`
  (`src/lib/experience-memory.ts:44`) — the episodic decision-memory retrieval pass
  (`retrieveDecisionExperiences`, wired into `strategy.ts` per the 2026-07-04 composite review) had
  no eval coverage at all, and the existing filings-only harness reportedly saturates at recall 1.0
  because none of its hard negatives are genuinely confusable near-misses for a decision-memory
  query.
- `#822` (HyDE + evidence-derived multi-query retrieval, merged 2026-07-05,
  `d97b7c71`) added `RetrieveOptions.queries` + `rrfFuse` fan-out to `retrieveContextDetailed`, but
  `test/rag-retrieval-eval.test.ts`'s `runFixture` never passed `options.queries` — so the eval
  harness had no coverage of the multi-query path even though it exists in production (behind
  default-off flags in `strategy.ts`).
- Both gaps are closed here without touching production code: the fixture gained realistic
  episodic cases (mirroring `buildClosedLotExperienceDocument`'s exact text shape:
  `ticker`/`side`/`thesis_tag`/`entry_market_regime`/`entry_rationale`/`exit_reason`/
  `realized_outcome`) with hard negatives that share symbol+regime but flip thesis or direction —
  the same kind of near-miss a real cross-encoder must resolve, not a bag-of-words giveaway — and
  the test file gained a small, additive `cases` option on `runFixture` plus a dedicated
  single-vs-multi-query harness function that calls `retrieveContextDetailed` with and without
  `options.queries` set.

## Files

- `test/fixtures/rag-retrieval-eval-fixture.ts` — added 10 new cases (fixture now 39 cases total,
  29 filings + 10 episodic): `episodic-nvda-momentum-analog`, `episodic-tsla-riskoff-counterexample`,
  `episodic-owner-coaching-sizing`, `episodic-lesson-sector-concentration`,
  `episodic-msft-value-thesis-analog`, `episodic-amzn-thesis-tag-exact-term`,
  `episodic-asof-guard-analog`, `episodic-googl-counterexample-dissent`,
  `episodic-meta-side-short-analog`, `episodic-jpm-rate-thesis-analog`. Every case has >=1 hard
  negative disjoint from gold and every chunk carries `acceptance_datetime` (required by the
  existing golden-set lint in `rag-retrieval-eval.test.ts`, which still passes unmodified over the
  expanded fixture).
- `test/rag-retrieval-eval.test.ts` —
  - `runFixture` gained an additive `cases?: FixtureCase[]` option (defaults to `RAG_EVAL_FIXTURE`,
    so every pre-existing call site is byte-for-byte unchanged).
  - New `describe("episodic decision-memory eval ...")` block: golden-set-size/hard-negative lint
    over the episodic subset, a recall@3/MRR floor check (looser than the filings baseline by
    design — see inline comment on why), a hard-negative-lint check, and an as-of guard check for
    the new `episodic-asof-guard-analog` case.
  - New `describe("item #822: single-query vs multi-query ...")` block with a dedicated
    `runSingleVsMultiQuery` harness (mirrors `runFixture`'s mock setup but issues N `mocks.query`
    mock responses, one per fan-out variant, then calls `retrieveContextDetailed` once with
    `options.queries` unset and once with it set). Three `it`s: no-regression on the near-miss
    episodic case, no-regression on the exact-term case, and a plumbing check (a synthetic 3-chunk
    fixture case) asserting `mocks.query` is called once per fan-out variant and the fused pool is
    the de-duplicated union across variants — proof the fan-out/`rrfFuse` path actually ran, not a
    single-query short-circuit.
- `STATUS.md` — prepended a 2026-07-06 section.
- `docs/EFFORT-LOG.md` — added one row under "In Progress" for this lane.

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/rag-retrieval-eval.test.ts test/rag-retrieval-regression.test.ts` —
  **36/36 passing** (was 10 + 19 = 29 before this change; +7 new `it`s: 4 episodic eval + 3
  multi-query, plus the 10 new fixture cases flow through the existing filings-suite assertions
  that iterate the whole fixture array).
- Did NOT run full `npm test` / `npm run build` per this lane's stated scope (test/fixture/docs
  only) and the task instructions (focused-test verification only).

## 2026-07-06 follow-up: honesty + discrimination fixes (second commit, same lane)

A post-merge review caught two fixture-quality issues in the change above; both are fixed here,
test/fixture only, no production code, no test-count change (fix 2 extended an existing `it`
rather than adding a new one; fix 3 tightened assertions within an existing `it`).

- **Fix 1 (byte-for-byte claim was false):** the filings baseline/rerank/hybrid/as-of `it`s in
  `test/rag-retrieval-eval.test.ts` called `runFixture({ rerank, hybrid, limit })` with **no**
  `cases` filter, so once the 10 episodic cases existed those tests silently scored the full
  39-case mix instead of the original ~29 filings cases — contradicting this note's "filings
  behavior byte-for-byte unchanged" framing. Measured: full-39-case MRR = **0.919** (not 1.0) vs
  filings-only-29-case MRR = **1.0**. Added `FILINGS_CASES = RAG_EVAL_FIXTURE.filter(c =>
  !c.id.startsWith("episodic-"))` and passed `cases: FILINGS_CASES` to every filings-only `it`
  (baseline, rerank-vs-no-rerank, as-of guard, and all three `item 4: hybrid` `it`s, which had the
  same latent bug via `RAG_EVAL_FIXTURE.findIndex`/`.forEach`) — mirroring the episodic block's own
  `EPISODIC_CASES` pattern. The as-of guard test's index lookup was switched from
  `RAG_EVAL_FIXTURE.findIndex` to `FILINGS_CASES.findIndex` so its index still lines up with the
  filtered `results`/`gold` arrays. **Confirmed: filings baseline MRR is back to 1.0** (recall@3=1.0,
  recall@1=1.0) after the fix.
- **Fix 2 (recall@3 was saturated, not discriminating):** the episodic suite's only quantitative
  `it` asserted `recall3 >= 0.6` and `mrr >= 0.4`, but recall@3 measures 1.0 on this fixture (at
  limit=3 the mock reranker always keeps gold somewhere in the top 3) — so that floor could never
  catch anything short of a catastrophic regression; the only real discriminating signal was MRR.
  Added an explicit `recall1` computation and `expect(recall1).toBeCloseTo(0.4, 5)` — the ACTUAL
  measured value (not a guess): 4 of the 10 episodic cases hit gold at rank 1
  (`episodic-owner-coaching-sizing`, `episodic-lesson-sector-concentration`,
  `episodic-msft-value-thesis-analog`, `episodic-meta-side-short-analog`); the other 6
  (`episodic-nvda-momentum-analog`, `episodic-tsla-riskoff-counterexample`,
  `episodic-amzn-thesis-tag-exact-term`, `episodic-asof-guard-analog`,
  `episodic-googl-counterexample-dissent`, `episodic-jpm-rate-thesis-analog`) have a near-miss hard
  negative outrank gold at rank 1 on the lexical-overlap mock, exactly as designed. Sanity-checked
  that this assertion is load-bearing by temporarily changing the expected value to 0.9 and
  confirming the test fails (`expected 0.4 to be close to 0.9`), then reverted.
- **Fix 3 (brittle mixed-mode assertion):** the multi-query plumbing `it`
  ("the fused candidate pool draws from multiple query lists...") mixed an order-insensitive
  `Set` compare with an order-sensitive `.slice(0, multi.length)` of a hardcoded 3-id array —
  fragile against any harmless reordering of `rrfFuse`'s output. Replaced with
  `expect(new Set(multi).size).toBe(multi.length)` (no duplicate ids — proves de-dup actually ran)
  and `expect(multi.every(id => poolIds.has(id))).toBe(true)` (every returned id is a real pool
  member) — no fixed-array slice.
- Verification: `npx tsc --noEmit` clean; `npx vitest run test/rag-retrieval-eval.test.ts
  test/rag-retrieval-regression.test.ts` — **36/36 passing** (same count as before this follow-up:
  fix 2 extended an existing `it`, fix 3 edited assertions in an existing `it`, no new/removed
  `it`s).

## Follow-ups

- The multi-query suite's assertions are deliberately no-regression + plumbing-only, not a claimed
  recall improvement, because this harness's mock returns the SAME recorded pool for every
  fan-out variant (there's no "different pool per paraphrase" concept in a static fixture) — a real
  improvement claim would need either a richer mock (a per-query-variant pool) or a live-index
  eval, both out of scope here. Documented inline in the test file.
- If a future lane wants to measure multi-query's REAL recall delta (not just prove the plumbing
  runs), the natural next step is a fixture variant where each derived query has its own recorded
  pool with a DIFFERENT subset of the gold/near-miss chunks surfaced at high cosine rank — letting
  `rrfFuse` combine genuinely complementary signal instead of fusing N copies of one list.
- `coach-note`/`lesson` doc types are covered by fixture text shape only (hand-authored to match
  the documented format in `experience-memory.ts`'s module header); no production writer for
  `coach-note`/`lesson` vectors was inspected as part of this task (out of scope — TEST/FIXTURE/
  DOCS ONLY).
