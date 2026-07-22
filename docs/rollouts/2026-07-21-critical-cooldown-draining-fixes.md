# 2026-07-21 - Critical cooldown and draining-account fixes

## Summary

Scheduled critical-bug automation found and fixed two high-impact correctness bugs in PR #1845:

- `planLlmProviderAttempts` no longer returns an empty attempt list when every LLM lane is in a
  billing cooldown.
- Scheduler draining-account cleanup now treats every broker-live order state as still live before
  deciding an account can be purged.

The 2026-07-21 review closeout also restores the three living-doc updates this rollout already
listed and records the current commit-identity audit. The product-code fixes themselves did not
need further changes.

## Why

The cooldown module's design says a non-empty failover chain is never refused. The implementation
filtered out billing cooldowns during the "all lanes cooling" path, so an all-billing failure window
returned `[]` and skipped every Green/Red attempt until the TTL expired, even if the owner had
already refilled credits or fixed billing.

Account deletion is staged through a draining flag so the scheduler can cancel broker-side work
before deleting local account records. That cleanup only counted literal `open` and
`partially_filled` states; Alpaca/Robinhood/Tradier can report still-live orders as
`accepted`, `pending_new`, `queued`, `confirmed`, `pending`, or `pending_cancel`. Purging while one
of those orders was live could leave an unmanaged broker order after local proposal/fill/stop state
was deleted.

## Files

- `src/lib/llm-provider-cooldown.ts`
- `src/lib/scheduler.ts`
- `test/llm-provider-cooldown.test.ts`
- `test/scheduler-draining.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-1-autonomy-loop.md`
- `docs/phase-2-correctness.md`
- `docs/rollouts/2026-07-21-critical-cooldown-draining-fixes.md`

## Verification

### Review closeout

- `git log --format='%h %an <%ae> %s' origin/main..HEAD` - every commit unique to the current PR
  head uses `12656028+jaywedgeworth22@users.noreply.github.com`.
- `git show b0ae671` - the reported transient commit is not resolvable or reachable in the current
  repository. A generic GitHub/OpenAI noreply identity would not expose the owner's private email in
  any case; no history rewrite was performed without a reachable non-noreply violation.
- First concurrent focused rerun: 9/10 tests passed and one `beforeEach` hook timed out at 60s while
  multiple other worktree compilers/tests were contending for the host; no assertion failed.
- Isolated retry: `npx vitest run test/llm-provider-cooldown.test.ts test/scheduler-draining.test.ts`
  passed (2 files, 10 tests).
- `npx eslint src/lib/llm-provider-cooldown.ts src/lib/scheduler.ts test/llm-provider-cooldown.test.ts test/scheduler-draining.test.ts`
  passed with no errors or warnings.
- `npx tsc --noEmit` passed.

### Original implementation

- Initial `npx vitest run test/llm-provider-cooldown.test.ts test/scheduler-draining.test.ts`
  failed before tests loaded because `node_modules` was absent and `vitest/config` could not be
  resolved.
- `npm install` (environment setup; reverted the one-line `package-lock.json` metadata noise it
  produced).
- `npx vitest run test/llm-provider-cooldown.test.ts test/scheduler-draining.test.ts` - passed
  (2 files, 10 tests).
- `npm run lint` - passed.
- `npx tsc --noEmit` - passed.
- `npm test` - passed (421 files, 4902 tests).
- `npm run build` - passed; emitted existing Next/Sentry Edge Runtime warning and middleware
  deprecation warning.

## Follow-ups

- Hold this local closeout behind PR #1857. Once released, push it to PR #1845's existing head,
  resolve the two review threads, obtain fresh required checks, merge, and verify the exact
  auto-deployed production SHA.
- Automation memory updated with the two PR #1845 bug records.
