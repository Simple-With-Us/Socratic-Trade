# 2026-07-16 OpenRouter Model Catalog Integration

## Summary
Added OpenRouter models to the curated model catalog so they can be selected for the Green and Red Team in the Strategy UI. Also verified that the global JSON repair functionality properly applies to all providers, including OpenRouter, removing the need for model-specific or provider-specific fallback branches. Rebuilt `better-sqlite3` native bindings for Node 24 to fix test suite execution.

## Why
The user specified that OpenRouter is the mandatory exclusive provider for LLM calls and wanted to use OpenRouter models for strategy and review tasks. The OpenRouter models were missing from `CURATED_LLM_MODEL_GROUPS`, causing them to not appear in the model selection dropdowns. Additionally, response healing via `jsonrepair` is now centrally applied in `extractJsonPayload`, guaranteeing that JSON parsing is resilient without relying on unwanted fallback API calls.

## Files
- `app/ui/llm-model-catalog.ts`: Added the `openrouter` group with current popular models (GPT-4o, Claude 3.5 Sonnet, Gemini 1.5/2.5, DeepSeek R1, Llama 3.3).

## Verification
- `npm rebuild better-sqlite3` to fix the test environment (Node 24 ABI mismatch).
- `npm test` passed.
- `bash scripts/land.sh` successfully merged changes to `main` and initiated auto-deploy to production.

## Follow-ups
- Monitor the production logs for any OpenRouter specific connection or routing errors now that these models can be actively selected in the UI.
