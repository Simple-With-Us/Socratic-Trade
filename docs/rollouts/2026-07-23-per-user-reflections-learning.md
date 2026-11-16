# 2026-07-23: Per-User Reflections & Learning System

## Context & Objective

Owner directive: pool ALL accounts' closed trades for the same user so lessons learned from paper/broker accounts benefit every account (including newly connected ones). An account is an account — paper is not treated differently.

Previously, reflections and learned lessons were per-account. The retrieval filter only returned rows where `r.connectedAccountId === connectedAccountId`. A paper account's lessons never reached a live account's prompt. A second paper account's lessons never reached the first.

## Changes Made

**Core change**: structured lessons (learned_context rows + Pinecone vectors) are now per-user, pooling closed lots across ALL connected accounts. Per-account LLM reflection blobs (`reflection_summary:{accountNumber}`) remain per-account.

### Removed paper-to-live transfer machinery

- Deleted `src/lib/learning-transfer.ts` (103 lines: `evaluatePaperToLiveTransfer`, `validatePaperToLiveThesisTransfers`, related types)
- Removed import and call from `src/lib/post-mortem.ts`
- Changed `transferState` default from gating paper as "candidate" to always "not_applicable" in:
  - `src/lib/learned-context/store.ts` line 116
  - `src/lib/socratic-memory.ts` line 123
  - `src/lib/experience-memory.ts` line 199

### Removed FINRA margin-minimum paper/live distinction

- `src/lib/policy.ts` lines 474-490: removed `context.isLiveExecution === true` check so the $2,000 margin minimum applies uniformly. Updated comments and error message to remove "LIVE" references.

### Per-user lesson pooling

- `src/lib/post-mortem.ts`: Added `poolThesisStats()` and `poolThesisRegimeStats()` to collect and merge stats across all connected accounts (excluding `broker === "test"`). Each pooled row carries `source_accounts` and `environment_breakdown` provenance.
- `writeThesisTrackRecordFacts()` now accepts `PooledThesisStat[]` instead of per-account `ThesisStat[]`. `connectedAccountId` set to `undefined` (NULL) for per-user rows. Lesson text includes `source_accounts` and `environment_breakdown` so the model sees where lessons came from.
- `writeThesisRegimeLessonVectors()` now accepts `PooledThesisRegimeStat[]`. `vector_id` scoped by `userId` not `connectedAccountId`: `reflection-lesson:{userId}:{thesisTag}:{regime}`. `memory_scope` changed from `"account"` to `"user"`. `accession` uses `userId`. `connected_account_id` removed from metadata.

### Regime-conditioned retrieval

- `src/lib/types.ts`: Added `regime`, `thesisTag`, `dominantFactor` optional fields to `LearnedContextRow`
- `src/lib/db.ts`: Migration v59 adds `regime`, `thesis_tag`, `dominant_factor` columns to `learned_context` and `learned_context_pending`
- `src/lib/db-learning.ts`: `RawLearnedContextRow`, `mapLearnedContext`, and `insertLearnedContext` updated to include the new columns
- `src/lib/learned-context/store.ts`: `retrieveLearnedContextDetailed` now applies regime-conditioned scoring: +2 for matching regime, -1 for non-matching, +1 for thesis match. Sorted by score desc (recency as tiebreaker). Off-regime rows labeled `[learned in ${regime} regime]` so the model can discount them. `formatLearnedContextLine` updated to include regime in provenance and off-regime labels.

### Strategy loop wiring

- `src/lib/strategy.ts`: Removed `{ connectedAccountId }` from `retrieveLearnedContextDetailed` call. Now computes current regime via `fetchMacroData` + `determineMarketRegime` and passes it. Collects candidate thesis tags from `getThesisScorecard` for the +1 thesis-match bonus.

### Per-user retrieval filter

- `src/lib/db-learning.ts` `listLearnedContextForDecision`: Updated filter for account-scoped rows to be permissive — NULL `connectedAccountId` (new per-user rows) always pass; non-NULL rows pass when `connectedAccountId` is undefined (per-user call) or when they match the passed-in ID (backward compat).

## Decisions & Trade-offs

- **`connectedAccountId` on learned_context rows**: Set to NULL for per-user-pooled rows. This is cleaner than a sentinel like `"all"` — the row belongs to the user, not an account.
- **Backward compat**: Legacy account-scoped rows with non-NULL `connectedAccountId` still work. They're included when no specific account filter is requested (new per-user behavior) or when the filter matches (old behavior preserved).
- **Per-account LLM reflections stay**: The free-text `reflection_summary:{accountNumber}` blob + signature gate remain per-account since they're LLM free-text, not structured lessons. The structured learned_context rows + Pinecone vectors are what's pooled.
- **Dominant environment preference**: When pooling, if any live lots contributed, the `accountEnvironment` is `"live"`; otherwise `"paper"`.

## Files Touched

```
src/lib/db-learning.ts
src/lib/db.ts
src/lib/experience-memory.ts
src/lib/learned-context/store.ts
src/lib/learning-transfer.ts (deleted)
src/lib/policy.ts
src/lib/post-mortem.ts
src/lib/socratic-memory.ts
src/lib/strategy.ts
src/lib/types.ts
test/learned-context-account-scope.test.ts
test/lesson-vectors.test.ts
```

## Verification

```
npm run lint       # 0 errors, 639 warnings (pre-existing)
npx tsc --noEmit   # passed
npm test           # affected test files pass:
                   #   test/learned-context-account-scope.test.ts: 4/4
                   #   test/lesson-vectors.test.ts: 7/7
npm run build      # passed
```

Full suite has pre-existing better-sqlite3 native module version mismatch (unrelated to these changes). Affected test files all pass clean.

## What to Watch in Production

- Existing per-account lesson vectors with `vector_id: reflection-lesson:{connectedAccountId}:thesis:regime` will NOT be overwritten by new per-user vectors (`reflection-lesson:{userId}:thesis:regime`). They'll coexist in Pinecone until the next reflection pass for each thesis-regime bucket.
- Legacy account-scoped `learned_context` rows with non-NULL `connectedAccountId` remain in the DB. The per-user retrieval filter now includes them, so they'll surface alongside new per-user rows.
- The first reflection run on the new code will pool stats from all accounts, which may take slightly longer if there are many accounts.
- Regime-conditioned retrieval requires `regime` columns on `learned_context` rows. The migration (v59) adds these columns. Existing rows will have NULL regimes and get a 0 conditioning score (neither boosted nor penalized).
