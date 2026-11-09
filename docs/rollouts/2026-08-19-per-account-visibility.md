# 2026-08-19 — `per-account-visibility`: screens stop labelling one account's data as every account's

## Context & Objective
Tranche-1 cluster from the 2026-08-18 full-app review (issue #2880).  Multi-account screens rendered the ACTIVE account's data under labels claiming to cover every account.  For a trader running more than one broker account, that is the app telling them whose money a number belongs to — incorrectly.

Each member finding was first classified as one of two opposite problems, because they need opposite fixes: (a) the query is correctly account-scoped but the LABEL overclaims, or (b) the label is right and the query is wrong.  Relabeling a (b) would have hidden it.

## Changes Made
- `app/console/settings/brokers.tsx` — every broker row derives its state from `snapshot.connectedAccountPolicies[account.id]` instead of showing real state only for the currently-loaded account and "Inactive" for all the others (they were mislabelled even while actively trading).  The per-row pending count was dead code that always read 0; it now reads a real per-account count.
- `src/lib/db-proposals.ts` — new `countPendingProposals(accountNumber, userId)`, mirroring `listPendingProposals`'s `scopeAccount` + `userId` scoping exactly.
- `src/lib/dashboard.ts` + `app/dashboard-types.ts` — the snapshot carries `connectedAccountPolicies` and `connectedAccountPendingCounts`, so the settings surface has per-account truth rather than inferring it.
- `app/console/decisions/decisions-list.tsx`, `app/console/decisions/page.tsx` — the decisions index legitimately interleaves every account (its fetch is user-scoped by design), so this is the label side: each row carries an account chip, shown only when more than one account is connected, with an "Unknown account" fallback.
- `src/lib/mobile-api.ts` — `mobileCommandBacklog()` was global across users; it now takes `userId` and filters on it.
- Tests: `test/console-brokers-account-visibility.test.tsx`, `test/dashboard-connected-account-pending-counts.test.ts`, `test/db-proposals-count.test.ts`, `test/mobile-command-backlog-user-scope.test.ts` (new), plus updates to `test/console-decisions-index.test.tsx` and `test/stale-mobile-commands.test.ts`.

## Decisions & Trade-offs
- Correct scoping was preferred over relabeling wherever the data can legitimately be aggregated; the decisions index is the one place where the all-accounts view is intended product behavior, so it got a chip rather than a scope change.
- `deriveStateInfo` was reused rather than reimplemented — it is the same function the top-bar chrome already trusts for this shape.

## Verification State
Full local gate on this branch, Node 24.19.0:
- `npm run lint` — 0 errors (772 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — 617 files passed / 1 skipped, **7071 tests passed** / 51 skipped, 0 failures.
- `npm run build` — exit 0.
- Failing-first proven per source change by reverting just that source file with the new test in place, e.g. `expected … not to contain 'Inactive'` for the broker rows.
- An independent skeptic agent read the real diff, re-reverted `brokers.tsx` itself to reproduce the claimed failure byte-for-byte, and returned SOUND_WITH_NITS.

## Next Steps & Blockers
- Sibling cluster `run-scoped-account` is PR #2888.
- Fleet operational note: two agents in sibling worktrees raced on `git stash` (refs/stash is shared repo-wide across every worktree of the repo).  Both recovered, no work was lost, and the main integration tree stayed clean.  Parallel failing-first proofs should revert-in-place rather than stash.
