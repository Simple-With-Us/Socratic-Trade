# Rollout: Moonshot AI / Kimi Provider Integration & Model Catalog Standardization

**Date**: 2026-07-24  
**Author**: ANTIGRAVITY  
**PR**: Pending

## Context & Objective

Integrate Moonshot AI / Kimi (`moonshot` / `kimi`) as a first-class LLM provider key option across the entire system (Settings API keys, provider dispatch, chat, model identity, usage metrics, and catalog UI) and align OpenRouter and native model slug mappings to match the user's catalog specification table.

## Changes Made

1. **`src/lib/db-api-keys.ts`**:
   - Added `moonshot` and `kimi` service mappings to `API_KEY_ENV_MAP` (`MOONSHOT_API_KEY`).
   - Added service aliases (`moonshot`, `moonshot_api_key`, `moonshotai`, `moonshotai_api_key`, `kimi`, `kimi_api_key`).
   - Added `moonshot` to `resolveLlmCredential`, `LLM_PROVIDER_SERVICES`, `LOCAL_ENV_MIGRATION_SERVICES`, and `ALL_SERVICE_ENV_VARS` (`MOONSHOT_API_KEY`, `KIMI_API_KEY`, `MOONSHOTAI_API_KEY`).

2. **`src/lib/llm-provider.ts`**:
   - Added `"moonshot"` to `LlmModelFamily` and `LlmEndpoint`.
   - Updated `llmModelFamily()` to check `/(kimi|moonshot)/i`.
   - Updated `nativeModelSlugForProvider()` to return `kimi-latest` for Moonshot AI and aligned all native provider model slugs to latest provider tags.
   - Updated `normalizeOpenRouterModelId()` to map `kimi`/`moonshot` to `moonshotai/kimi-latest` and normalized OpenRouter wire IDs.
   - Added native endpoint resolution for `moonshot` (`https://api.moonshot.cn/v1/chat/completions`).

3. **`src/lib/chat/llm.ts`**:
   - Added `"moonshot"` to `ChatProvider`.
   - Updated `chatProviderForModel()` and `openAiCompatChatUrl()`.

4. **`src/lib/llm-errors.ts`**:
   - Added `"Moonshot AI (Kimi)"` to `LlmProviderName`, `providerLabel()`, and `providerFromText()`.

5. **`src/lib/model-identity.ts`**:
   - Added `moonshotai/` prefix stripping and `kimi-latest` family canonicalization.

6. **`src/lib/llm-usage.ts`**:
   - Added token cost entries for `kimi-latest` ($0.30 / $1.20 per 1M tokens).

7. **`app/console/lib/models.ts` & `app/ui/llm-model-catalog.ts`**:
   - Added `"moonshot"` to `ConsoleProviderId`, `PickerProviderId`, `PROVIDER_LABEL`, `PROVIDER_META`, `MODEL_DISPLAY_NAME`, and `CURATED_LLM_MODEL_GROUPS`.

8. **`app/api/keys/route.ts` & `app/api/chat/providers/route.ts`**:
   - Added `moonshot` to `API_KEY_CATALOG` in Settings API key management and to `/api/chat/providers`.

9. **`test/llm-provider.test.ts`**:
   - Added unit test for native Moonshot endpoint resolution.

## Verification State

- Executed `export PATH="/opt/homebrew/opt/node@24/bin:$PATH" && npx vitest run test/llm-provider.test.ts`.
- Verified all 5 tests pass cleanly.
