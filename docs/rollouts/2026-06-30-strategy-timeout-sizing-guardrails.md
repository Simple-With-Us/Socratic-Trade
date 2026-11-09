# 2026-06-30 - Strategy timeout and sizing guardrails

## Summary

Added guardrails for two production-visible issues:

- Green Team proposal requests using `gpt-5.5` with high reasoning can time out
  on the interactive strategy path.
- Opening proposals could sit on the hard per-order policy cap, such as a `$5`
  AAPL buy against a `$4.99` Roth IRA cap, and then fail at approval.

## Why

The diagnosed timeout run started at `2026-06-30T14:34:33.577Z` and failed at
`2026-06-30T14:35:47.124Z`, about 73.5s wall-clock. The LLM request itself hit
the existing 60s timeout. Extending the wait would hold the strategy lock longer
and allow more hidden reasoning-token spend on an interactive path, so the safer
default is to keep the timeout bounded and avoid the slowest model/effort combo.

The AAPL/Roth issue is a proposal-vs-policy headroom problem. The policy gate was
right to block the approval, but proposals should not be generated or staged
right at the maximum where rounding, price refresh, or broker review can tip the
order over the cap.

## Changes

- `gpt-5.5` + high reasoning is rejected by the policy route for interactive
  strategy settings.
- Stale stored `gpt-5.5` + high reasoning configs are runtime-clamped to medium
  effort for Green/Red strategy request bodies.
- The strategy prompt now sends both `limits.maxOrderNotional` and
  `limits.preferredMaxOrderNotional`; the preferred cap reserves 5% headroom.
- Deterministic opening sizing caps LLM-advised and fallback sizes to the
  preferred per-order policy cap without shrinking unrelated symbol/sector caps.
- The policy gate blocks opening orders that leave less than 5% headroom below
  the effective per-order cap, returning a concrete reduce-to amount.
- Assistant/chat draft promotion now returns `409 POLICY_BLOCKED` instead of
  inserting a pending proposal when the preview decision is already blocked.

## Files

