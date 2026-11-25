# ST-4675: RAG ingest daily embed cap is now an Operations setting, default 40,000

Date: 2026-11-25
Linear: ST-4675 (follows ST-4609)
Sentry: SOCRATIC-TRADE-2E ("RAG ingest text budget reached")

## Why

The rolling 24h ingest cap (`RAG_INGEST_MAX_TEXTS_PER_DAY`) filled by about 12:21 UTC every day (19,917 of 20,000 windows used on Nov 24), so the "budget reached" alert fired daily and later ingest was skipped.  On 2026-11-25 the owner set the cap to 40,000 and asked that the number be adjustable in settings like the other operational variables.  This supersedes the ST-4609 note that the cap must not be raised.

## What changed

- `src/lib/server-knobs.ts`: new number knob `RAG_INGEST_MAX_TEXTS_PER_DAY` in the Budgets group of Admin > Operations.  Default 40,000, min 1, max 500,000.  Resolution is the usual DB override > Infisical/env > default.
- `src/lib/vector-db.ts`: `ingestMaxTextsPerDay()` reads the knob instead of the env-only `numericEnv` call, and the old 20,000 constant is gone.  The Pinecone free-tier text clamp (20,000) now applies only when ingest writes go to Pinecone.  Qdrant writes spend no Pinecone write units, so the clamp no longer holds the cap at 20,000 there.
- `src/lib/pinecone-trial-window.ts`: `pineconeTrialState()` takes the resolved cap as an optional third argument, so a Pinecone-backed deployment also honors the Operations override.
- `test/server-knobs.test.ts`: default, env, override and clamp coverage for the new knob.

## Cost

Each window is one embed request of up to about 7,500 tokens.  At the bge-m3 price recorded in `src/lib/rag-metering.ts` ($0.01 per million tokens, recorded in July), 40,000 full windows is at most about $3 a day, and most windows are smaller.

## Rollout

1. Merge and deploy.
2. Check Admin > Operations > Budgets.  The new row shows its value and source.  If the source reads "env" with 20,000, Infisical still holds the old number: set 40,000 there or save an override on the row.
3. Watch SOCRATIC-TRADE-2E.  It should stop firing daily.

## Rollback

Save a lower value on the Operations row (takes effect on the next ingest call), or revert this PR.
