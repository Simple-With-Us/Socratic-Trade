# 2026-07-10 — Mistral benchmark data surfaced in the model-picker UI (MONET, owner-directed)

## Summary

The 2026-07-10 Mistral keyed re-benchmark (`docs/rollouts/2026-07-10-mistral-rebench.md`)
produced real cost/latency/reliability numbers, but they only lived in a docs note — users
picking a model in the Framework page had no way to see them. This wires the numbers into
two ALREADY-BUILT UI surfaces rather than inventing a new one:

1. **Model Stats drawer** (`app/console/components/model-stats-drawer.tsx`, opened from the
   button beside every Proposer/Reviewer model select) — its benchmark-vs-live cost/latency
   table already had a designed slot for exactly this data; all four Mistral rows previously
   showed a dash because the 2026-07-08 full sweep recorded 0 successes for Mistral (the
   capability-map bug #1279 fixed). They now show real numbers, labeled `benchmark` exactly
   like every other model.
2. **Reasoning-effort advice text** under the Mistral Medium reasoning control
   (`src/lib/model-reasoning-recommendations.ts`, rendered in `app/console/strategy/page.tsx`
   next to the Proposer/Reviewer/AI-Review Strategist pickers) — already had a Mistral-specific
   advice string; extended it with the concrete None-vs-High tradeoff numbers, since that's
   exactly the nuance this benchmark revealed (None is fast/cheap but proposes nothing; High
   actually proposes but is far slower/costlier).

## Why

Owner-directed: "add benchmark data for Mistral so users can see it." Research (an Explore
subagent survey of the model-picker UI, `model-stats.ts`, and the benchmark JSON shapes)
found the app already has two purpose-built, clearly-labeled surfaces for exactly this kind
of data — filling them in was the right-sized change, not reviving the unused custom
`ModelPicker` listbox (dead code, zero JSX usages) to add per-option subtitles, which would
have been a much larger, out-of-scope UI rewrite for a data-wiring task.

## Decisions

- **Only the default-effort re-benchmark (`docs/benchmarks/2026-07-10-mistral-rebench.json`)
  merges into the Model Stats drawer**, not the high-reasoning-effort probe
  (`-high.json`). Both are real, non-zero-success rows for `(mistral-medium-3-5, green)` —
  merging both would create an ambiguous Map-key collision in `aggregateModelStats`. The
  default-effort row is what the model actually costs/takes as configured today; the
  high-effort tradeoff is prose in the advice text instead, where nuance fits naturally.
- **Concatenation, not a merge function.** `normalizeBenchmarkSummaries` already drops
  entries with no numbers (the 2026-07-08 Mistral rows, all-error) — concatenating
  `[...benchmarkJson.summaries, ...mistralRebenchJson.summaries]` before normalizing is
  provably safe (new test added) with zero new merge logic.
- **Softened the two hardcoded "2026-07-08" tooltip strings** in the drawer to generic
  "a standardized offline benchmark run" — with two source dates now blended into one
  table, a hardcoded date was a soon-to-be-false claim for exactly the rows this PR fixes.
  The general disclaimer sentence now says "most recently updated {date}" and the API
  computes that date as the later of the two merged runs' timestamps (2026-07-10).

## Files

- `app/api/llm-usage/model-stats/route.ts` — imports and concatenates the 2026-07-10 Mistral
  summaries; `benchmark.runAt`/`source` now reflect both merged sources.
- `app/console/components/model-stats-drawer.tsx` — tooltip/disclaimer wording no longer
  hardcodes a single date.
- `src/lib/model-reasoning-recommendations.ts` — `MISTRAL_MEDIUM_ADVICE` extended with the
  concrete None-vs-High cost/latency/reliability tradeoff.
- `test/model-stats.test.ts` — new test proving the concat-then-normalize merge is safe
  (stale zero-success + real entry for the same (model, role) → only the real one survives).
- `test/model-rotation.test.ts` — asserts the new advice text's key numbers.
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note — protocol.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/model-stats.test.ts test/model-rotation.test.ts` — 38/38 green.
- **Live, in-browser, end to end** (own worktree's dev server + a throwaway seeded Mistral
  key, decrypted with a fixed `ENCRYPTION_KEY` set for both the seed script and the dev
  server so the two processes agree — the default when unset is a per-process random key,
  which is why the first attempt's save silently failed the "add an API key" guard):
  - `curl localhost:3001/api/llm-usage/model-stats` confirmed all four Mistral rows now
    carry real `benchmarkCostUsd`/`benchmarkColdP50Ms`, and `benchmark.runAt` correctly
    reports the later (2026-07-10) timestamp.
  - Selected `mistral-medium-3-5` as the Proposer on the Framework page: the Reasoning
    Effort control appeared with the exact new advice copy rendered underneath.
  - Opened the Model Stats drawer: `mistral-small-2603` ($0.0015, 4.4s) and
    `mistral-medium-3-5` ($0.0117, 2.3s) both show real benchmark figures instead of a dash.
- `npm run lint` — 0 errors.
- `npm test` — full suite (see commit for exact count).
- `npm run build` — clean.

## Follow-ups

- None from this change specifically; still open from the parent rebench note: a red-role
  benchmark-script validator fix, and the owner decision (already made — see
  `docs/rollouts/2026-07-10-mistral-rebench.md`) is reflected in `MODEL_ROTATION_POOL`
  separately.

## Addendum 2026-07-16 — board state correction

This effort's `docs/EFFORT-LOG.md` row was left under **In Progress** after PR #1361 merged
(2026-07-10) and auto-deployed. Flipped the row marker to ✅ DEPLOYED (bookkeeping only; no
code change). The live board `/Users/jay/apps/TRADING-EFFORT-LOG.md` already reflected DEPLOYED.
