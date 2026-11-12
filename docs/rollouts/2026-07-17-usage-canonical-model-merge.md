# 2026-07-17 — Usage page: canonical-model merge (preserve pre-OpenRouter stats) (MONET)

## Summary

The LLM `Usage` page now merges OpenRouter-routed and direct-provider calls for the SAME
underlying model into one per-model total, while keeping a per-provider breakdown so the
pre-OpenRouter (direct) portion stays visible. Display/read-layer only — the raw `llm_usage`
ledger rows are never rewritten, so historical statistics are preserved exactly.

## Why

`llm_usage` stores each call as `(provider, model)`. Today a Claude call is recorded as
`provider="anthropic", model="claude-sonnet-5"`. Once universal OpenRouter routing lands
(PR #1703, Antigravity, in-flight) the SAME model is recorded as `provider="openrouter",
model="anthropic/claude-sonnet-5"`. The Usage page groups by `(provider, model)`, so at the
routing cutover each model would appear TWICE and its history would split. Owner asked to
(a) preserve the pre-OpenRouter stats and (b) merge new OpenRouter stats with the same model.

## What

- New pure module `app/admin/llm-usage/model-merge.ts`:
  - `canonicalModelId(model)` — merge key = bare model id, lowercased, vendor-routing prefix
    stripped (mirrors llm-usage.ts's price-table normalization: drop a leading `openrouter/`,
    then the first `vendor/` segment). Maps `anthropic/claude-sonnet-5`, `claude-sonnet-5`, and
    `openrouter/anthropic/claude-sonnet-5` all to `claude-sonnet-5`.
  - `displayModelName(model)` — same strip, original casing preserved, for display.
  - `aggregateUsageByModel(rows)` — groups by canonical model, sums calls/tokens/cost across
    providers, keeps a per-provider slice breakdown (sorted by cost desc). Pure; no mutation.
- `app/admin/llm-usage/llm-usage-client.tsx`: new `ModelBreakdownCard` "By model" section above
  the per-key detail cards. Each model shows the merged total + a per-provider breakdown
  ("Anthropic (Claude) · direct" / "via OpenRouter") when >1 route contributed; single-route
  models show the provider as an inline chip. Also uses `displayModelName` in the existing
  per-model sub-rows so a routed `anthropic/claude-x` reads as `claude-x`.

Read-only: nothing is written or migrated. Works on both the admin mount (`/admin/llm-usage`)
and the console mount (`/console/usage`), which share this client.

## Coordination

Interacts with PR #1703 (Antigravity, universal OpenRouter routing — the change that will
create the split). Kept strictly client-side (new module + the client), touching NO server
aggregation (`src/lib/llm-usage.ts`) to avoid conflict with #1703's edits there. Posted a
heads-up to #ag***-s**c; correct whether #1703 is merged or not (no-op today since ≈no
OpenRouter rows exist yet, correct automatically once #1703 lands).

## Files

New: `app/admin/llm-usage/model-merge.ts`, `test/usage-model-merge.test.ts`.
Modified: `app/admin/llm-usage/llm-usage-client.tsx`.

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `test/usage-model-merge.test.ts` 7/7
  (canonicalization, casing, merge with provider breakdown, same-(model,provider) collapse,
  ordering, no-mutation); full suite + build via land.sh.
- Live dev server, seeded with same-model direct+OpenRouter rows: the "By model" section
  merged claude-sonnet-5 to $10.00 (Anthropic direct $6 + OpenRouter $4) and gpt-5.4-mini to
  $1.60 (OpenAI $1 + OpenRouter $0.60); single-route deepseek-chat showed only its chip.
  No console errors.

## Follow-ups

- The Overview page "COST BY MODEL" tile (`app/admin/page.tsx`) could reuse
  `aggregateUsageByModel`/`canonicalModelId` for the same merge — deferred, out of scope for
  this Usage-page change; low effort follow-up.

## Update — benchmark/perf continuity folded in (2026-07-17, MONET + AG)

The owner's priority was preserving the accumulated per-model PERFORMANCE experience (the
benchmark), not just cost. `src/lib/model-stats.ts` keys realized-P&L/win-rate, latency, and
the static benchmark JSON by model, and the closed-lot `proposedByModel`/`reviewedByModel`
feed it — so #1703's route-qualified model IDs would split all of it at the cutover.

Antigravity (AG) implemented the server-side fix inside #1703 (`cleanModelId` canonicalization
at every keying point in `aggregateModelStats` — live cost, latency, benchmark summaries, and
proposer/reviewer closed-lot attribution). Because #1703 (universal OpenRouter routing, 70
files) is currently CONFLICTING against a fast-moving main and the owner wants the continuity
fix in production NOW, AG's model-stats canonicalization + its test changes
(`test/model-stats.test.ts`, `test/performance.test.ts`) are landed here — AG's exact,
verified code, credited — independent of the big routing PR. It is a no-op today (bare names)
and correct once routing lands. Coordinated on #ag***-s**c: AG drops the now-redundant
model-stats piece from #1703 on their next rebase and keeps the routing/recording changes.

Result: the model performance benchmark stays continuous across the OpenRouter cutover (no lost
experience), the Model Stats drawer keeps resolving live stats for active models, and the Usage
cost page merges the same model across routes — all in one shippable change.

## Follow-up (added)

- Consolidate AG's `cleanModelId` (model-stats.ts) and my `canonicalModelId` (model-merge.ts)
  into one shared `src/lib/model-identity.ts` — behaviorally equivalent today; kept separate
  now to preserve AG's verified benchmark code untouched for a fast, low-risk ship.
