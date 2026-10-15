# 2026-10-15 check-pin token order

## Context & Objective

PR #4698 was DIRTY against `main`, and `check-pin` failed.  The same failure showed up on the other pull requests that ran in the same burst (PRs #4697, #4701, and #4713).  Each log is `API rate limit exceeded for user ID 12656028` while reading Congress.Trade `VENDOR-PROVENANCE.md`, then the job reports that `GH_PACKAGES_TOKEN` is missing.  The goal is a merge of `main` and a pin check that does not share one user rate limit across every pull request.

## Changes Made

- Merged `origin/main` at `df7e6d10` with a merge commit.  No conflicts.
- `check-pin` now tries `GITHUB_TOKEN`, then `GH_TOKEN`, then `GH_PACKAGES_TOKEN`.  Congress.Trade is public, so the Actions installation token can read the vendor tree.  The user PAT is only the fallback.
- A rate-limit response stops retrying that token and tries the next one.  If every token is rate limited, the error says so.  It does not say the secret is missing.
- A real unreadable private tree still asks for `GH_PACKAGES_TOKEN`.

Touched files:

- `scripts/check-shared-package-pin.mjs`
- `test/shared-package-pin-check.test.ts`
- `.github/workflows/shared-package-pin-check.yml`
- `docs/phase-11-multi-user.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-10-15-check-pin-token-order.md`

## Decisions & Trade-offs

The shared cause is token order, not a version skew.  ST, UM, and the lock SHA already matched in the failing log.  Preferring the PAT made every concurrent `check-pin` job spend user 12656028's budget.  Money-path pull requests also call that PAT from the auto-merge disable jobs, which makes the burst worse.  Those jobs were left alone.  This change only stops `check-pin` from depending on that budget.

Price and market-data history is not pruned.

## Verification State

```
npx vitest run test/shared-package-pin-check.test.ts
```

1 file, 7 tests, all passed.

```
npx tsc --noEmit
```

Exit 0.

`npm test` and `npm run build` were not re-run for this CI-only diff.  The hosted `verify` job on the pull request is the full gate.  The previous head's hosted `verify` was green before this merge.

## Next Steps & Blockers

Keep PR #4698 ready with `do-not-automerge`.  Do not enable auto-merge.  Jay squash-merges.  No review threads were open on the pull request at the start of this pass.

## Zero-Code Findings

PRs #4697, #4698, #4701, and #4713 failed `check-pin` between 07:38 and 07:41 UTC on 2026-10-15 with the same user-id rate limit.  Later runs of the same workflow succeeded once that window passed.  The pins themselves were already aligned (`v2.7.1`, lock `5084afb3`).
