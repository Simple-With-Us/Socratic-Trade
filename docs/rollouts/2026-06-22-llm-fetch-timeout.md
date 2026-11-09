# 2026-06-22 — Bounded LLM + Robinhood-order fetch timeouts

## Summary

Queued reliability fix: LLM HTTP calls (and the Robinhood MCP order path) had no
timeout, so a half-open connection could hang the caller indefinitely — and for the
strategy run that means holding the per-user run lock (starving the scheduler) with
no error to alert on.

## Changes

- **`src/lib/llm-request.ts`** — new `LLM_TIMEOUT_MS = 60_000` and
  `llmFetch(url, init)` = `fetch` with `signal: AbortSignal.timeout(LLM_TIMEOUT_MS)`
  (a caller-supplied `signal` is respected).
- Swapped the raw LLM `fetch` calls to `llmFetch` at every site: `strategy.ts`
  (bull + bear), `red-team.ts`, `strategy-tuning.ts`, `proposal-revalidation.ts`,
  `post-mortem.ts`, and `chat/llm.ts` (Anthropic + OpenAI transports). On timeout
  the request aborts and rejects (AbortError) — every site already handles an LLM
  failure (falls back / surfaces an error).
- **`src/lib/robinhood.ts`** — `callRobinhoodMcpMethod` (the central MCP fetch used
  by `place_equity_order` and every other Robinhood tool) now sets
  `signal: AbortSignal.timeout(30_000)`, so a hung order/tool call can't block the
  order path or strategy run.

(`learning-loop.ts:40` is a Yahoo OHLCV data fetch, not LLM — out of scope.)

## Tests

`test/llm-fetch-timeout.test.ts` — `llmFetch` injects an `AbortSignal` when none is
given, passes other init through, respects a caller-supplied signal; `LLM_TIMEOUT_MS`
is positive.

## Verification

Isolated worktree off `origin/main` (`f88c47c`), `npm ci`:
- `npx tsc --noEmit` — clean
- `npm test` — all pass (incl. 3 new)
- `npm run build` — green
