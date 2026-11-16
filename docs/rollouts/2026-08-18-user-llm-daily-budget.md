# 2026-08-18 — Per-user LLM daily budget in Settings + iOS (not Infisical)

## Context & Objective

The daily LLM + RAG ceiling already existed as account `policy.tuning` plus retired Infisical/env `TRIGGER_LLM_DAILY_*`, but the Settings UI was lost in the redesign and iOS had no editor.  Owner asked for a **per-user** cap in console/iOS, **enforced fail-closed** when set, and other per-user knobs moved off Infisical.  System secrets stay in Infisical.  No Stripe / no IAP.

## Changes Made

The live cap is `user_settings.llm_daily_budget`.  Resolution order: user setting → legacy `policy.tuning.llmDailyTokenBudget` / `llmDailyCostBudgetUsd` → retired env `TRIGGER_LLM_DAILY_*`.  An explicit `0` means no cap (opts out of lower tiers).  Unset everywhere = default OFF.

When a cap is set and today's usage ledger cannot be read, `checkLlmDailyBudget` returns `{ ok: false, reason: "ledger_unavailable" }`.  Strategy skips LLM, chat returns 429, RAG returns `[]`, and `assertWithinLlmBudget` throws.  Reservation DB errors already fail-closed.

Per-user RAG rolling-window knobs (`RAG_RUN_BUDGET_ENABLED` / `CEILING` / `WINDOW_MS`) resolve from Data Sources settings first, then env/default.

- `src/lib/llm-budget.ts` — user-settings store, tier resolution, ledger fail-closed
- `app/api/settings/llm-budget/route.ts` — GET/PATCH
- `app/console/settings/llm-budget.tsx` + `app/console/settings/lib.ts` + `app/console/settings/page.tsx`
- `app/settings-search.ts` — palette hits → `#llm-budget`
- `src/lib/types.ts` — tuning fields marked legacy
- `src/lib/source-settings-catalog.ts` — `RAG_RUN_BUDGET_*`
- `src/lib/rag/run-budget.ts` + `src/lib/vector-db.ts` — resolve those knobs per `userId`
- `ios/SocraticTrade/HomeView.swift` — Daily LLM Budget section
- `ios/SocraticTrade/DeskModels.swift` + `MobileAPIClient.swift` + `MobileStore.swift`
- `ios/SocraticTrade/DataSourcesSettings.swift` — number knobs (RAG ceiling/window)
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `.env.example` — per-user caps belong in Settings, not Infisical
- `test/llm-budget-enforcement.test.ts` + `test/llm-budget-route.test.ts`
- `test/settings-search-index.test.ts` + `test/source-settings.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, `docs/phase-11-multi-user.md`

## Decisions & Trade-offs

- Did **not** move system secrets: `ENCRYPTION_KEY`, `AUTH_SECRET`, broker host, `OPS_DIAGNOSTIC_TOKEN`.
- Operator-global knobs stay Infisical/env: `LLM_SPEND_CEILING` (monthly, all users), `GEMINI_RPM_LIMIT`.
- Legacy account tuning still binds when the user setting is unset, so existing policy rows keep working.
- `TRIGGER_LLM_DAILY_*` remains a retired operator default only — do not put a per-user cap back in Infisical.
- iOS UI lives in `HomeView.swift` so `project.yml`'s folder source + the committed pbxproj stay in sync without a hand-edit of `.pbxproj`.
- Owner ruling: no coordinator/owner asides in console or iOS copy.  Labels are product language ("Daily AI Budget").  Infisical / remotes / surfaces stay in the PR and this note only.
- No Stripe, no IAP, no selling ST.
- Did not touch reserved PRs #2792 / #2798 / #2800 / #2794.

## Verification State

```bash
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npx vitest run test/llm-budget-enforcement.test.ts \
  test/llm-budget-route.test.ts \
  test/settings-search-index.test.ts \
  test/source-settings.test.ts
# 4 files, 44 passed
npm run build         # Next.js 16.3.1 webpack; /api/settings/llm-budget listed
```

Full `npm test` on this Linux cloud VM hit unrelated network/timeout flakes (SEC/Alpaca 404s, 30s strategy-scope hangs) and was stopped.  CI `verify` on the PR is the full-suite authority.

iOS was not compiled here (`xcodebuild` is not available).  Swift decode coverage is `DeskModelsTests.testLlmBudgetResponseDecodesNullCaps`.

## Next Steps & Blockers

- Merged as #2821 `972e3763`.  iOS `xcodebuild` passed on the PR Mac runner.
- Optional: set a cap in production Settings and confirm strategy/chat pause when today's ledger is at/over it.
- Optional later: drop the retired env fallback once no deployment still relies on `TRIGGER_LLM_DAILY_*`.

## Zero-Code Findings

None — this is an implementation change.
