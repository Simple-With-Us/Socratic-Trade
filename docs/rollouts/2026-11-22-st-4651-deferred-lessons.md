# ST-4651 deferred post-mortem lessons retry (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep Batch B rank 1 (critic-verified): when the per-decision lesson pass deferred or skipped a case in its closing run — batch cap, over LLM budget, no LLM key, LLM error/empty — the case was already terminal, and `listSocraticDecisionCasesNeedingOutcome` only rescans non-terminal cases, so those lessons were never generated.

## Changes Made
- `src/lib/db-socratic.ts`: new `listSocraticDecisionCasesNeedingLessons` — terminal statuses with a matured outcome (`won/lost/flat/unknown`, at least one `ok` horizon via `json_each`), SQL eligibility before `LIMIT` (valid JSON array with no non-template lesson, plus the `Belief verdict:` prefilter) and a JS fail-safe filter requiring no post-mortem marker and lessons empty or creation-templates-only, so older ineligible rows cannot hide owed cases and coach-promoted lessons are never selected.  No DB migration; reuses the existing lessons/outcome JSON.
- `src/lib/outcome-engine.ts`: retry candidates fill only the `lessonBatchCap` slots left free by newly-closed cases (deduped by id); matured outcomes are never re-graded or rewritten; alpha `raw_fallback` receipts stay scoped to newly-closed cases; existing budget/no-key gates unchanged.
- `test/socratic-db.test.ts`: regression proving the needing-lessons limit applies after twelve older ineligible rows.
- `test/outcome-engine.test.ts`: new ST-4651 test — two blocked cases at cap 1: run 1 writes 1 and skips 1; run 2 (scanned=0) writes the deferred case's lessons with its outcome JSON byte-identical and the settled case's lessons unchanged; run 3 makes no LLM call.

## Decisions & Trade-offs
- Separate needing-lessons query instead of widening the needing-outcome query, so scanned/measured semantics and outcome grading are untouched.
- Selection is state-based (terminal + template-only lessons), which also rescues the pre-existing backlog from every historical skip cause, not only future deferrals.
- Template strings are duplicated as a Set with a pointer comment to `buildSocraticDecisionCase` in `socratic-runtime.ts`; if templates change, update both or old-template cases simply stop being retried (fail-safe: no clobber).
- A permanently unparseable LLM response on the oldest pending case retries once per run inside the cap (receipted each time); the loop continues to other candidates, so starvation is bounded to one slot.

## Verification State
- Writer lane: `npx vitest run test/outcome-engine.test.ts test/outcome-engine-due-jobs.test.ts test/strategy-prompt-safety.test.ts` 29 passed; falsification check (src reverted, test kept) fails at run 2 exactly as expected; `npx tsc --noEmit` clean; eslint on touched files 0 errors.
- Parent re-ran lint/tsc/targeted suites/build on the harvested tree before opening the PR (see PR body); after Seer/Kody identified the fixed-window starvation case, `npx vitest run test/socratic-db.test.ts test/outcome-engine.test.ts test/outcome-engine-due-jobs.test.ts` passed 35 tests, with tsc and eslint clean of errors.  Full serial suite runs in CI verify.

## Next Steps & Blockers
- This PR bases on `main` pre-#5436 and edits regions adjacent to #5436's outcome-engine changes; check overlap at merge and re-run the outcome-engine suites on the merged result.

## Zero-Code Findings
- None.
