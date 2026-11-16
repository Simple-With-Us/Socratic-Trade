# 2026-08-13 — GROK pickup of Claude Round 4 leftover

## 1. Context & Objective

Claude hit quota mid Round 4.  `origin/agent/claude` is gone.  Five finished r4 commits
remained only on the local Claude lane (`~/apps/trading-claude` at `40d5c087`).  r3 already
merged as #2666.  The toggles slice was yielded to Monet and merged as #2682 (migration 78
`notification_enabled_events_backfill`).  APNs claimed migration 77.  Goal: land the leftover
r4 product slices onto current `origin/main` without re-landing r3 or touching Monet's
worktrees.

## 2. Changes Made

Cherry-picked oldest-first from Claude's local lane onto a new worktree
(`~/apps/trading-grok-r4`, branch `grok/claude-r4-pickup`) forked from `origin/main`
`77bbb77f`.

1. **benchmarks** (`1ac172a9`) — `spyExcessPct` now grades against `^GSPC` (SPY fallback) and
   an opt-in GICS sector index/ETF.  Field name unchanged; `benchmarkBasis` discloses the
   ticker.  Default `policy.benchmarkMode` is `"market"`.
2. **pullback** (`9f7f870f`) — `sniperPoints.secondaryBuy` defaults to half ATR(14) as % of
   entry (clamped 1–4%).  `policy.secondaryBuyPullbackPct` is now an override.
3. **opspanel** (`293d4bb5`) — `src/lib/server-knobs.ts` + Admin > Operations panel.  Pause /
   kill switches resolve DB override > env > default with a 15s cache.  Streams, SEC ingest
   worker, RAG ingest / Pinecone write budgets, and `SEC_FILING_RAG_MAX_PER_RUN` honor a flip
   without redeploy.
4. **opspanel fixes** (`cb645a02`) — congress stream resume is level-based (parked loop
   self-polls).  Effect copy is honest.  Knob inventory documents remaining exclusions.
5. **dataage** (`40d5c087`) — headlines and Polymarket blocks now carry honest age notes.
   `STRATEGY_PROMPT_VERSION` lands as `agentic-strategy@2.5.0` (see below).

### Conflicts resolved

- `src/lib/vector-db.ts`: kept main's `resolveSourceBool` import (CLEAN_TEXT / source
  settings) **and** r4's `serverKnobBool` for ingest / Pinecone write budget flips.
- `test/strategy-prompt-safety.test.ts` + `src/lib/strategy-prompts.ts`: main already used
  `agentic-strategy@2.4.0` for the venue-contract prompt.  r4 also wanted 2.4.0 for data-age.
  Bumped this pickup to **2.5.0** so the stamp stays unique.

### Files touched (r4 + pickup)

- `src/lib/outcome-horizons.ts`, `src/lib/outcome-engine.ts`, `src/lib/counterfactual-learning.ts`,
  `src/lib/retrieval-usefulness.ts`, `src/lib/defaults.ts`, `app/api/policy/route.ts`
- `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`, `src/lib/types.ts`,
  `src/lib/polymarket-provider.ts`
- `app/console/components/proposal-scorecard.tsx`, `app/console/guardrails/field-defs.ts`
- `src/lib/server-knobs.ts`, `src/lib/server-knob-supervisor.ts`,
  `src/lib/background-worker-startup.ts`, `src/lib/congress-stream.ts`,
  `src/lib/dormant-features.ts`, `src/lib/r2-usage.ts`, `src/lib/rag/sec-ingest-worker.ts`,
  `src/lib/source-settings.ts`, `src/lib/source-settings-catalog.ts`, `src/lib/vector-db.ts`,
  `src/lib/streams/alpaca-news-stream.ts`, `src/lib/streams/alpaca-price-events-stream.ts`,
  `src/lib/streams/alpaca-trade-updates-stream.ts`
- `app/admin/layout.tsx`, `app/admin/operations/*`, `app/api/admin/server-knobs/route.ts`,
  `app/console/settings/lib.ts`, `app/console/settings/page.tsx`
- Tests: `test/outcome-engine.test.ts`, `test/outcome-horizons.test.ts`,
  `test/benchmark-mode-policy-route.test.ts`, `test/proposal-scorecard.test.ts`,
  `test/server-knobs.test.ts`, `test/background-worker-startup.test.ts`,
  `test/strategy-prompt-data-age.test.ts`, `test/strategy-prompt-safety.test.ts`
- Docs: this note, `docs/rollouts/2026-08-13-prompt-data-age-audit.md`, `STATUS.md`,
  `PLAN.md`, `docs/EFFORT-LOG.md`

## 3. Decisions & Trade-offs

- **No new schema version.**  None of the five commits bump `MIGRATIONS`.  Main already has
  77 (`device_push_tokens`) and 78 (`notification_enabled_events_backfill`).  Next free
  version remains **79**.
- **Did not start the advisory-tail / settings-surface sweep.**  Claude named that residue
  after yielding toggles.  Those files are not in these five commits (they rode Monet
  #2682).  Task said include only if present or a tiny leftover.
- **Did not commit in `~/apps/trading-claude`.**  Read-only source of the five SHAs.
- **Did not touch Monet PR worktrees.**
- Dual credit: Claude authored the slices; GROK picked them up and resolved the two
  collisions above.

## 4. Verification State

Commands are run by `bash scripts/land.sh` (Node 24) before the PR opens:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit
npm test
npm run build
```

Cherry-pick itself: 3/5 clean, 2 resolved as above.

## 5. Next Steps & Blockers

- Land via `scripts/land.sh`, then `gh pr merge <n> --squash --auto`.
- After merge: Operations panel is live; owner can flip server knobs without a Coolify
  redeploy.  `benchmarkMode=sector` stays off until the owner sets it.
- Residual (not this PR): advisory-tail reword + broader settings-surface sweep, if still
  wanted after Monet #2682.

## 6. Zero-Code Findings

Claude's working tree was clean.  No uncommitted r4 leftovers beyond the five named commits.
`origin/agent/claude` is still gone — this pickup is the only copy that will reach `main`.
