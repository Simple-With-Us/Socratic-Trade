# 2026-08-19 — `run-scoped-account`: run-scoped code stops reading the console-active account

## Context & Objective
Tranche-1 cluster from the 2026-08-18 full-app review (issue #2880), closing `llm-agent-architecture:llm-02` and siblings.  Code running INSIDE a strategy run re-resolved "the account" by asking which account the console currently has selected, instead of using the account the run is actually trading.  With two accounts connected, the adversarial review of a proposal for account A could be computed against account B's venue capabilities, execution mode and strategy prompt — and switching the active account mid-run silently moved the review underneath it.

## Changes Made
- `src/lib/run-account-scope.ts` (NEW) — `resolveRunAccountScope(userId, policy)`, both parameters required, no active-account default in the run branch.  Returns the account AND that same account's strategy prompt as one value, so venue contract, execution state and prompt can no longer come from three independent resolutions.
- `src/lib/red-team.ts` — `debateProposal` resolves through it instead of `getActiveConnectedAccount` + an unscoped `getStrategyPrompt`.
- `src/lib/retry-red-team.ts` — NOT in the original plan; found by the implementation audit.  `retryProposalRedTeam` read the active account's policy and re-reviewed a run-produced proposal against it.  Now resolves the policy from the proposal's own `accountNumber` and refuses (409) rather than reviewing against a foreign account when the owning account is gone.
- `src/lib/learned-context/store.ts` — `applyApprovedPending`'s strategy-directive branch now reads/writes the prompt scoped to `pending.connectedAccountId`, so an approved directive lands on the account it was queued for.
- `test/run-scoped-account.test.ts` (NEW) — 8 cases, including a two-account fixture where the non-active account is the one under review, and a mid-run active-account switch.

## Decisions & Trade-offs
- Signature shape over discipline: `resolveRunAccountScope` REQUIRES the account rather than defaulting to active, so the wrong thing is a type error rather than a silent fallback.  No `userId = "local"` style defaults were added.
- The console path is byte-identical to today when `policy.connectedAccountId` is undefined; `source` is reported as `"active"`/`"none"` so the distinction is visible rather than implicit.
- One deliberate behavior change: when the policy names an account that no longer exists, resolution returns no account instead of substituting the active one.  A review is refused rather than computed against the wrong money.

## Verification State
Full local gate on this branch, Node 24.19.0:
- `npm run lint` — 0 errors (779 pre-existing grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — 613 files passed / 1 skipped, **7056 tests passed** / 51 skipped, 0 failures.
- `npm run build` — exit 0.
- Failing-first proven: with the three source files stashed, the new test file fails 7 of 7, e.g. `expected 'This eToro account cannot short.  The…' not to match /cannot short/i` — a fabricated veto sourced from a different account.
- An independent skeptic agent re-read the real diff, reverted each of the three fixes one at a time to reproduce the failures itself, and returned SOUND_WITH_NITS.

## Next Steps & Blockers
- Sibling cluster `per-account-visibility` lands separately.
- The implementation produced a full inventory of all 21 `getActiveConnectedAccount` call sites with a keep/fix call on each; three were run-scoped bugs (all fixed here), the rest are console-scoped by design.  That inventory is in the PR body.
- Operational note for the fleet: two agents in sibling worktrees raced on `git stash` (refs/stash is shared repo-wide across worktrees).  Both recovered; no work was lost and the main integration tree stayed clean.  Agents doing failing-first proofs in parallel worktrees should revert-in-place rather than stash.
