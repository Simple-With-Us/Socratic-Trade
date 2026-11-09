# 2026-07-01 — Strategy LLM money-path hardening (Audit Chat A)

Branch `chat-a-llm-money-path`. Implements all 8 items of **Chat A — LLM & prompting
(money-path)** from `docs/reviews/2026-07-01-audit-work-split.md`.

## Summary

Brought the autonomous strategy money-path (Bull proposer + inline Bear red-team +
per-proposal debate) up to the rigor the chat subsystem already has: no fail-open on
Bear errors, versioned + eval-covered prompts, prompt caching, cross-provider
failover, truncation-aware output caps, strict JSON schemas, and a wired-in
rationale-collapse gate. Every routing/behavior change is behind a **default-off**
flag except the item-1 fail-open safety fix, which changes default behavior only in
the fail-safe direction (blocking, not enabling, trades).

## What changed (per item)

1. **Inline Bear red-team fails closed.** `proposeTrades` had three fail-OPEN exits
   (missing key, transport error/timeout, non-OK/unparseable) that silently carried
   un-critiqued Bull proposals forward. It now returns a `bearReviewUnavailable`
   signal + emits a loud `audit` + `provider_degraded` notification; the caller routes
   those proposals to `requiresHumanReview` so `decide`-mode runs never auto-execute
   them. `strategy.ts` (proposeTrades exits + the caller routing block).
2. **Versioned Bull/Bear prompts + offline eval + `prompt_version` stamp.** Extracted
   the Bull/Bear system prompts into `src/lib/strategy-prompts.ts` (leaf module) with
   `STRATEGY_PROMPT_VERSION` + `buildBullSystem()`/`buildBearSystem()` (byte-identical
   text). Added `scripts/eval/{strategy-score,strategy-dataset,run-strategy-offline}.ts`
   with three deterministic scorers (never off-universe; every short carries a stop;
   no buy contradicts structured evidence) and `npm run eval:strategy-offline`. Added a
   nullable `trade_proposals.prompt_version` column (db.ts migration v9 + CREATE TABLE)
   threaded through `insertProposal` and all 8 strategy insert call sites.
3. **Anthropic prompt caching.** `buildLlmRequestBody` anthropic-messages branch sends
   the system prompt as a single `cache_control: ephemeral` block, and `llmAuthHeaders`
   adds `anthropic-beta: prompt-caching-2024-07-31`. OpenAI-compatible transport
   unchanged. `llm-call.ts`.
4. **Ordered cross-provider failover (default-off).** New `policy.llmFallbackModels?:
   string[]`; on a transient primary failure (429/5xx via `isRetryableLlmStatus` or
   timeout/network via `isRetryableLlmError`) the Bull re-issues the same request
   against each fallback model. Recorded loudly: a `strategy_llm_failover` audit per
   hop + the served model/provider + reason on the Green Team step. `strategy.ts`,
   `llm-request.ts`, `types.ts`.
5. **Truncation-aware Bull cap.** New `detectLlmTruncation` (OpenAI `finish_reason`
   length / responses `incomplete` / Anthropic `stop_reason` max_tokens). A truncated
   Bull is recorded as a distinct step reason + `strategy_bull_truncated` audit —
   never a silent zero-proposal no-op. `llm-call.ts`, `strategy.ts`.
6. **Strict `json_schema` for the red-team on OpenAI-compatible providers.** Removed
   `openAiJsonObject:true` so `debateProposal` requests strict `json_schema` for every
   OpenAI-compatible provider except DeepSeek (kept on `json_object`). `red-team.ts`.
7. **Rationale-collapse gate (default-off).** New `policy.tuning.gateOnRationaleCollapse`:
   when on and a run's rationales collapse, its OPENING proposals route to human review
   (exits never gated) with a `strategy_rationale_collapse_gated` audit. Off = advisory
   only. `strategy.ts`, `types.ts`.
8. **Deleted the dead/broken Anthropic branch** in `resolveLlmEndpoint` (returned
   `provider:"openai"` at the Anthropic messages endpoint — unreachable + could never
   succeed). `llm-provider.ts`.

## Files

- `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts` (new), `src/lib/red-team.ts`,
  `src/lib/llm-call.ts`, `src/lib/llm-provider.ts`, `src/lib/llm-request.ts`,
  `src/lib/types.ts`, `src/lib/db.ts`, `src/lib/db-proposals.ts`.
- `scripts/eval/strategy-score.ts`, `scripts/eval/strategy-dataset.ts`,
  `scripts/eval/run-strategy-offline.ts` (new); `package.json` (`eval:strategy-offline`).
- Tests (new): `test/strategy-bear-fail-closed.test.ts`,
  `test/strategy-bull-truncation.test.ts`, `test/strategy-rationale-collapse-gate.test.ts`,
  `test/strategy-llm-failover.test.ts`, `test/run-strategy-offline.test.ts`,
  `test/strategy-prompt-version.test.ts`. Extended: `test/red-team.test.ts`,
  `test/llm-call.test.ts`.
- Docs: this note, `STATUS.md`, `PLAN.md`, `docs/phase-7-strategy.md`.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing grandfathered warnings only).
- `npm test` — full suite green (see commit for the run count).
- `npm run build` — Next.js build passes.
- `npm run eval:strategy-offline` — green (4/4 deterministic cases).

Test-isolation note: the money-path run-driving tests set env via `vi.stubEnv` and
clear pending proposals between cases (a leftover `proposed` row otherwise triggers a
pending-proposal revalidation LLM call that shifts call-order-based mocks).

## Follow-ups / notes

- `STRATEGY_PROMPT_VERSION` is currently a static app version ("strategy@1.0.0") — bump
  it on any prompt wording change. Optionally hash the user's actual edited prompt if
  per-user prompt provenance is wanted later.
- Item-4 failover chain is a policy-level model list; no Settings UI was added (default
  off / empty). Surfacing it in Strategy Studio is a possible follow-up.
- Out of scope (other Chat A items / workstreams): dashboard Red Team surfacing,
  RAG eval, the `strategy.ts` god-module split beyond the prompt extraction.
