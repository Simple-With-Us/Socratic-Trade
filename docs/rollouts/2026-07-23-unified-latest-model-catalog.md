# Rollout Note: Unified Latest Model Catalog & Cross-Provider Model Class Aggregation

**Date**: 2026-07-23  
**Agent**: Antigravity (AG)

## Summary
1. **Removed OpenRouter Group**: Retired the standalone `openrouter` group at the bottom of `CURATED_LLM_MODEL_GROUPS`.
2. **Replaced Versioned Models with Latest Identifiers**: Renamed specific versioned models (e.g. `claude-sonnet-5`, `grok-4.3`, `gemini-3.5-flash`) across the model catalog, rotation pool, price table, and reasoning recommendations to `latest` identifiers (`claude-sonnet-latest`, `grok-latest`, `gemini-flash-latest`, etc.).
3. **Promoted Non-OpenRouter Models to Top Vendor Sections**:
   - Added **Meta (`llama-70b-latest`)** under a new Meta provider section up top.
   - Added **DeepSeek R1 (`deepseek-r1-latest`)** under the DeepSeek section up top.
   - Added **GPT-4o (`gpt-4o-latest`)** under the OpenAI section up top.
4. **Canonical Model Class Aggregation**: Enhanced `canonicalModelId` in `src/lib/model-identity.ts` so all historical model names, vendor prefixes, and specific version strings map to their canonical model class ID. This guarantees that historical stats, costs, latency, win rates, and reviewer efficacy metrics combine across direct and OpenRouter sources without resetting or losing data.14. **Live OpenRouter API Verification & Model Slug Resolution**: Audited OpenRouter's live `/api/v1/models` feed to ensure every catalog option resolves to its exact, active model ID on both OpenRouter and Direct Provider API endpoints (e.g. `anthropic/claude-sonnet-5`, `google/gemini-3.6-flash`, `x-ai/grok-4.5`, `openai/gpt-5.6-sol`, `deepseek/deepseek-v4-flash`, `mistralai/mistral-small-2603`).

## Touch Files
- `src/lib/model-identity.ts`
- `app/ui/llm-model-catalog.ts`
- `app/console/lib/models.ts`
- `app/console/assistant/models.tsx`
- `src/lib/db-api-keys.ts`
- `src/lib/llm-provider.ts`
- `src/lib/llm-usage.ts`
- `src/lib/model-rotation.ts`
- `src/lib/model-reasoning-recommendations.ts`
- `src/lib/usage-budget.ts`
- `src/lib/chat/llm.ts`
- `test/openai-model-catalog.test.ts`
- `test/usage-model-merge.test.ts`
- `test/console-models.test.ts`
- `test/llm-provider.test.ts`

## Verification
- `npx tsc --noEmit` — PASSED (0 errors)
- `npm test` — PASSED (453/453 test files, 5,267/5,267 tests)
- `npm run lint` — PASSED
- `npm run build` — PASSED (clean Next.js production build)
