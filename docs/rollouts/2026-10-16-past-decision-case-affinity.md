# Past-decision case affinity weighting (2026-10-16)

## Context & Objective

ST-4539 (RAG improvement 1).  The episodic retrieval pass is cross-symbol by design, so a prior on the ticker being decided ranked no better than an unrelated name that merely embedded nearby.  This change lifts same-symbol, same-thesis and same-setup priors without adding a query, an embedding or a DB read.

## Changes Made

- `src/lib/past-decision-cases.ts` (new) scores each already-fetched chunk by additive affinity (symbol 0.30, thesis 0.25, regime 0.15, sector 0.10, dominant factor 0.10), bounded to a `[1, 1.5]` multiplier on an RRF-style positional base.  Boost-only, rank-stable, fail-open.  Off-switch `PAST_DECISION_CASE_AFFINITY=off`.
- `src/lib/experience-memory.ts` runs the re-rank after the usefulness re-rank and before the top-k slice, behind a dynamic import in `try/catch`.
- Review fix (Sentry thread on `experience-memory.ts`): `topAnalogSimilarity` was read from `analogChunks[0]`.  After the re-rank the first card can be a lower-similarity chunk, so the `CLOSEST HISTORICAL ANALOGS` header and the `experience_retrieval` audit payload understated the closest analog.  It is now the maximum similarity (`relevanceScore`, else `score`) across the analogs actually shown.

Files:

- `src/lib/past-decision-cases.ts`
- `src/lib/experience-memory.ts`
- `test/past-decision-cases.test.ts`
- `test/experience-memory.test.ts`
- `docs/rollouts/2026-10-16-past-decision-case-affinity.md`

## Decisions & Trade-offs

- Re-rank only.  Nothing is excluded, demoted or persisted, so the learned-context semantic gate and the human approval queue are untouched.
- `topAnalogSimilarity` is the maximum over the shown analogs, not over every fetched chunk.  The header says "top-analog similarity" for the analogs listed under it, so the number has to describe those.
- `STATUS.md`, `PLAN.md` and `docs/EFFORT-LOG.md` were not edited in the review-sweep commit, to keep the branch free of conflicts with the shared ledgers while `main` moves.  The owner or the next agent should add the ST-4539 row when this merges.

## Verification State

Run in a fresh lane after merging `origin/main` (clean merge, no conflicts), on a Mac under very heavy load, so some timeouts were raised:

- `npx vitest run test/experience-memory.test.ts test/past-decision-cases.test.ts test/strategy-episodic-injection.test.ts`: the retrieval suites passed, including the new `topAnalogSimilarity` assertions (0.90 after the affinity lift).  Three tests timed out on load and never reached an assertion: two in the closed-lot write hook suite (not touched by this change) and `strategy-episodic-injection`.
- `strategy-episodic-injection` rerun alone from a temp copy with the 30 second per-test timeout raised: 1 passed.  The temp copy was deleted and is not in the PR.
- `npx eslint` on the four changed source and test files: clean.
- `npx tsc --noEmit`: no errors in any file this PR touches.  Six errors remain in `src/lib/infisical-settings.ts` and `app/api/admin/server-knobs/route.ts`, caused by the local stand-in for `@jaywedgeworth22/congress-trading-shared` (a v2.7.0 build, since the pinned v2.7.1 could not be built with scripts disabled).  CI builds the pinned version.

## Next Steps & Blockers

- Owner merge (PR is labeled `do-not-automerge`).
- After deploy, confirm a strategy run's `experience_retrieval` audit row reports the closest analog's similarity.
