# 2026-07-08 — Model-picker cost/latency/performance stats drawer (MONET)

Branch: `monet/model-cost-drawer` (worktree `.claude/worktrees/monet-model-cost-drawer`, off `origin/main` after #1114 landed the benchmark JSON).

## Summary

Owner request: on the model pickers, each model option should surface (mainly) COST,
plus latency, with room for realized PERFORMANCE — but performance must never appear
unqualified below a sample-size threshold.

Shipped:

- **Per-select stats affordance.** A small bar-chart icon button next to each
  Proposer/Reviewer `<select>` on BOTH picker surfaces (`app/console/settings/models.tsx`
  and `app/console/strategy/page.tsx`) opens a slide-out sheet (the console `Sheet`
  primitive) listing every curated catalog model.
- **Shared drawer component** `app/console/components/model-stats-drawer.tsx`
  (`ModelStatsButton role="proposer"|"red-team"`), con-* design system (Sheet, con-table,
  Chip, IconButton, Dash). One fetch per open (cached for the session of the component).
- **Columns per model:**
  - *Cost / call* — live average from the user's own `llm_usage` rows when the role has
    >= 3 live calls (chip `live · n=X`), otherwise the standardized benchmark estimate
    (chip `benchmark`). Contexts map `strategy` → green/Proposer, `strategy-bear` +
    `red-team` → red/Reviewer; chat/coach traffic never leaks in.
  - *Latency (p50)* — median of successful `llm_call_latency` audit durations
    (step `bull` → green, `bear` → red; failures excluded so instant 429s can't drag the
    p50 down) when >= 3 samples, else the benchmark COLD p50, labeled the same way.
  - *Realized performance* (Proposer only) — closed-lot win rate + avg return attributed
    to the ENTRY proposal's `proposedByModel`, across all the user's connected accounts.
    Display gating: `< 20` closed trades → "— needs >=20 closed trades (n=X)";
    `20-49` → real numbers WITH a `small sample (n=X)` warn chip; `>= 50` → plain with
    `n=X`. Reviewer column is deliberately an em dash with a footnote: Red attribution is
    per-run (veto value-add, `getRedTeamScorecard`), not per-closed-trade — not faked.
- **API**: new `GET /api/llm-usage/model-stats` (sibling of `/api/llm-usage`; same
  `resolveRequestUserId` middleware-verified auth). Returns
  `{ sinceDays, benchmark: { runAt, source }, stats: ModelRoleStats[] }` where each row is
  `{ model, role, liveCalls, avgCostUsd, p50LatencyMs, latencySamples, benchmarkCostUsd,
  benchmarkColdP50Ms, closedTrades, perf }`. Contract: `closedTrades` is ALWAYS present;
  `perf` is included whenever `closedTrades >= 1` (green only) — the UI owns display
  thresholds. `sinceDays` defaults to 90 for the live-usage window.
- **Pure rollup** `src/lib/model-stats.ts`: `aggregateModelStats` (usage rows + latency
  audit events + normalized benchmark summaries + closed lots → per-(model, role) stats),
  `normalizeBenchmarkSummaries` (cold-p50-preferred, avg→cold→warm cost fallback,
  all-error rows like the two mistral entries dropped), role mappers, `medianMs`. No DB
  access — fully unit-testable.
- **Benchmark source**: `docs/benchmarks/2026-07-08-llm-model-benchmark.json` (#1114)
  imported statically by the route (bundled at build time — no runtime fs dependency, so
  it works under any deploy layout). Labeled `benchmark` everywhere it's shown; the drawer
  header states the run date.
- **`ClosedLot.entryModel`** (additive): `calculatePnl` in `src/lib/performance.ts` now
  threads the opening proposal's `proposedByModel` (already persisted in
  `fill_events.raw.proposal`) through the FIFO lot replay onto each closed lot — mirrors
  the existing thesis/regime/sector stamps; no behavior change for any existing consumer.

## Why

Model choice was blind: the picker showed only static `$`/`$$`/`$$$` tiers. The data to
answer "what does this model actually cost/feel like per run, and has it made money?"
already existed (llm_usage ledger, llm_call_latency audits, proposedByModel on proposals,
the #1114 benchmark) but was never joined for the picker. Performance gating thresholds
(20/50) are deliberate: a 3-trade win rate is noise and must not look like a signal.

## Files

- `src/lib/model-stats.ts` — new; pure aggregation + benchmark normalization.
- `app/api/llm-usage/model-stats/route.ts` — new; GET endpoint.
- `app/console/components/model-stats-drawer.tsx` — new; shared button + Sheet drawer.
- `src/lib/performance.ts` — additive `entryModel` on ClosedLot / lot replay /
  `thesisMetaFromFill`.
- `app/console/settings/models.tsx` — additive: import + flex-wrap the two strategy
  selects with `ModelStatsButton` (file is claimed by the stalled single-adversary lane;
  edits kept minimal per coordinator authorization).
- `app/console/strategy/page.tsx` — same additive wrap for both Fields.
- `test/model-stats.test.ts` — new; 13 unit tests (role mapping, cost rollup, p50 from
  ok-only samples, benchmark fallback, perf gating incl. red-role exclusion and
  model-less lots, benchmark normalization).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

```bash
npx tsc --noEmit                      # clean
npm run lint                          # 0 errors (339 pre-existing warnings)
npx vitest run test/model-stats.test.ts   # 13/13
npx vitest run                        # 295 files / 2997 tests, all green
# Runtime smoke (temp DB): tsx script invoking the route GET directly —
#   200; 30 stat rows; live rows merge over benchmark; fable/gemini benchmark numbers match the JSON.
# Next dev smoke on :4777 (temp DB): GET /api/llm-usage/model-stats → 200 with full payload;
#   /console/strategy and /console/settings both compile + serve 200.
bash scripts/land.sh                  # tsc → test → build gate + PR (run at landing)
```

## Follow-ups

- `reviewedByModel` per-proposal stamp (single-adversary lane) would let the Reviewer
  column show per-run review stats (e.g. veto value-add) instead of a dash.
- mistral-small-2603 / mistral-medium-3-5 have no benchmark numbers (3/3 HTTP errors in
  the benchmark run) and show dashes until live traffic or a re-run benchmark exists.
- The benchmark JSON is bundled; when a newer benchmark run lands, update the import in
  the route (one line) or generalize to "latest benchmark" resolution.
- Live cost/latency thresholds (>=3 samples) and perf thresholds (20/50) are constants in
  the drawer component (`LIVE_MIN_SAMPLES`, `PERF_MIN_TRADES`, `PERF_SOLID_TRADES`) —
  owner-adjustable in one place.