- `src/lib/llm-request.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `app/api/policy/route.ts`
- `app/api/proposals/from-draft/route.ts`
- `test/llm-request.test.ts`
- `test/policy.test.ts`
- `test/conviction-size-cap.test.ts`
- `test/policy-notification-events.test.ts`
- `test/chat-draft-policy.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-06-30-strategy-timeout-sizing-guardrails.md`

## Verification

- `npm ci` - installed this clean worktree's dependencies.
- `npx vitest run test/llm-request.test.ts test/policy.test.ts test/conviction-size-cap.test.ts test/policy-notification-events.test.ts test/chat-draft-policy.test.ts` - 68 tests pass.
- `npm run lint` - pass with 0 errors and 254 existing warnings.
- `npx tsc --noEmit` - pass.
- `npm test` - 166 files / 1582 tests pass.
- `npm run build` - pass.
- Note: after merging the latest `origin/main` production-build hotfix, the first
  webpack build retry failed with host `ENOSPC` while writing `.next/cache`.
  Deleted this worktree's generated `.next` only, reran `npm run build`, and it
  passed.

## Review follow-up (2026-06-30, Claude)

Addressed the three Codex P2 review threads on PR #278:

- **Clamp high reasoning on the required Red Team debate** — `red-team.ts` built its
  debate request with `policy.llmReasoningEffort` directly, bypassing the
  `interactiveStrategyReasoningEffort` clamp the Green/Bear steps use. A stored
  `gpt-5.5`/`high` config could therefore still send `high` reasoning on the debate
  call and hit the exact timeout/run-lock this PR exists to prevent. Now routes the
  debate's `reasoningEffort` through the same clamp (`src/lib/red-team.ts`).
- **Apply the per-order/headroom cap to bracket-minimum raises** — `applyDeterministicSizing`
  raised one-share Alpaca brackets against the unbuffered `openingCapacity.cap`, so a
  raise could exceed the 5% headroom cap and the later policy review rejected the
  proposal instead of skipping the broker bracket. `effectiveOpeningCap` now starts at
  the buffered `openingSizingCap` (`src/lib/strategy.ts`).
- **Reserve the marketable-limit buffer before sizing** — when `marketableLimitEntries`
  is enabled, the dollar market order is later converted to a whole-share limit priced
  through the quote (`ask × (1 + bufferBps)`); that could push realized notional past
  the cap computed pre-conversion. Sizing now divides the cap by the marketable-limit
  buffer factor (only when the flag is on, so dollar-routed sizing is unchanged).

Verification: `npx tsc --noEmit` pass; targeted Vitest (antigravity-cheap-wins,
llm-request, conviction-size-cap, policy, chat-draft-policy, policy-notification-events)
6 files / 78 tests pass. Full `verify` CI (tsc → test → build) gates the merge.

### Round 2 (Codex re-review)

- **Clamp reasoning on pending-proposal revalidation too** — `revalidatePendingProposals`
  (`proposal-revalidation.ts`) runs first in a strategy run while the per-user lock is held and
  still built its request with raw `policy.llmReasoningEffort`, leaving the timeout/lock guardrail
  bypassed for that call. Now routed through `interactiveStrategyReasoningEffort`, matching
  Green/Bear/debate. (`npx tsc --noEmit` pass; `llm-request` + `proposal-revalidation` tests pass.)
- **Wide-spread marketable-limit headroom (acknowledged, not further changed):** the buffer factor
  reserves `bufferBps`; for names whose ask sits materially above the reference price the converted
  `qty × limitPrice` can still exceed the preferred headroom. This is a strict improvement over the
  prior behavior and the residual only causes a *conservative* block (never an over-cap order), on
  top of the existing 5% `OPENING_ORDER_HEADROOM`. Exact ask/reference-ratio accounting is deferred
  to avoid over-shrinking wide-spread sizes.

### Round 3 (Codex re-review — chat-draft commit path)

The commit-time policy rejection this PR added to `app/api/proposals/from-draft/route.ts` had two
regressions (both fixed):

- **Fail-closed on preview-only staleness** — the commit preview runs WITHOUT a market scan, so the
  staleness gate (which treats a missing quote/scan timestamp as stale) blocked *every* opening chat
  draft when `maxQuoteAgeSec`/`maxFundamentalsAgeSec` were enabled. The authoritative gate re-runs at
  approve time against fresh data, so the pre-commit reject now fires only for real, non-staleness
  reasons (`staleness_gate:`-prefixed reasons are excluded); otherwise the draft is staged and the
  approval-time gate decides on live data.
- **Idempotency broken** — the rejection ran before the `chat:${draft_id}` dedupe, so a normal retry
  of an already-staged draft could return `409` instead of the existing `proposalId`. The dedupe
  lookup now runs first (returns the existing row with `200 deduped`) before any rejection.

Verification: `npx tsc --noEmit` pass; `chat-draft-policy` 3 tests pass (added a staleness-only
"stages (201)" case and a "retry returns 200 deduped even when now-blocked" case).

### Round 4 (Codex re-review)

- **Dry-run preview must apply the same staleness exemption.** The assistant only shows the Stage
  button when the `dryRun:true` decision is approved; the round-3 exemption ran *after* the dry-run
  return, so a staleness-only preview still came back `approved:false` and the UI hid Stage even though
  the commit path would accept it. Both paths now share one `effectiveDecision` (staleness-only →
  `approved:true`), so dry-run and commit agree. (Added a dry-run regression test.)
- **Short-specific cap in the headroom gate.** For a short whose binding cap is `maxShortOrderNotional`
  (generic/NAV cap unset or higher), the execution-buffer gate computed the buffer from the generic cap
  only, so a short at 100% of the short cap kept no buffer. The headroom now folds in
  `maxShortOrderNotional` for shorts (without duplicating the hard short-cap check), and the message
  labels it "max short order limit".

Verification: `npx tsc --noEmit` pass; `policy` + `chat-draft-policy` (52 + 4 tests) pass.

### Round 5 (Codex re-review)

- **Deterministic sizing now includes the short-specific cap.** `applyDeterministicSizing` now folds
  `maxShortOrderNotional` into both the risk-cap candidate set and the 5% headroom cap, so a short
  near the short cap is reduced to a stageable size instead of being blocked later by policy review.
- **Chat draft previews resolve wash-sale locks by user.** The chat draft policy preview now passes
  `userId` into `evaluateTradeProposal`, so the authoritative wash-sale resolver can block a draft
  before staging instead of waiting until approval.
- Added regression coverage for both paths.

## Follow-ups

- Consider a per-context timeout knob only if a future queued/background strategy
  path needs deeper models; do not extend the interactive run timeout by default.
- Dollar-amount chat orders remain a separate pending feature. This change
  prevents blocked share-quantity drafts from being staged, but it does not add
  "buy `$X` of SYMBOL" parsing.
