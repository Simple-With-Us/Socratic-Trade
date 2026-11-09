# 2026-08-21 — Stop paging Starter 2M write units on a Standard trial

## Context & Objective

Owner: raise/ignore Pinecone monthly write units and stop the "max 2M write units has been reached" notifications.  Live org is a Standard trial ($300, 21 days from 2026-08-09 — Pinecone welcome mail).  Standard has unlimited write units.  Infisical already has `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY=5000000` and no `PINECONE_MONTHLY_WU_BUDGET` (off).  #2799 ignored the 2M wall only when the matcher hit.

The matcher required the word `429` *in the error body*.  Pinecone's documented text is the monthly-quota phrase plus HTTP 429; the SDK often omits `Status: 429` from the message.  Those 429s fell through to hourly `Pinecone connection failed` plus a usage-limit page.  That is why "ignore" still paged.

## Changes Made

- Treat "write unit limit for the current month" as monthly WU exhaustion even without `429` in the body.  Generic per-second 429s stay unmatched.
- Breaker trips only when an app monthly budget is configured.  Trial or `PINECONE_MONTHLY_WU_BUDGET=0` (pay-as-you-go): no park, no storage_warning.
- `alertRagConnectionFailure` returns on monthly-WU text so a matcher miss cannot hourly-page.
- After the trial calendar, keep Infisical knobs.  Do not snap to Starter 60k/day and 1.6M/month (that invented the 2M wall again).
- Infisical prod: set `PINECONE_MONTHLY_WU_BUDGET=0` so the name is explicit.

Touched:

- `src/lib/pinecone-wu-breaker.ts`
- `src/lib/pinecone-trial-window.ts`
- `src/lib/pinecone-monthly-pace.ts`
- `src/lib/vector-db.ts`
- `test/pinecone-wu-breaker.test.ts`
- `test/pinecone-trial-window.test.ts`
- `test/embed-stage.test.ts`
- `.env.example`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- Did not change Pinecone console billing.  API key cannot upgrade Starter → Standard; the org already has a Standard trial.  If Pinecone itself still 429s at 2M on that trial, that is a vendor quota bug — ST will retry instead of paging and parking.
- Did not raise `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` (already 5M in Infisical).
- Breaker still parks when someone *sets* a monthly budget (Builder 5M → set ~4M).  Off means continue.

## Verification State

```bash
cd ~/apps/trading-grok-pinecone-wu
PATH=/opt/homebrew/opt/node@24/bin:$PATH ./node_modules/.bin/vitest run \
  test/pinecone-wu-breaker.test.ts \
  test/pinecone-monthly-pace.test.ts \
  test/pinecone-trial-window.test.ts \
  test/embed-stage.test.ts
# 4 files / 43 passed
```

## Next Steps & Blockers

- Merge → Coolify auto-deploy.  Confirm Pushover stops repeating 2M / Pinecone connection failed for upserts.
- After trial (Pinecone ~2026-08-30): stay on Standard ($50 min, unlimited WUs) or set `PINECONE_MONTHLY_WU_BUDGET` only if you drop to Builder (5M hard cap).
