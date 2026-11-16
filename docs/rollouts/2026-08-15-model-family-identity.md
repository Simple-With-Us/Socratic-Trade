# 2026-08-15 — Model family identity for Results / price benchmarking / history

## Context & Objective

Owner: map `gemini-3.7-flash` onto `gemini-flash-latest`, and do the same for every Flash Lite, every Gemini Pro, every Opus, every Sonnet, and the rest of the catalog families.  Results, price benchmarking, and history were fragmenting across version slugs even though the picker already uses family ids.

## Changes Made

`canonicalModelId` was already the family table.  The gap was that several write and read paths still keyed off the OpenRouter wire slug (`google/gemini-3.7-flash`) or a dated alias (`claude-opus-4-8`).

- Red Team verdicts and `reviewedByModel` now persist the remapped family id, not the wire slug.
- `remapOpenRouterTelemetry` runs every served model through `canonicalModelId`.
- `getRedTeamEfficacy` buckets by family (historical `google/gemini-3.7-flash` vetoes join `gemini-flash-latest`).
- Critic-failure attribution, closed-lot entry/reviewer models, and `normalizeModelId` on approval cards use the same function.
- `aggregateModelStats` merges two reviewer-perf rows that canonicalize onto one family instead of last-write-wins.

### Files

- `src/lib/model-identity.ts`
- `src/lib/llm-usage.ts`
- `src/lib/red-team.ts`
- `src/lib/performance.ts`
- `src/lib/db-proposals.ts`
- `src/lib/model-stats.ts`
- `app/console/components/approval-card.tsx`
- `test/model-identity.test.ts` (new)
- `test/usage-model-merge.test.ts`
- `test/approvals-triage-model.test.ts`
- `test/model-stats.test.ts`
- `test/performance.test.ts`
- `test/llm-cache-usage.test.ts`
- `test/red-team-critic-failure-stats.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-15-model-family-identity.md`

## Decisions & Trade-offs

- Per-call `estimateLlmCostUsd` still prices the **served** slug (so `gpt-4o-mini` is not billed as `gpt-5.4-mini`).  Live cost/call on the picker is the sum of already-stored `cost_usd` grouped by family, which is the benchmark/history merge the owner asked for.
- `proposedByModel` stays the run's configured/catalog pick (already `gemini-flash-latest` under rotation).  Only Red's persisted reviewer id was the wire slug.
- Distinct product lines stay distinct: Flash ≠ Flash Lite ≠ Pro; Terra ≠ Luna ≠ Sol.

## Verification State

```
npx vitest run test/model-identity.test.ts test/usage-model-merge.test.ts \
  test/approvals-triage-model.test.ts test/model-stats.test.ts \
  test/performance.test.ts test/console-models.test.ts \
  test/console-red-team-labels.test.ts test/red-team-efficacy-ui.test.ts \
  test/llm-cache-usage.test.ts test/red-team-critic-failure-stats.test.ts \
  test/finalized-sizing-review.test.ts test/strategy-llm-failover.test.ts \
  test/llm-provider-cooldown.test.ts
```

Targeted suites green before land.  Full `scripts/land.sh` gate (tsc → test → build) runs on land.

## Next Steps & Blockers

Red Team 45s hard abort / empty Gemini body from the 48h log review is a separate fix (not this PR).  Alpaca `T` sub-penny 422 is also separate.
