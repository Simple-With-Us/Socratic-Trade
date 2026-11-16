# 2026-07-18 — OpenRouter routing: post-merge Codex follow-ups (from #1703)

## Summary
PR #1703 (universal OpenRouter routing, Antigravity) merged to `main` with several
Codex review threads still open (codex-autofix hit its 10-round / 54-commit cap and
stopped). This branch (`claude/openrouter-codex-followups`) fixes the three correctness
findings that are now live in production (merge auto-deploys):

1. **P1 — Claude reasoning via OpenRouter** (`src/lib/llm-request.ts`,
   `withLlmRequestBounds`): a Claude model routed as `anthropic/*` on the
   chat-completions transport fell through to the generic reasoning branch and sent
   `reasoning_effort` + `temperature`. OpenRouter maps its **unified `reasoning`
   parameter** to Anthropic's extended thinking, and Anthropic reasoning models reject a
   custom `temperature`. So medium-effort Claude strategy/review calls could be rejected
   or silently run without the requested thinking. Added an OpenRouter+Anthropic branch
   that emits `reasoning: { effort }` (never `reasoning_effort`, no temperature; `none`
   → `reasoning: { enabled: false }` + deterministic temperature).
2. **P2 — Normalize existing `xai/` Grok slug** (`src/lib/llm-provider.ts`,
   `resolveLlmEndpoint`): the raw-`grok` → `x-ai/` mapping only fired for un-namespaced
   ids, so an already-namespaced `xai/grok-4.3` (a saved policy value or fixture) reached
   OpenRouter unchanged and hit an invalid-model failure. Now normalizes `xai/` → `x-ai/`
   after the prefixing/openrouter-strip step. (Stored policy values stay `xai/`; only the
   resolved endpoint model is normalized.)
3. **P2 — Keep billing cooldowns on the OpenRouter credential lane**
   (`src/lib/llm-provider-cooldown.ts`): transient rate/5xx failures still cool the vendor
   sub-lane (so a busy OpenAI-family primary doesn't cool a healthy Gemini/Anthropic
   fallback), but **billing/credits** failures now stay on the `openrouter` credential
   lane on BOTH the write side (`recordLlmProviderFailure`) and the read side
   (`getLlmProviderCooldown` now checks the credential lane in addition to the vendor
   sub-lane, preferring the longer-cooling one). Otherwise an out-of-credits OpenRouter
   key cooled only the `openai` lane and immediately retried `google/…`, `anthropic/…`
   through the same dead credential.

## Round 2 (Codex review of this PR)
- **Visible-token starvation for Claude reasoning** (`src/lib/llm-request.ts`, follow-up to the P1
  above): OpenRouter derives Anthropic's thinking budget as a **fraction** of `max_tokens`, so the
  first cut's `reasoning: { effort }` reserved most of the cap for thinking at high/xhigh/max and
  starved the visible JSON. Now sends an **explicit** `reasoning: { max_tokens: <headroom> }`
  (clamped to Anthropic's 1024 min, cap widened) so the visible slice stays == the caller's requested
  `maxOutputTokens`. Regression test asserts `max_completion_tokens - reasoning.max_tokens === requested`.

## Deferred
- **Billing all-cooling planner behavior** (`src/lib/llm-provider-cooldown.ts`
  `planLlmProviderAttempts`): when every lane is cooling due to a shared-credential BILLING cooldown,
  the planner's documented "attempt anyway, least-recently-failed first" fallthrough still retries the
  chain on the dead key. Distinguishing billing (→ skip/hold) from transient (→ attempt-anyway) is a
  deliberate policy change to a money-path-adjacent invariant ("the cooldown never makes things
  strictly worse"), so it's left for a maintainer decision. NOT a regression from this PR — billing
  429s retried the chain before this change too (just on a vendor lane).
- **4th finding — rotation eligibility** (`src/lib/model-rotation.ts`
  `eligibleRotationPool` should gate on the OpenRouter credential like endpoint
  resolution, not the per-model native family). Deferred to a focused follow-up: it needs
  coordinated rewrites of #1703's just-merged model-rotation tests (the eligibility test
  and the ordering-dependent `resolveModelRotationForRun` picks assert native-family
  gating). Tracked here so it isn't lost.

## Files
- `src/lib/llm-request.ts` — OpenRouter+Anthropic reasoning branch in `withLlmRequestBounds`.
- `src/lib/llm-provider.ts` — `xai/` → `x-ai/` normalization in `resolveLlmEndpoint`.
- `src/lib/llm-provider-cooldown.ts` — billing-stays-on-credential-lane (write + read).
- `test/llm-request.test.ts` — regression: Claude-via-OpenRouter reasoning shape.
- `test/llm-provider.test.ts` — grok assertions now expect `x-ai/grok-4.3`.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/llm-provider.test.ts test/llm-request.test.ts test/llm-provider-cooldown.test.ts` — 39/39.
- Full `npm test`, `npm run build`, `npm run lint` — see PR CI `verify`. (Local full-suite
  shows one unrelated pre-existing env failure — `test/market-custom-symbol.test.ts`,
  `no such table: sec_insider_transactions`, a stale local test-DB/migration state; #1703
  merged with `verify` green so it passes in CI.)

## Follow-ups
- Land the deferred rotation-eligibility fix (P2) with the model-rotation test rewrites.
