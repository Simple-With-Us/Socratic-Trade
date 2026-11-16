# 2026-08-17 — Pinecone daily-fuse deadlock + keep the VIX backup

## Context & Objective

Owner rejected the earlier "expected fuse / ingest park / OpenRouter prepaid minimum"
triage.  Pinecone should still be writing on the Standard trial.  The live card was
used 0 of 15 estimated WUs (attempted 28, skipped 1) and Siliconflow 0 or 1 of 1
texts.  That is a deadlock, not a spent 2.5M fuse.  HTTP 429 on a backup source is
not a success.  OpenRouter is funded (> $50); CT is holding a leftover stored halt
string.

2026-08-18: #2800 rebased onto current `main` (`cda485ff`, hybrid #2820 `ea68c1fc`).
The diagnosis still holds after hybrid processed writes landed.  Write-class stays
full-body.  Prune stays dry-run.  Do not raise a post-trial 2.5M/60k ceiling.

## Changes Made

The trial window used local month-to-date write units as if they were Pinecone's
bill.  When that counter implied the $300 credit was gone, `effectiveDailyWriteUnits`
became `min(configured, remainingWriteUnits)` — about 15 WU.  `applyPineconeWriteBudget`
then required `remaining >= estimated`, so a 28-WU document never started and used
stayed 0.  A 1-text ingest cap is the same class of park.

#2799 already stopped applying the Starter 2M monthly wall during the trial.  It did
not fix this daily remainder clamp.

- During an active trial, do not clamp the daily fuse to leftover local-MTD remainder.
- If local remaining dollars are at or below $1, treat that counter as untrusted and
  stay at the configured trial cap.  Pinecone 429s if credit is actually out.
- Floor trial daily WU at 2048 and ingest texts at 32 so one document can start.
- First document of a zero-used write window is accepted even when its estimate
  exceeds a collapsed cap.
- Ops snapshot now reports `pineconeIngest` (MTD, trial window, effective caps) and
  paints dependency `ok` from hard 5-streak only.
- Do not re-probe `vix-yahoo` while `vix-cboe` is serving.  Yahoo stays in
  `fetchKeylessVix` for when Cboe dies.

Touched files:

- `src/lib/pinecone-trial-window.ts`
- `src/lib/pinecone-write-budget.ts`
- `src/lib/vector-db.ts`
- `src/lib/db-health.ts`
- `src/lib/ops-snapshot.ts`
- `src/lib/health-lane-reprobe.ts`
- `src/lib/macro.ts`
- `test/pinecone-trial-window.test.ts`
- `test/pinecone-write-budget.test.ts`
- `test/vector-db-backlog-c-integration.test.ts`
- `test/health-lane-reprobe.test.ts`
- `test/ops-snapshot.test.ts`
- `docs/phase-7-strategy.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- Did not call Pinecone's org-month usage API.  The local counter is the lie; the
  vendor 429 is the real wall.
- Did not change Infisical knobs.  If `RAG_INGEST_MAX_TEXTS_PER_DAY` is literally 1
  in prod, the trial floor raises it to 32 until that env is restored.
- Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not `--apply` prune.  Hybrid
  processed writes from #2820 stay as they landed.
- Did not raise the configured 2.5M daily fuse or invent a new monthly cap.
  When local MTD looks spent, the fuse stays at the configured trial cap.
- Did not touch Congress.Trade.  The stored `error_class:billing (OpenRouter
  files-endpoint prepaid minimum…)` halt is leftover copy, not a live OpenRouter
  balance.  ST `openrouterCredits.ok` is true (threshold $3 only).
- "Expected ingest park" is retired language.  The skip was a bug.
- CI `vector-db-backlog-c-integration` used a 1-WU cap with used=0 as a stand-in
  for exhaustion.  That is the deadlock shape.  The test now seeds used>0 for a
  spent window, and a sibling case proves the first zero-used document starts.

## Verification State

```bash
npx tsc --noEmit
# exit 0
npm run lint
# exit 0 (errors only; grandfathered warnings remain)
npx vitest run \
  test/pinecone-trial-window.test.ts \
  test/pinecone-write-budget.test.ts \
  test/health-lane-reprobe.test.ts \
  test/ops-snapshot.test.ts \
  test/pinecone-monthly-pace.test.ts \
  test/pinecone-wu-breaker.test.ts
# 6 files / 46 passed
```

## Next Steps & Blockers

- After merge: confirm ops `pineconeIngest.trial.effectiveDailyWriteUnits` is the
  configured trial cap (millions, not 15) and that `filing-body-ingest` /
  `roic-transcript-refresh` write again.
- Congress.Trade: clear the leftover autopilot billing halt.  Do not diagnose
  OpenRouter prepaid-minimum again.
- If Cboe dies, Yahoo must still be tried.  That path is unchanged.

## Zero-Code Findings

- Live ST at triage: sha `4980322b`, Pinecone configured, rag-embed/rerank ok,
  `openrouterCredits.ok=true`, Litestream all five tiers healthy, `vix-cboe` ok,
  `vix-yahoo` degraded on soft 429 from health re-probes, not from the live cascade
  (Cboe success returns before Yahoo is called).
- CT `/api/health` pipeline still stalled on the stored prepaid-minimum string
  while House/Senate polling is live.  That string is not a balance check.
