# 2026-07-18 — OpenRouter-exclusive: rotation eligibility + policy save-gate

## Summary
Post-#1703 (universal OpenRouter routing) follow-up. Two consumers still keyed model
availability on the per-model **native family** while production serves every model through
the **OpenRouter credential** (`resolveLlmEndpoint`), so an OpenRouter-only account was wrongly
limited:

- **`eligibleRotationPool`** (`src/lib/model-rotation.ts`): filtered `MODEL_ROTATION_POOL` by
  `resolveLlmCredential(llmModelFamily(model))`, so an OpenRouter-only user got an empty pool or
  only legacy `openrouter/*` entries — `__rotate__` couldn't rotate.
- **Policy save-gate** (`app/api/policy/route.ts`): rejected saving a valid curated/qualified model
  (e.g. `anthropic/claude-sonnet-5`) demanding an unused native key, even with the OpenRouter key
  present (Codex finding on #1703).

## Fix
Centralized the rule in one exported helper **`modelCredentialService(model)`** (in
`src/lib/llm-provider.ts`): returns `"openrouter"` in production and the native family under
`NODE_ENV=test` — mirroring `resolveLlmEndpoint`'s existing credential shim so native-key test
fixtures keep resolving. Routed `resolveLlmEndpoint`, `eligibleRotationPool`, and both policy
save-gates (green + red) through it, so they can never drift. The picker
(`app/ui/llm-model-catalog.ts`) needs no change — its native ids already route through OpenRouter
via `resolveLlmEndpoint`.

## Files
- `src/lib/llm-provider.ts` — new `modelCredentialService` helper; `resolveLlmEndpoint` uses it.
- `src/lib/model-rotation.ts` — `eligibleRotationPool` gates via the helper.
- `app/api/policy/route.ts` — green + red save-gates gate via the helper (OpenRouter-worded message
  in prod, native message under test).
- `test/llm-provider.test.ts` — regression: helper returns `openrouter` in prod, native family in test.

## Verification
- `npx tsc --noEmit` clean after `npm run build` (build regenerates `.next/types`; a stale
  `app/old/page` artifact from a prior branch cleared on rebuild).
- `npm test`: 4794 passed / 1 pre-existing unrelated env failure (`market-custom-symbol`,
  `no such table: sec_insider_transactions`). `npm run build` exit 0. `npm run lint` 0 errors.

## Follow-ups
- Sibling PR handles the 5 money-path/reliability findings (halted broker stops, Tradier bracket
  ordering, active-protection live-exit semantics, atomic option-alert, option-fetch deadline).
- Deferred billing-cooldown planner policy (Finding A on #1733) — separate.
