# Coach fail-closed tool inputs + abort in-flight turns

## Context & Objective

Implements review cluster `coach-tools-and-turns` (Part II, `docs/reviews/2026-08-18-full-app-expert-review.md`).  Coach `draft_order` was coercing invalid `side`/`order_type` values to the wrong economic direction and silently dropping limit prices; LLM transports ignored `abortSignal`, so Cancel and the 120s turn deadline could not stop an in-flight provider call.

## Changes Made

- `draft_order` now fail-closes on invalid `side`, `order_type`, and missing/invalid `limit_usd` for limit orders (mirroring `normalizeAlertOp` in `src/lib/alerts.ts`).
- Exported `normalizeDraftSide` and `normalizeOrderType` helpers; added `clampKbSearchK` with schema `maximum: 20`.
- Chat LLM transports (`defaultTransport`, `defaultOpenAITransport`, `makeOpenAITransport`) accept an optional third `signal` argument and compose it with `LLM_TIMEOUT_MS` via `AbortSignal.any` before calling `llmFetch`.
- `AnthropicLLM.run` and `OpenAILLM.run` pass `args.abortSignal` into every transport call.

**Files touched:**
- `src/lib/chat/tools.ts`
- `src/lib/chat/llm.ts`
- `test/chat-tools.test.ts` (new)
- `test/chat-llm.test.ts`

## Decisions & Trade-offs

- Did not change shared `llmFetch` in `llm-request.ts` (other callers depend on its signal semantics); abort composition is scoped to chat transports only.
- `order_type` defaults to `market` when absent (unchanged behavior); only explicit invalid values reject.
- `side` has no default — must be exactly `buy` or `sell` (case-insensitive).
- Did not expand into prompt-trust-boundary / coach-learning ingest (separate cluster).

## Verification State

```bash
npm run lint          # 0 errors (771 warnings, grandfathered)
npx tsc --noEmit      # clean
npm test -- test/chat-tools.test.ts test/chat-llm.test.ts  # 38 passed
npm run build         # clean
```

Full `npm test` was started in background on this VM; unrelated pre-existing failures observed in `vector-db-document-receipts`, `connection-health-routing`, and `strategy-held-position-retrieval-scope` (timeouts) — none touch `src/lib/chat/*`.

## Next Steps & Blockers

- Merge after `verify` CI is green.
- Remaining coach cluster items (MAX_STEPS disclaimer, qty/notional, turnKey dedup) are out of scope for this PR.

## Zero-Code Findings

None.
