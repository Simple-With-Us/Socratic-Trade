# 2026-07-20: Use OpenRouter `latest` Aliases for Anthropic Models

**Summary**
Updated the LLM model catalog and rotation configurations to use OpenRouter's `latest` aliases for Anthropic models (`openrouter/~anthropic/claude-sonnet-latest` and `openrouter/~anthropic/claude-haiku-latest`). This ensures we always use the latest models from Anthropic and avoids the "sonnet 3.5 not available" OpenRouter errors.

**Why**
The app was explicitly using `openrouter/anthropic/claude-3.5-sonnet` which caused an error because OpenRouter may not expose that specific model string or it's not the canonical path. Consolidating to `~anthropic/claude-sonnet-latest` fixes the issue and aggregates usage stats properly per model class under the `claude-sonnet-latest` bare name logic, fulfilling the owner's request.

**Files Touched**
- `app/ui/llm-model-catalog.ts`
- `src/lib/model-rotation.ts`
- `test/model-rotation.test.ts`
- `test/approvals-triage-model.test.ts`

**Verification**
- `npm run lint` — green
- `npx tsc --noEmit` — green
- `npm test` — green

**Follow-ups**
None.
