# Account-relative risk and Green/Red decision clarity

Date: 2026-07-13
Owner: CODEX
Branch: `codex/account-relative-risk-clarity`
Base: `origin/main@60703dfe`

## Summary

- Replaced the fixed `$500` daily-opening default with one canonical dollar-or-percent mode; new
  policies default to `20%` of current NAV.
- Added migration v26 for only the exact former `$500` product default. Explicit dollar choices,
  including the observed `$1,000` Roth IRA setting, are preserved until changed in Guardrails.
  The post-merge follow-up makes v26 cover every legacy policy store while v27 remains schema-only,
  preserving an intentional fixed `$500` choice made after v26.
- Routed the resolved cap through deterministic policy checks, autonomous and approval-time broker
  minimum bumps, Green/Red prompts, capital posture, approval cards, mobile snapshot data, and AI
  strategy review.
- Persisted app-computed decision-time sizing (`notional`, NAV, `% NAV`, daily cap mode/effective
  dollars, used and remaining budget) and made it authoritative input to Red Team.
- Split Live Thesis into Green Team, deterministic sizing/risk receipts, Red Team, and deterministic
  outcome sections. Replaced “review survived” with explicit verdicts. Non-placed rows now say
  `Buy`/`Sell`/`Short`/`Cover`; past tense is reserved for confirmed placement.
- Fixed the EXE execution contradiction: when an Alpaca dollar order cannot fund one whole share,
  the app clears all bracket fields before submission if it says the native bracket was skipped.

## Why

The observed EXE artifact mixed three different outcomes into one paragraph. The Red Team approved
the thesis and full finalized size, but its prose made a decimal error (`$4` on `$100` is `4%`, not
`0.04%`). A later deterministic Alpaca check blocked the order because LLM-proposed bracket fields
were still attached even after the app said the native whole-share bracket would be skipped. The UI
then compounded that by showing `Bought` beside `Blocked`.

The `$1,000` daily cap did not size the `$4.60` order: the default `5%` per-order NAV ceiling plus
execution headroom produced roughly `$4.76` of opening capacity. The `$1,000` cap was nevertheless
non-sensical context for a roughly `$100` account and encouraged misleading review prose, so daily
budgeting now scales with NAV by default and exposes fixed-dollar scale honestly.

## Decisions

- `20% NAV` is the new daily default: with the existing `5% NAV` per-order default it permits up to
  four full-sized exploratory openings per day while remaining account-relative.
- Do not silently reinterpret explicit dollar settings. Only exact legacy `$500` rows migrate.
- Percentage mode wins if a corrupt persisted shape contains both fields, but web/mobile patch
  normalization preserves the mode the user actually touched and unrelated saves preserve the
  current mode.
- “Red Team approved” means only that the adversarial reviewer approved the thesis/size. It never
  claims policy approval, broker acceptance, or execution.
- `src/lib/broker-protective-stops.ts` stayed out of scope because open PR #1548 owns that file.

## Files

Core risk and decision path:

- `src/lib/policy-caps.ts`
- `src/lib/defaults.ts`
- `src/lib/policy-normalization.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-execution.ts`
- `src/lib/red-team.ts`
- `src/lib/strategy-prompts.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/types.ts`
- `src/lib/db.ts`
- `src/lib/db-profiles.ts`
- `src/lib/mobile-api.ts`

API and UI:

