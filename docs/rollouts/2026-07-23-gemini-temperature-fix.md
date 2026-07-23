# Gemini Reasoning Temperature Fix

**Summary:** Fixed an issue where Gemini 3.1 Pro Preview (and other thinking-enabled Gemini models) would fail when used for the Red Team (or any other scenario with a non-zero temperature) due to passing `temperature` when thinking is enabled.

**Why:** Gemini reasoning models, like Anthropic, OpenAI, Mistral, and DeepSeek reasoning models, reject a custom `temperature` parameter when their thinking/reasoning mode is enabled. The Red Team reviewer operates at `temperature: 0.7` by default. The LLM request shaper (`withLlmRequestBounds`) correctly omitted `temperature` for all other provider families when reasoning was enabled, but missed the Gemini branch, causing it to fall through and send the temperature, triggering a provider error. 

**Files:**
- `src/lib/llm-request.ts`

**Verification:**
- `npx tsc --noEmit` passed.
- `npm test` (failures noted are pre-existing Vitest mock issues related to `src/lib/db` splitting, as noted in AGENTS.md).

**Follow-ups:**
- None.
