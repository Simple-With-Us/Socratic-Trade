# 2026-06-29 — Claude as a first-class Green/Red Team model

## Summary

Claude (Anthropic) is now a first-class, selectable model for BOTH the Green Team
(Bull proposal generator) and the Red Team (Bear reviewer), alongside the existing
OpenAI/xAI/Gemini/Mistral/DeepSeek options. Previously Claude was only wired into
the Assistant chat and an env-gated Red-Team override (`RED_TEAM_LLM_PROVIDER=anthropic`);
the per-user Green/Red dropdowns and `resolveLlmEndpoint` only knew OpenAI-compatible
providers, and the strategy path leaned on OpenAI-only `response_format`/`json_schema`
params that Anthropic's Messages API rejects.

## Why

A previous session told the user Claude "can't be a Green/Red option because it can't
process JSON." That was half-true: the strategy/analysis call sites force structured
JSON via OpenAI's `response_format` (strict `json_schema`) / `text.format`, which
Anthropic doesn't accept. But Claude returns reliable JSON via its own mechanism —
**forced tool-use** (`tool_choice: { type: "tool", name }`), which the repo already
used for the env-gated Red-Team path. The fix is to route `claude-*` models through
the Anthropic Messages transport everywhere the strategy stack runs, not just chat.

## What changed

- **New transport** `anthropic-messages` (`src/lib/llm-request.ts`): added to a new
  `LlmTransport` union; `withLlmRequestBounds` now sets Anthropic's required top-level
  `max_tokens` (floored at 4096 to avoid truncating long tool-use JSON — Anthropic bills
  only emitted tokens, so the higher ceiling has no cost downside) and `temperature`.
- **Routing** (`src/lib/llm-provider.ts`): `resolveLlmEndpoint` now matches `claude-*`
  → `provider: "anthropic"`, `transport: "anthropic-messages"`, URL
  `https://api.anthropic.com/v1/messages` (override via `ANTHROPIC_API_URL`), Anthropic
  credential. Works for both Green and Red roles. `LlmEndpoint.provider` gained
  `"anthropic"`.
- **Shared request builder** (`src/lib/llm-call.ts`, NEW): `buildLlmRequestBody`,
  `llmAuthHeaders`, `extractLlmText` centralize per-transport shaping so every strategy
  call site is provider-agnostic. Anthropic uses `system` + `messages` + forced tool-use
  for schemas (and `x-api-key`/`anthropic-version` headers); OpenAI-compatible providers
  keep their exact prior behavior (strict `json_schema`; DeepSeek `json_object`).
  `extractLlmText` normalizes OpenAI chat/responses and Anthropic content blocks
  (a `tool_use` block's `input` is re-serialized to JSON) so callers `JSON.parse` uniformly.
- **Call sites refactored** to the shared builder (so Claude works as Green everywhere,
  not just the proposer): `src/lib/strategy.ts` (Bull + Bear), `src/lib/red-team.ts`
  (standalone debate, now with a forced-tool `red_team_verdict` schema for Claude while
  OpenAI keeps `json_object`), `src/lib/strategy-tuning.ts`, `src/lib/proposal-revalidation.ts`,
  `src/lib/post-mortem.ts` (free-text). Removed three now-duplicate local `extract*Text`
  helpers.
- **UI** (`app/dashboard-client.tsx`): added an "Anthropic (Claude)" optgroup
  (`claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`) to both the Green Team and
  Red Team selects; DRY'd the four duplicated model-id allow-lists into one
  `STRATEGY_MODEL_IDS` constant. `strategyLlmServiceForModel` + `LLM_SERVICE_LABELS` now
  map `claude-*` → `anthropic`, so the Settings key-gating warning covers a Claude Green model.
- **Key catalog copy** (`app/api/keys/route.ts`): the Anthropic entry now states it also
  unlocks the Green/Red Team, not just chat.

No change to the env-gated cross-provider override (`RED_TEAM_LLM_PROVIDER=anthropic` →
`debateViaAnthropic`); selecting a `claude-*` Red model is an independent, additive path.

## Files

- `src/lib/llm-request.ts`, `src/lib/llm-provider.ts`, `src/lib/llm-call.ts` (new),
  `src/lib/strategy.ts`, `src/lib/red-team.ts`, `src/lib/strategy-tuning.ts`,
  `src/lib/proposal-revalidation.ts`, `src/lib/post-mortem.ts`
- `app/dashboard-client.tsx`, `app/api/keys/route.ts`
- `test/llm-call.test.ts` (new), `test/llm-provider.test.ts`, `test/red-team.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-06-23-green-red-llm-routing.md` (follow-up)

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npm test` — 158 files / 1533 tests passed (incl. new Claude routing/red-team tests).
- `npm run build` — clean.
- Manual UI smoke against `npm run dev` — see PR walkthrough (Strategy Studio shows the
  Anthropic optgroup; selecting `claude-opus-4-8` persists for Green and Red).

## Follow-up (same PR) — OpenAI option cleanup

- Removed the "OpenAI (Real)" optgroup (`gpt-4o-mini`, `gpt-4o`, `o1-mini`, `o3-mini`,
  `o1`) from both the Green and Red Team selects, and relabeled "OpenAI (Simulated)" →
  "OpenAI" (the `gpt-5.4-*`/`gpt-5.5` models aren't simulated). Dropped those five ids from
  `STRATEGY_MODEL_IDS`. The "Custom Model ID..." free-text entry still accepts any model id
  (its seed value `gpt-4o-mini` is just an out-of-list trigger for the text field), so no
  model is actually unreachable — only the curated dropdown was trimmed. Verified in-UI that
  both selects now show a single "OpenAI" group with `gpt-5.4-nano`/`gpt-5.4-mini`/`gpt-5.4`/
  `gpt-5.5` and the other provider groups intact.

## Follow-ups

- OpenAI strict `json_schema` enforces the output shape server-side; Anthropic forced
  tool-use is reliable but not server-validated (same as xAI/Gemini/Mistral here). The
  call sites already degrade gracefully on malformed JSON and `sanitizeProposals` cleans
  output, so this is not a regression — but a future tightening could validate Claude
  tool output against the schema before use.
- `summarizeOpenAiRequest` telemetry reports an Anthropic body's `systemChars` as 0
  (the system prompt is a top-level field, not a message role). Cosmetic only; the call
  still traces model/endpoint/transport correctly.

## 2026-06-30 PR #253 Review Follow-up

### Summary
- Kept `next-env.d.ts` on the production build-generated `./.next/types/routes.d.ts` import so `npm run build` does not dirty the worktree.
- Fixed the Green/Red "Custom Model ID..." path after trimming the OpenAI dropdown: selecting Custom now seeds `gpt-4o-mini`, an out-of-list id, so the free-text input appears and removed curated models remain reachable.

### Why
- The branch had committed the dev-server route-types path, which production builds rewrite.
- The Custom handler was seeding `gpt-5.4-mini`, still a curated option, so the custom-input condition stayed false.

### Files
- `app/dashboard-client.tsx`
- `next-env.d.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-06-29-claude-green-red-team.md`

### Verification
- `npm ci` - passed in the temporary PR worktree.
- `npm run lint` - passed with 0 errors and 257 existing warnings.
- `npx tsc --noEmit` - passed cleanly.
- `npm run build` - passed; post-build `git status --short` showed only the intended branch changes, with `next-env.d.ts` kept on `./.next/types/routes.d.ts`.
