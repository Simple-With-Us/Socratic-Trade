# 2026-07-17 — Codex autofix on PR #1705: OpenRouter chat-prefix + Tradier bracket ordering

## Summary

Two P1 Codex review findings on PR #1705 (`agent/openrouter-metadata-tracking`) fixed.

## What changed

### P1 — Strip OpenRouter routing prefix before chat requests

`llmForModel` in `src/lib/chat/llm.ts` now strips the `openrouter/` prefix from the model ID
before passing it to the OpenAILLM constructor. The strategy path already did this in
`resolveLlmEndpoint` (`src/lib/llm-provider.ts`); the chat path was sending the full
`openrouter/openai/gpt-4o` string as the API `model`, which OpenRouter rejects as unknown.

- Added `modelForApi` variable: uses stripped model for OpenRouter, unchanged otherwise.
- The `chatProviderForModel` function correctly routes on the prefixed string to detect the
  provider; only the API-facing model ID is normalised.

### P1 — Strip Tradier market-order brackets before the generic bracket path

In `src/lib/strategy.ts`, the Tradier market-entry bracket-stripping condition was an `else if`
after the whole-share bracket logic (which includes Tradier in `brokerSupportsBrackets`). For a
whole-share Tradier market entry, the whole-share branch always ran first and populated bracket
fields, making the Tradier-market check unreachable. The proposal would then carry brackets that
`TradierBrokerGateway.placeEquityOrder` silently ignores (Tradier's multi-leg entry only accepts
limit/stop/stop_limit), so the position had no native stop despite the proposal claiming one.

- Moved the Tradier market check (strips brackets, appends rationale warning) to its own `if`
  block **before** the whole-share chain.
- Added `!isTradierMarket` to the whole-share condition so it never adds brackets back.
- `test/strategy-hardening.test.ts`: changed the Tradier bracket test from market (unsupported)
  to limit order (supported), added a new test verifying market-order brackets are correctly
  absent.

## Files touched

- `src/lib/chat/llm.ts` — strip `openrouter/` prefix in `llmForModel`
- `src/lib/strategy.ts` — reorder bracket-stripping conditions, exclude Tradier market from whole-share logic
- `test/strategy-hardening.test.ts` — update test to use limit order, add market-order stripping test
- `STATUS.md` — add autofix entry
- `docs/rollouts/2026-07-17-openrouter-metadata-codex-autofix.md` — this note

## Verification

```
npm run lint      → 0 errors, 499 pre-existing warnings
npx tsc --noEmit  → clean
npm test          → 405 files / 4737 tests passed
npm run build     → clean (all 32 static pages)
```

## Follow-ups

Both Codex review threads to be resolved after push. Auto-merge enabled.
