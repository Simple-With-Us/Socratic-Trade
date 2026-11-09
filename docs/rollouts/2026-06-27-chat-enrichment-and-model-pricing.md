# Rollout Note — Chat Assistant Enrichment and Model Pricing Update

## Summary
Updated the chat assistant to support rich company fundamentals and market-wide signals, resolving previous context gaps where the assistant claimed it had no access to market-wide movers, market cap, OHLC, or analyst price targets. Also added pricing definitions for OpenAI's `o1`, `o1-mini`, `o1-preview`, and `o3-mini` models in `llm-usage.ts`.

## Why
1. **Chat Assistant Improvements:** Previously, the chat assistant was constrained to only returning quotes/prices via `get_quote`. By exposing existing backend subsystems (`getEnrichmentProvider().enrich(...)` and `getMarketSignals(...)`) through the registered tools `get_fundamentals` and `get_market_signals`, the LLM can now answer detailed queries about P/E ratios, analyst recommendations, target prices, company descriptions, top gainers, losers, and market breadth.
2. **Model Pricing Updates:** To ensure accurate token-cost accounting when using OpenAI's latest reasoning models, pricing mappings for the `o1` and `o3` series were added.
3. **Clarified OpenAI Model Availability:** The user's query about `gpt-5.4` returning an availability error was investigated and answered: `gpt-5.4` and `gpt-5.5` are hypothetical placeholders defined in `llm-usage.ts` for cost projection, but do not exist in OpenAI's API.

## Files Touched
- [src/lib/chat/llm.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/resolve-prod-merge-prs/src/lib/chat/llm.ts)
- [src/lib/chat/orchestrator.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/resolve-prod-merge-prs/src/lib/chat/orchestrator.ts)
- [src/lib/chat/tools.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/resolve-prod-merge-prs/src/lib/chat/tools.ts)
- [src/lib/llm-usage.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/resolve-prod-merge-prs/src/lib/llm-usage.ts)
- [test/chat-orchestrator.test.ts](file:///Users/jay/.gemini/antigravity/worktrees/Agentic%20Trading/resolve-prod-merge-prs/test/chat-orchestrator.test.ts)

## Verification
Ran full suite of typechecks, test suite, and build:
```bash
npx tsc --noEmit
npm test
npm run build
```
- **Typechecks:** Passed with no errors.
- **Tests:** 1,440/1,440 tests passed successfully (including the new mock tests verify-wiring `get_fundamentals` and `get_market_signals` intents).
- **Next.js Build:** Ran `npm run build` locally, successfully compiles and bundles the client/server assets.

## Follow-ups
None. Wiring is fully integrated and tested.
