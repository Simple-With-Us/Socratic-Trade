# 2026-08-04 — Paper-account learning parity (Learning Review + decision lessons)

## Context & Objective

Owner: do not discriminate against trades from paper accounts for learning review
unless there is a definite paper-exclusive cause for the analyzed outcome. Paper
accounts are used deliberately to compare which models are better for which tasks.

## Changes Made

1. **`src/lib/learning-review.ts`**
   - New exported `PAPER_ACCOUNT_LEARNING_PARITY_RULE` woven into the Learning Review
     Board system prompt: paper/sandbox evidence is first-class; only discount when
     a definite paper-exclusive mechanism caused the outcome (and state that mechanism).
   - Review items now carry `accountEnvironment` and `learningScope` so the reviewer
     can apply the exception carefully instead of guessing from free text.
   - Fingerprint includes environment/scope so a re-review runs once after this lands.

2. **`src/lib/outcome-engine.ts`**
   - Per-decision post-mortem lessons write as **portfolio-scoped** (not account-scoped)
     with `accountEnvironment` provenance only. Paper model/task lessons therefore
     inform every account's decision prompt, matching the 2026-07-23 "an account is an
     account" pooling direction and the owner's model-comparison intent.
   - Missing connected-account row no longer drops the lesson; it audits and still writes.

3. **`src/lib/strategy-prompts.ts`**
   - `learnedContext` guidance: environment=paper facts are first-class for model/task
     fitness; discount only when the lesson itself cites a paper-exclusive mechanism.

## Decisions & Trade-offs

- Explicit account-scoped ingest (callers that pass `connectedAccountId`) is unchanged —
  only the decision-lesson path defaulted to portfolio scope.
- Paper-exclusive exceptions remain possible; they must be *definite* and named, not a
  generic "it's paper so ignore it."

## Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx vitest run --run test/learning-review.test.ts test/outcome-engine.test.ts
```

## Next Steps & Blockers

- Land via `scripts/land.sh`; auto-deploy on merge.
- Optional follow-up: backfill existing account-scoped `decision_lesson:*` rows to
  portfolio scope if the owner wants historical paper lessons to surface on live
  accounts without waiting for new maturities.
