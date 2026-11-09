# 2026-08-21 — Honor 5M WU this week, snap to free-tier 2026-08-27

## Context & Objective

Owner changed monthly write units to 5M (Builder-shaped) after the 2M alert spam.  They want budgets/fuses to automatically drop to free/Starter in six days (`2026-08-27T00:00:00.000Z`).  Builder ($20, 10 GB / 5M WU hard cap) is maybe after this week if embed quality is good.  Full filings/transcripts stay on our server; Pinecone should hold condensed/highlights — expert panel is a sibling lane.

## Changes Made

- Infisical prod: `PINECONE_MONTHLY_WU_BUDGET=5000000`, `PINECONE_TRIAL_ENDS_AT=2026-08-27T00:00:00.000Z`.  Daily fuse stays 5M; texts/day stays 250k until the snap.
- During the remaining window, honor monthly budgets >= 5M.  Ignore leftover Starter 2M so it cannot park ingest.
- At calendar end, runtime snaps to 60k WU/day, 20k texts/day, 1.6M WU/month even if Infisical still holds 5M.  One storage_warning.  Retrieval ungated.
- A vendor 2M 429 while the app budget is 5M does not trip the breaker.  A 5M 429 does.
- `PINECONE_TRIAL_ENDS_AT=off` keeps Builder knobs after the calendar.

Touched: `src/lib/pinecone-trial-window.ts`, `src/lib/pinecone-monthly-pace.ts`, `src/lib/pinecone-wu-breaker.ts`, tests, `.env.example`, this note, STATUS/PLAN/EFFORT-LOG, `docs/audits/2026-08-22-panel-*.md`.

## Decisions & Trade-offs

- App-side snap, not an Infisical cron.  Coolify injects env at container start; only the app can change effective caps without a deploy on Aug 27.
- Did not flip `RAG_PINECONE_WRITE_CLASS`.  Did not prune.  Expert panel owns the condense-first recipe.

## Verification State

```bash
cd ~/apps/trading-grok-pinecone-free-snap
PATH=/opt/homebrew/opt/node@24/bin:$PATH ./node_modules/.bin/vitest run \
  test/pinecone-wu-breaker.test.ts \
  test/pinecone-monthly-pace.test.ts \
  test/pinecone-trial-window.test.ts
# 3 files / 34 passed
```

## Next Steps

- Owner-facing cut: `docs/audits/2026-08-22-panel-synthesis.md`.  This week: processed keep-set (highlights + signal + 8-K briefs + ROIC highlight-only), not a fat 10-K body pass.  Do not flip `RAG_PINECONE_WRITE_CLASS` until PR B hydrate is on main.
- Builder yes/no is measured Recall@8 / scout summary win-rate / live GB, not "trial dollars left."  Gates in the synthesis §5.
- To keep Builder past Aug 27: pay the plan, then set `PINECONE_TRIAL_ENDS_AT=off` in Infisical and restart.
