# 2026-07-18 — PR #1735 verify cleanup

## Summary

Merged `origin/main` into `agent/ag-recovery-v48-migration` and fixed the hosted `verify` failures
left on PR #1735.

## Why

The branch canonicalizes OpenRouter telemetry to bare model IDs for usage and benchmark persistence,
but four existing tests still expected provider-qualified served-model attribution such as
`openai/gpt-4.1-mini` and `google/gemini-2.5-flash`. GitHub Actions failed on those assertions.

## Files

- `test/llm-provider-cooldown.test.ts`
- `test/strategy-llm-failover.test.ts`
- `test/persistence-notification.test.ts`
- `test/strategy-money-path-f-g.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification

Passed:

```bash
npm test -- test/llm-provider-cooldown.test.ts test/strategy-llm-failover.test.ts test/persistence-notification.test.ts test/strategy-money-path-f-g.test.ts
```

Result: 4 files passed, 34 tests passed.

## Follow-ups

Let PR #1735 hosted `verify` rerun on the pushed branch and use the full gate as the merge arbiter.

## Round 2 review cleanup

Resolved two fresh Codex review comments on PR #1735:

- Preserved `companyName` display casing in `src/lib/db-securities-import.ts`; ticker normalization
  remains uppercase, but imported names such as `Tesla` no longer pass through the ticker-oriented
  shared `clean()` helper.
- Regenerated `package-lock.json` with `npm install --package-lock-only --ignore-scripts --no-audit
  --no-fund`, restoring the peer dependency entries needed by `@langfuse/otel` and webpack so clean
  installs no longer re-resolve/fail on missing lock entries.

Additional verification:

```bash
npm ci --dry-run --ignore-scripts
npm ci --no-audit --no-fund
npm test -- test/securities-import.test.ts
```

Result: clean-install dry-run passed; focused securities import suite passed, 17/17 tests.

## Round 3 review cleanup

Resolved the OpenRouter proposal attribution card mismatch issue (Codex review comment):
- Exported and integrated `normalizeModelId` in `app/console/components/approval-card.tsx` to strip routing and vendor prefixes before comparing `p.proposedByModel` against configured primary or fallbacks.
- Added comprehensive unit tests in `test/approvals-triage-model.test.ts` to verify prefix stripping works under all standard scenarios.

Additional verification:

```bash
npx vitest run test/approvals-triage-model.test.ts
```

Result: all 4 tests passed, including `normalizeModelId` tests.

## Round 4 — proposed-model attribution P2

### Summary

Separated proposal-attribution identity from telemetry canonicalization. `TradeProposal.proposedByModel`
now retains the exact configured primary/fallback identifier, including the `openrouter/` namespace.

### Why

Usage/benchmark aggregation correctly canonicalizes an OpenRouter route such as
`openrouter/google/gemini-2.5-flash` to a bare model identity. The proposal writer had reused that
telemetry value, but approval-card provenance compares persisted proposal identity directly to
`policy.llmModel` and `policy.llmFallbackModels`. The mismatch falsely labelled a configured primary
as different and concealed a configured fallback.

### Files

- `src/lib/strategy.ts`
- `test/strategy-llm-failover.test.ts`
- `test/strategy-money-path-f-g.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

### Verification

Passed:

```bash
npx tsc --noEmit
npx eslint src/lib/strategy.ts test/strategy-llm-failover.test.ts test/strategy-money-path-f-g.test.ts
npx vitest run test/strategy-llm-failover.test.ts --reporter=dot
npx vitest run test/strategy-money-path-f-g.test.ts -t 'books a broker-paper fill' --reporter=dot
```

The strategy fixture creates a fresh SQLite database and replays migrations 2–52 per test. Under
shared-machine load, its normal explicit 30-second test limits expired during migration setup, so
the two focused verification commands used a temporary local-only 90-second timeout patch; the
committed tests retain their normal 30-second limits. Both regression paths passed: OpenRouter
fallback identity and OpenRouter primary identity respectively.

### Follow-up

Push the branch back to PR #1735 after both review fixes are in place, then reply and resolve the
remaining review thread with the verification evidence.
## PR #1760 review closeout

### Summary

Resolved the four actionable review threads created when the post-#1735 shared-webhook migration
opened as PR #1760.

### Why

- The shared HMAC verifier does not consume `Authorization: Bearer`, but that remains part of the
  documented/legacy receiver contract.
- Proposal attribution deliberately preserves exact configured policy IDs; three usage-budget
  assertions still expected the older canonical bare IDs.
- `update_prs.sh` and the two review JSON dumps were turn-local operator artifacts. The script could
  force-delete another agent's dirty worktree and continue merge/push operations after a failed
  checkout, so none of these files belongs in the product repository.

### Files

- `app/api/webhooks/congress/route.ts`
- `test/congress-trade-events.test.ts`
- `test/usage-budget-strategy-integration.test.ts`
- `update_prs.sh` (removed)
- `all_threads.json` (removed)
- `threads.json` (removed)
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-18-ag-recovery-v48-verify-cleanup.md`

### Verification

The first Node 24 run was invalid because `npm ci` had compiled `better-sqlite3` under Node 26
(`NODE_MODULE_VERSION 147` instead of Node 24's 137). Rebuilt the native module with Node 24, then
ran:

```bash
node ./node_modules/vitest/vitest.mjs run test/congress-trade-events.test.ts
node ./node_modules/vitest/vitest.mjs run test/usage-budget-strategy-integration.test.ts test/strategy-llm-failover.test.ts test/strategy-money-path-f-g.test.ts
```

Result: 4 files passed, 36 tests passed.

After merging the pre-#1760 `origin/main`, the required serialized Node 24 gate passed:

```bash
npm run lint
bash scripts/land.sh --pr-title "fix: close PR 1760 review findings"
```

`land.sh` passed `npx tsc --noEmit`, 412 Vitest files / 4,837 tests, and `npm run build`,
then pushed ready PR #1761. PR #1760 auto-merged as `b2f22ccf` during that gate, so the #1761
branch was merged again with the exact new main. Conflicts in the webhook route, webhook tests,
and this rollout note were resolved in favor of the reviewed fixes; the three unsafe artifacts
introduced by the squash merge were deleted again.

### Follow-ups

All four original threads have concrete replies and are resolved. Wait for #1761's self-hosted
checks, merge it through the protected workflow, and verify the exact auto-deployed production SHA.
Production's release/core was current before this change, but Voyage was a critical dependency
failure and kept `/api/health` at HTTP 503; do not call production fully healthy until that probe
recovers or is separately remediated.
