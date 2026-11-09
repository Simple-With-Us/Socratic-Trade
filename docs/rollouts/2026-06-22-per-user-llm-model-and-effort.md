# 2026-06-22 - Per-user LLM model + reasoning effort (gpt-5 support)

## Summary

The app was pinned to a single `OPENAI_MODEL` (default `gpt-4.1-mini`) and always
sent `temperature: 0`. That broke two ways: (a) projects scoped to gpt‑5.x can't
use `gpt-4.1-mini`, and (b) gpt‑5 / o‑series **reasoning** models reject the
`temperature` param entirely (`400 — Only the default (1) value is supported`).

Now **model** and **reasoning effort** are **per‑user policy settings** (each user
picks their own in Settings), and the request builder adapts to reasoning models.

## What changed

- **Per‑user settings** (`TradingPolicy`): `llmModel` and `llmReasoningEffort`
  (`"low" | "medium" | "high"`). Defaults: `gpt-5.4-mini` / `medium`
  (`src/lib/defaults.ts`). `mergePolicy` spreads `DEFAULT_POLICY`, so existing
  users pick up the default model automatically (their broken `gpt-4.1-mini` env
  is overridden by the per‑user setting).
- **Reasoning-aware request builder** (`src/lib/llm-request.ts`):
  - `isReasoningModel(model)` — matches `gpt-5*` / `o<digit>*`.
  - `resolveOpenAiModel(policy)` — policy.llmModel → `OPENAI_MODEL` env → `gpt-5.4-mini`.
  - `withLlmRequestBounds` now takes `model` + `reasoningEffort`: for reasoning
    models it **omits `temperature`**, adds `reasoning_effort` (chat) /
    `reasoning.effort` (responses), and **raises the output-token cap** by an
    effort-based budget (low 2k / medium 4k / high 8k) so hidden reasoning tokens
    don't starve the visible JSON answer. Classic models keep `temperature: 0`.
- **All 5 LLM call sites** (strategy bull+bear, red-team, post-mortem,
  proposal-revalidation, strategy-tuning) resolve the per-user model and pass
  `model` + `reasoningEffort` into the bounds. `model` is now required in
  `RequestBounds`, so tsc guarantees no site is missed.
- **Settings UI** (`app/dashboard-client.tsx`): "AI model" + "Reasoning effort"
  dropdowns, per-user, bound via `updatePolicy`.
- **Validation** (`app/api/policy/route.ts`): `llmModel` (non-empty, ≤64 chars),
  `llmReasoningEffort` ∈ {low,medium,high}.
- **Usage pricing** (`src/lib/llm-usage.ts`): added gpt‑5.5/5.4/5.4‑mini/5.4‑nano.
- **`.env.example`**: `OPENAI_MODEL` documented as a fallback that per-user
  Settings overrides; default bumped to `gpt-5.4-mini`.

## Pricing reference (USD / 1M tokens, in / out, June 2026)

- gpt-5.4-nano $0.20/$1.25 · gpt-5.4-mini $0.75/$4.50 · gpt-5.5 $5/$30 ·
  gpt-4.1-mini $0.40/$1.60. Reasoning models also bill hidden reasoning tokens
  (controlled by reasoning effort).

## Verification

- `npx tsc --noEmit` — clean.
- New `test/llm-request.test.ts` (reasoning vs classic transform, model resolution).
- `npm test` — 863 pass; 1 fail = pre-existing date-sensitive `cache-provenance.test.ts`.
  Updated 4 request-bounds tests (red-team, post-mortem, strategy-tuning,
  persistence-notification) to pin `llmModel: "gpt-4.1-mini"` so they keep
  asserting the classic temperature+caps path; reasoning bounds covered by the
  new unit test.
- `npm run build` — succeeds.

## Owner / deploy notes

- After deploy, each user sets their model + effort in Settings. The default
  (`gpt-5.4-mini` / medium) means the prod box's `OPENAI_MODEL=gpt-4.1-mini` no
  longer matters — the per-user setting wins — so the original "no access to
  gpt-4.1-mini" error is resolved without editing the box. (Optionally update the
  box `OPENAI_MODEL` to a gpt-5.x model for the env-fallback path.)
- Whatever model a user selects must be enabled in *their* OpenAI key/project.

## Follow-ups

- Model dropdown is a fixed curated list (nano/mini/5.5/4.1-mini); could become a
  free-text field or be populated from the user's accessible models later.
