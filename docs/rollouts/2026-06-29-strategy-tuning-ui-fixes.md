# 2026-06-29 - strategy-tuning-ui-fixes

## Summary

- Fixed a backend `TypeError: Cannot convert undefined or null to object` error caused when parsing tuning responses from models like `deepseek-reasoner` (R1) that don't enforce strict schemas.
- Restored the `gpt-5.*` model family (`gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`) back into all select pickers (Strategy View, Strategy Studio, and Admin settings), grouped cleanly under the standard "OpenAI" header.
- Re-established `gpt-5.4-mini` as the default baseline model configuration across `llm-request.ts`, `defaults.ts`, and frontend fallback wrappers.
- Added model selection dropdown for Strategy Review (tuning) in both the Strategy Studio modal and Strategy View panel.
- Made the Strategy Prompt text box taller (`lg:h-[480px]`) on desktop views to fill empty screen real estate.
- Conditionally hid the "Reasoning Effort" policy configuration field when no reasoning-capable model (gpt-5 or o-series) is selected as Green Team, Red Team, or Strategy Review model.
- Disabled operator environment API key fallbacks/failovers by default (setting `LLM_OPERATOR_FALLBACK` default behavior to `off`), ensuring the app fails closed when a user has not entered a key for their chosen model's provider rather than borrowing credentials from the operator's environment.
- Configured a test-environment check in `llmOperatorFallbackEnabled()` to return `true` when `process.env.NODE_ENV === "test"` (unless explicitly overridden), maintaining test suite execution safety.
- Mapped Anthropic (`claude`) models correctly to the `anthropic` provider in `resolveLlmEndpoint` to resolve the user's Anthropic API key, preventing the app from falling through to OpenAI keys for Anthropic models.

## Why

- The user has direct OpenAI project-level access to the new GPT-5 model series (`gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5`). These models are fully real and accessible in their environment, and they are preferred for strategy generation and critique.
- The default model was returned to `gpt-5.4-mini` to use the user's preferred OpenAI model family as the baseline.
- DeepSeek R1 returned incomplete JSON payload templates that omitted `scoringWeights` and/or `riskRules` when not strict-schema constrained. The backend failed to handle these null/undefined payloads safely.
- Users wanted to select which model runs the Strategy Review on demand, rather than being forced to use the default Green Team model.
- The prompt textarea was too short on wide screens, leaving unnecessary blank space in the modal layout.
- "Reasoning Effort" is only supported/permitted on reasoning models (gpt-5 and o-series), so showing it for other model families (like Gemini, Grok, or Mistral) was confusing.
- Users should not borrow environment keys or cross-use keys across providers; disabling operator environment fallbacks ensures strict key-ownership boundary enforcement.

## Files

- `app/api/strategy/tune/route.ts`
- `src/lib/strategy-tuning.ts`
- `app/dashboard-client.tsx`
- `src/lib/llm-request.ts`
- `src/lib/defaults.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/llm-provider.ts`
- `STATUS.md`

## Verification

- `npx tsc --noEmit` passed clean.
- `npm run lint` passed with 0 errors (warnings-only backlog intact).
- `npm test` successfully completed all 1,516 unit tests.
- `npm run build` executed successfully without compilation issues.
