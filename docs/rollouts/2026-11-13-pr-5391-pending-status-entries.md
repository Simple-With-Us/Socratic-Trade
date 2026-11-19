# 2026-11-13 — pending STATUS/PLAN cleanup after PR #5391

## Context & Objective

#5391 recorded several STATUS and PLAN entries as landed while their source PRs were still open.  This follow-up marks remaining unmerged work as proposed and pending so `main` is not described as already carrying it.

## Changes Made

After merging current `main` (`5084876b`) to resolve the conflict, Pending wording is kept only for source PRs that are still open.  `gh pr view` on 2026-11-16 showed #5158, #5142, #5155, #5172, and #5157 merged, and #5175 still open.

- STATUS.md: dropped the Pending lines for ST-4622 (#5158), ST-4611 (#5142), ST-4618 (#5155), ST-4631 (#5172), and ST-2797 (#5157), leaving those entries matching `main`.  Restored the ST-4631 `**Next.**` line to `main`'s wording.  Kept the ST-4633 (#5175) Pending line and the `**Next.**` line that says [#5175](https://github.com/Simple-With-Us/Socratic-Trade/pull/5175) is open against main and must not be merged or deployed yet.
- PLAN.md: kept the ST-4633 (#5175) pending marker at the top.  Dropped the ST-4631 (#5172) pending marker and restored `main`'s unmarked ST-4631 entry after ST-4605.
- `docs/rollouts/2026-11-13-pr-5391-pending-status-entries.md`

## Decisions & Trade-offs

#5391's wording was corrected in this follow-up rather than rewritten on that already-merged PR.  Entries for PRs that have since merged are left matching `main` (no Pending line).  Only ST-4633 / #5175 stays pending.

## Verification State

- 2026-11-16: `gh pr view <n> --json state,mergedAt` — #5158 merged 2026-11-15T10:30:51Z, #5142 merged 2026-11-15T10:25:15Z, #5155 merged 2026-11-15T10:28:49Z, #5172 merged 2026-11-15T10:30:51Z, #5157 merged 2026-11-15T10:55:12Z, #5175 still open (`mergedAt` null).
- `git merge origin/main` at `5084876b` completed locally; GitHub ignores the STATUS/PLAN `merge=union` attribute, so this merge commit is what makes the PR mergeable against `main`.
- `app/api/market/flatfile/route.ts` on `main` now has `hasFlatfileSession` and `enforceRateLimit` from #5172.

## Next Steps & Blockers

When #5175 merges, drop its STATUS Pending line and the PLAN pending marker.  Do not merge or deploy #5175 from this follow-up.

## Zero-Code Findings

Docs only: no code, tests or build affected.  #5172 has landed on `main`, so the earlier finding that `app/api/market/flatfile/route.ts` had no handler session guard or rate limit is no longer true.