- `app/api/policy/route.ts`
- `app/api/mobile/snapshot/route.ts`
- `app/console/page.tsx`
- `app/console/lib/thesis.ts`
- `app/console/lib/derive.ts`
- `app/console/lib/red-team.ts`
- `app/console/guardrails/page.tsx`
- `app/console/guardrails/field-defs.ts`
- `app/console/components/approval-card.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `ios/SocraticTrade/MobileModels.swift`

Tests:

- `test/policy-caps.test.ts`
- `test/policy-normalization.test.ts`
- `test/policy.test.ts`
- `test/washsale-modes.test.ts`
- `test/antigravity-cheap-wins.test.ts`
- `test/console-live-data-derive.test.ts`
- `test/console-red-team-labels.test.ts`
- `test/console-thesis.test.ts`
- `test/persistence-hardening.test.ts`
- `test/strategy-money-path-f-g.test.ts`

Docs/coordination:

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-07-13-account-relative-risk-and-decision-clarity.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Verification

Using Node `v24.18.0`:

```bash
npm ci
npx vitest run test/policy-caps.test.ts test/policy-normalization.test.ts \
  test/console-live-data-derive.test.ts test/console-red-team-labels.test.ts \
  test/console-thesis.test.ts test/antigravity-cheap-wins.test.ts \
  test/persistence-hardening.test.ts test/strategy-money-path-f-g.test.ts
# 8 files, 63 tests passed

npm run lint
# passed: 0 errors, 452 inherited warnings

npx tsc --noEmit
# first run found one duplicate spread key in the new finalized-sizing object; corrected
# rerun passed

npm test
# first run: 357 files passed, 2 failed; 4,018 passed, 2 failed
# both failures were test fixtures that overrode dollar mode without clearing the new percent default

npx vitest run test/policy.test.ts test/washsale-modes.test.ts
# 2 files, 111 tests passed after fixture correction

npx vitest run test/policy-normalization.test.ts test/strategy-tuning.test.ts \
  test/strategy-tuning-reviews.test.ts test/mobile-api.test.ts test/console-thesis.test.ts
# 5 files, 39 tests passed

npm run build
# passed; inherited Edge-runtime and generated-CSS warnings remain

npm run lint -- --quiet
# passed (final lint rerun: 0 errors)

npx tsc --noEmit
# passed (final typecheck rerun)

npm test
# canonical rerun 1: 356/359 files passed; 4,003 tests passed, 2 failed, 16 skipped
# three unrelated 10-second import/setup hooks timed out under current host contention

npx vitest run test/api-circuit-breaker.test.ts \
  test/connections-health-route.test.ts test/llm-provider.test.ts
# 3 files, 25 tests passed in isolation

npm test
# canonical rerun 2: 357/359 files passed; 4,019 tests passed, 2 failed
# two different unrelated 20-second tests timed out under current host contention

npx vitest run test/dashboard-fill-batching.test.ts test/recoverable-issue.test.ts
# 2 files, 4 tests passed in isolation

npm run build
# final production build passed; inherited middleware and generated-CSS warnings remain

xcrun swiftc -typecheck ios/SocraticTrade/MobileModels.swift
# passed

PATH="/opt/homebrew/opt/node@24/bin:$PATH" bash scripts/land.sh \
  --pr-title "Make daily risk account-relative and clarify Green/Red decisions"
# TypeScript passed
# 359 test files, 4,021 tests passed
# production build passed with the same inherited middleware/CSS warnings
# pushed commit 2cfd7ca8 and opened ready PR #1561
```

No timeout threshold or unrelated test infrastructure was weakened. Required hosted verify,
Playwright smoke, and gitleaks checks passed. PR #1561 auto-merged as `3e105e17`; production health
reported that exact SHA with DB/scheduler/Litestream current and one healthy app container.

The optional post-review autofix workflow failed after reaching its 60-turn cap. It made no change.
The triggering Codex review posted after auto-merge with three non-outdated P2 findings; all three
are tracked in `docs/rollouts/2026-07-13-account-relative-risk-postmerge-review.md`.

## Follow-ups

- The active Roth IRA account's explicit `$1,000` cap is intentionally not auto-mutated. Switch it
  to percent mode in Guardrails after deployment; `20%` means about `$20/day` at `$100 NAV`.
- Existing persisted EXE prose retains its historical `0.04%` error. New decisions carry the
  app-computed percentage and use it in both Red Team and Live Thesis.
- PR #1548 remains the separate owner of post-fill Alpaca broker protective-stop work.
- No production account policy or broker order was changed. The active Roth setting remains explicit
  `$1,000` dollar mode until the owner changes it in Guardrails.
