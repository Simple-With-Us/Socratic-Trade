# OpenRouter UI Support

**Summary:** Added OpenRouter to the curated model picker UI to surface the app's existing native OpenRouter support.

**Why:** The backend `src/lib/chat/llm.ts` and API keys already natively route any model prefixed with `openrouter/` to OpenRouter (e.g. `openrouter/google/gemini-1.5-pro`), and support `OPENROUTER_API_KEY`. However, these models were not visible in the dropdown UI, requiring users to manually enter them as custom model IDs and causing a fallback "OpenAI" logo to render.

**Files Changed:**
- `app/console/lib/models.ts` - Added `openrouter` to `ConsoleProviderId` and label/icon metadata.
- `app/ui/model-picker.tsx` - Added `openrouter` to `PickerProviderId` and `PROVIDER_META`.
- `app/console/assistant/models.tsx` - Updated `ModelGroup` type to allow `openrouter` provider string.
- `app/ui/llm-model-catalog.ts` - Added an OpenRouter group with popular Gemini and Llama models to the `CURATED_LLM_MODEL_GROUPS`.

**Verification:**
- `npx tsc --noEmit` passed.
- No backend logic changed; relies entirely on the already-functioning `openrouter/` routing in the LLM transports.
