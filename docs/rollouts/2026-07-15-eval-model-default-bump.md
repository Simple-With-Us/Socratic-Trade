# 2026-07-15 — Bump eval-script OpenAI model defaults off retired gpt-4o-mini

## Summary
Two offline/eval dev scripts still defaulted their OpenAI model to the previous-gen
`gpt-4o-mini`. Moved both onto the current 5.x fleet:

- `scripts/eval/faithfulness.ts` — RAG faithfulness LLM-**judge** default
  `gpt-4o-mini` → `gpt-5.4-mini`.
- `scripts/eval/run-offline.ts` — OpenAI **subject-under-test** representative in the
  cross-provider bake-off `gpt-4o-mini` → `gpt-5.4-nano`.

Both remain env-overridable (`RAG_EVAL_FAITHFULNESS_JUDGE_MODEL`, and each provider row
keyed by its own env var).

## Why
- `gpt-4o-mini` is not used anywhere in the live app path (not in `MODEL_ROTATION_POOL`,
  chat, or RAG multi-query — those run the 5.x models). It survived only as a stale
  default in these two dev scripts, plus inert price-table / downgrade-map keys and test
  fixtures. So any `gpt-4o-mini` line on the OpenAI usage dashboard came from a manual
  eval run, not production.
- Different roles get different tiers on purpose: the **judge** in `faithfulness.ts`
  should be at least as capable as what it grades, so it goes to `gpt-5.4-mini`
  ($0.75/$4.5 per 1M) rather than the cheapest possible model; the **subject** in
  `run-offline.ts` is a cross-provider comparison where every other provider already uses
  a current cheap-tier model (`claude-haiku-4-5`, `gemini-2.5-flash`,
  `ministral-3b-latest`, …), so OpenAI's fair peer is its cheap-tier current model,
  `gpt-5.4-nano` ($0.20/$1.25). Leaving OpenAI on last-gen skewed that comparison.
- Sibling judge `scripts/eval/score.ts` has no hardcoded default (requires
  `EVAL_JUDGE_MODEL`), so there was no existing default to align to.

## Files
- `scripts/eval/faithfulness.ts` (line 167)
- `scripts/eval/run-offline.ts` (line 225)
- `STATUS.md`, `docs/EFFORT-LOG.md` (handoff protocol)

## Verification
- No test or script couples to the old defaults: `PROVIDER_MODELS` is consumed only
  inside `run-offline.ts`, and the faithfulness default is env-overridable and unmocked
  by name in the suite (grep of `test/` for `FAITHFULNESS_JUDGE_MODEL` / `PROVIDER_MODELS`
  returns only the script itself).
- Full gate runs via `scripts/land.sh` (tsc → test → build) before the PR opens.

## Follow-ups
- Not changed (deliberately): the inert bare-`gpt-5.6` keys in
  `src/lib/usage-budget.ts` (downgrade map) and
  `src/lib/model-reasoning-recommendations.ts` (recommendation lookup). They are
  defensive lookup aliases, never invoked — removing them would be unrelated churn. If a
  user-facing model **picker** is ever found to expose bare `gpt-5.6` as selectable, alias
  it to `gpt-5.6-terra` then (there is no base `gpt-5.6` model — only luna/sol/terra).
- Congress.Trade needed no change: its live extraction already uses `gpt-5.6-terra`
  (bake-off adds luna/sol); its bare-`gpt-5.6` references are all `startsWith` prefix
  guards, an inert price alias, or version-label strings.
