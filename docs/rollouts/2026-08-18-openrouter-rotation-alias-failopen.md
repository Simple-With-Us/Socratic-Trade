# 2026-08-18 — Today's Green 404s are valid public slugs, not an account miss

## Context & Objective

Jay sees “That model isn't available on your OpenRouter account.”  That is false.  Coolify receipts landed 2026-08-18 against live sha `cda485ff` (SELECT-only; no raw OpenRouter JSON).  The mapper on that sha is still 404 → the account sentence.  Rotation (`__rotate__`) stays.  Do not require OpenRouter dashboard adds.  Do not ship a tilde-only fix and call Green fixed.

## Changes Made

**Today's Green fails are not the missing-tilde seats.**  Claude/Grok/Kimi/mini-latest were skipped (`skippedNoCredential`; that array also includes availability-filtered models) and never called.  Restoring `~` will not by itself clear today's Green 404s.

**Actual 404s (Coolify, ~80ms, OpenRouter, `key_source=user`):**

1. 17:12:09Z Alpaca Paper `PA33IDTHMFK9` run `20072a55-2805-4d7a-8fa0-a1dff8c766cc` — pick `gemini-flash-latest` → called `google/gemini-3.7-flash` HTTP 404 86ms.  Payload `{"ok":false,"status":404,"provider":"openrouter","model":"google/gemini-3.7-flash","durationMs":86}`.  Failover chain exhausted (3 endpoints); only one `llm_call_latency`.  Red `gpt-5.6-luna` never called.
2. 17:01:57Z Roth IRA `294709855` run `a9f29155-e139-4259-8666-25b0cf5f901c` — pick `mistral-medium-latest` → `mistralai/mistral-medium-3-5` HTTP 404 82ms.

Not 401/402/403/429.  Credits not involved.  Last completed: Paper `2026-08-18T14:37:17Z` then failed 17:12Z; Roth `2026-08-17T14:38:02Z` then failed 17:01Z.

7d `llm_call_latency` 404s: `google/gemini-3.7-flash` ×2, `mistralai/mistral-medium-3-5` ×2, `mistralai/mistral-small-2603` ×1.  Aug 17 400s: `gpt-5.6-luna` / terra / `gpt-5.4-nano` and period slug `mistralai/mistral-medium-3.5`.  `google/gemini-3.7-flash` succeeded as red-team `2026-08-14T17:19Z`; 404s today.

Public `/api/v1/models`: all three 404 slugs **exist**.  Today's 404 is a valid public slug at ~80ms — that fits OpenRouter “No endpoints found matching your request” from live #2771 `provider.require_parameters=true`, not an unknown id and not an allowlist miss.

Did not invent additional Coolify bodies.  The receipts above are the live ones.

**Primary (today's class):**
- OpenRouter docs (provider-selection, 2026-08-18): `require_parameters` default is false; when true, unsupported-parameter endpoints never get the request; `allow_fallbacks` does not revive an empty set.
- Strategy bodies send `response_format` + `max_completion_tokens` + classifier `user`/`session_id`/`trace`.  Hypothesis: require_parameters + a field remaining endpoints do not advertise → 404 in ~80ms.
- `require_parameters` is now sent **only** for the #2771 nano case (OpenAI reasoning + `max_completion_tokens`).  Gemini / Mistral / Claude omit the flag.
- 404 “No endpoints found matching your request” says no compatible endpoint.  Bare 404 says couldn't complete.  True `model_not_found` is a bad-slug sentence, not an account-privacy sentence.
- Green/Red failover leaves a 404/403 model for the next chain entry (live exhausted the chain after one latency because prod 404 was not failover-eligible).

**Secondary (skipped seats, not today's Green 404):**
- `normalizeOpenRouterModelId` prefers dated public ids (`anthropic/claude-sonnet-5`, `openai/gpt-5.4-mini`, `deepseek/deepseek-r1`) or the live `~author/slug-latest` row (`~moonshotai/kimi-latest`).
- Availability treats `~` as optional and matches dated ↔ latest.
- If a successful `/models/user` allowlist would empty a keyed pool, fail OPEN minus `kimi-latest` / `claude-fable-5`.

Touched files:

- `src/lib/llm-call.ts`
- `src/lib/chat/llm.ts`
- `src/lib/llm-errors.ts`
- `src/lib/llm-request.ts`
- `src/lib/strategy.ts`
- `src/lib/red-team.ts`
- `src/lib/llm-provider.ts`
- `src/lib/openrouter-model-availability.ts`
- `src/lib/model-identity.ts`
- `src/lib/model-rotation.ts`
- `src/lib/llm-required.ts`
- `app/console/components/chrome.tsx`
- `test/llm-call.test.ts`
- `test/llm-errors.test.ts`
- `test/llm-provider.test.ts`
- `test/openrouter-model-availability.test.ts`
- `test/model-rotation.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-18-openrouter-rotation-alias-failopen.md`

## Decisions & Trade-offs

- Primary fix is today's gemini/mistral class: stop sending `require_parameters=true` on those bodies.  Tilde restore stays in the same PR but is not claimed as the Green fix.
- Nano still gets `require_parameters` because #2771's OpenAI endpoint 400 (`max_completion_tokens` not advertised) is a different failure than today's 404.
- Did not invent a Coolify HTTP body beyond the two runs and 7d latency counts above.
- Did not drop rotation.  Did not add models to Jay's OpenRouter dashboard.  Did not raise spend or touch the Congress $2 cap.  No Stripe / IAP.

## Verification State

```bash
curl -sS https://openrouter.ai/api/v1/models   # 413 models; gemini-3.7-flash + mistral-medium-3-5 exist
npm test -- test/llm-call.test.ts test/llm-errors.test.ts \
  test/llm-provider.test.ts test/model-rotation.test.ts \
  test/openrouter-model-availability.test.ts
                          # 91 passed
```

Required coverage: (a) 404 “No endpoints found matching your request” does not produce the account sentence; (b) `model_not_found` is a bad-slug sentence; (c) `google/gemini-3.7-flash`, `mistralai/mistral-medium-3-5`, and `mistralai/mistral-small-2603` strategy bodies do **not** send `require_parameters: true`; (d) empty allowlist still fail-opens minus dead slugs; (e) tilde/dated map for skipped seats.

Full `npm test` not claimed.  `xcodebuild` was not run (no `ios/**` product change).

## Next Steps & Blockers

- After merge/auto-deploy, the next Paper/Roth rotate run should call gemini-3.7-flash / mistral-medium-3-5 without `require_parameters=true` and must not call a routing 404 an account miss.
- Tilde restore only matters when those seats are actually picked.

## Zero-Code Findings

- Production health earlier the same day: `ok` true, `openrouterCredits.ok` true (`thresholdUsd` 3), `tradingLiveness.degraded`.
- Coolify receipts above are the live failing seats.  No additional OpenRouter JSON body was present — only status/model/duration.
