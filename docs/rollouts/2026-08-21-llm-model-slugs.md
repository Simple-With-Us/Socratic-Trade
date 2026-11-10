# 2026-08-21 — Three-column LLM catalog (display / OpenRouter wire / native)

## Context & Objective

Owner asked for one catalog with three columns: display slug (persisted / UI / settings / logs / picker), OpenRouter wire slug (the `model` field on live calls), and provider native slug (direct-provider path, not live traffic today).  Parentheticals such as `(5.4)` are version hints only and must never be stored.

## Changes Made

One canonical table in `src/lib/llm-model-catalog.ts` with `{ displaySlug, openRouterSlug, nativeSlug, provider, label, tier, aliases }`.  Resolvers: `displaySlugFor`, `openRouterSlugFor`, `nativeSlugFor`, `catalogEntryFor`.  OpenRouter HTTP construction uses column 2 even when it differs from the display slug (`gpt-mini-latest` → `openai/gpt-mini-latest`, `gemini-flash-lite-latest` → `google/gemini-3.5-flash-lite`, and so on).  Native / direct stubs use column 3 so a future Anthropic/OpenAI client cannot send a vendor path by accident.

- `src/lib/llm-model-catalog.ts` (new)
- `src/lib/llm-provider.ts`
- `src/lib/model-identity.ts`
- `src/lib/llm-request.ts`
- `src/lib/model-rotation.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/usage-budget.ts`
- `app/ui/llm-model-catalog.ts`
- `app/console/lib/models.ts`
- `ios/SocraticTrade/DeskModels.swift`
- `ios/SocraticTradeTests/DeskModelsTests.swift`
- `test/llm-model-catalog.test.ts` (new)
- `test/llm-provider.test.ts`
- `test/openai-model-catalog.test.ts`
- `test/usage-model-merge.test.ts`
- `test/model-rotation.test.ts`
- `test/model-rotation-live-catalog.test.ts`
- `test/model-identity.test.ts`
- `test/approvals-triage-model.test.ts`
- `test/llm-cache-usage.test.ts`
- `test/usage-budget.test.ts`
- `test/usage-budget-strategy-integration.test.ts`
- `test/console-models.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Decisions & Trade-offs

Owner wire slugs are used as written.  That overrides earlier production rewrites that sent dated ids, tildes (`~anthropic/claude-sonnet-latest`), or hyphen-form `mistral-medium-3-5`.  If OpenRouter 404s on an untilded `*-latest` or on `mistralai/mistral-medium-3.5`, the fix is an owner-table edit, not a silent dated-id fallback.

Aliases kept so existing accounts keep working: `gpt-5.4-mini` → `gpt-mini-latest`, `claude-sonnet-5` / `claude-sonnet-4-6` → `claude-sonnet-latest`, `claude-haiku-4.5` → `claude-haiku-latest`, `claude-opus-5` → `claude-opus-latest`, `claude-fable-5` → `claude-fable-latest`, `grok-4.5` / `grok-4.3` → `grok-latest`, `deepseek-v4-flash` → `deepseek-flash-latest`, `deepseek-v4-pro` → `deepseek-pro-latest`, `deepseek-reasoner` → `deepseek-r1`, `gemini-3.5-flash-lite` → `gemini-flash-lite-latest`, `gemini-3.7-flash` → `gemini-flash-latest`, `mistral-medium-3.5` / `mistral-medium-3-5` → `mistral-medium-latest`.  Settings still store the display slug; we do not rewrite historical DB rows in place.

`gpt-4o-mini` is its own row (not folded into `gpt-mini-latest`).  `grok-build-0.1` stays in the catalog but stays out of the rotation pool.  Models not on the owner list are no longer advertised in the picker.

Congress.Trade: no Cursor CT catalog worktree with a parallel list.  Follow-up, not blocking ST.

## Verification State

Commands run with Node 24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`):

```
npm run lint          # 0 errors (grandfathered warnings only)
npx tsc --noEmit      # clean
npm test              # 7404 passed / 51 skipped; one assertion updated after that run (deepseek-chat → deepseek-flash-latest) and re-run green
npm run build         # Next.js production build succeeded
```

iOS was touched (`DeskModels.swift` Coach options + firstAvailable test).  Local xcodebuild: `** BUILD SUCCEEDED **` (`generic/platform=iOS`, unsigned).

## Next Steps & Blockers

Merged to `main` as #3003 squash `36f0a3c8` at 09:56 UTC (auto-deploy).  Single-shot `verify-deploy-sha.sh` immediately after merge still showed live `e0a4959a` (behind; no restart yet).  Do not hand-trigger a deploy.

1. Watch first production OpenRouter calls after the Coolify swap for 404s on owner wire slugs that differ from yesterday's dated ids.
2. Congress.Trade catalog alignment if that app still ships its own hardcoded list.

## Zero-Code Findings

`~/apps/congress-cursor-ops` has no `llm-model-catalog` / `CURATED_LLM` / `openRouterSlug` surface.  Applying the same mapping there is a separate-repo follow-up.
