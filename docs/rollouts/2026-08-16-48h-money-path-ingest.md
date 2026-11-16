# 2026-08-16 — Rotation fail-open, Alpaca 422s, Red timeout, RAG ingest

## Context & Objective

Owner asked what "rotation fail-open" and "422s" mean, then to fix those plus Red Team timeouts and unstick SEC/ROIC/other RAG ingest.  Pinecone is on a Standard trial now; keep usage such that a later drop to free/builder is possible.

## What the words mean

**Rotation fail-open:** `__rotate__` asks OpenRouter `/models/user` which catalog models this key may call.  If that list times out or 429s, we used to serve the *entire* curated pool anyway ("fail open") so scheduled runs would not all abort.  That also served dead slugs (`moonshotai/kimi-latest`, `anthropic/claude-fable-latest`) that then 404'd.

**422:** HTTP 422 Unprocessable Entity.  Alpaca rejected limit orders on T at `24.865` / `24.855` because prices at or above $1 must be in $0.01 increments.

## Changes Made

- Fail-open still keeps rotation alive on `/models/user` timeout, but drops known-dead catalog ids (`kimi-latest`, `claude-fable-5`).
- Red Team uses `llmFetchCapturing` + `strategyLlmTimeoutMs` (same as Green).  Adversary output cap 2500 (was 1500).
- Alpaca REST/MCP/options limit and stop prices go through `roundAlpacaPrice` (>= $1 → pennies).
- Cherry-picked ROIC single-flight so 60s ticks cannot stack another universe walk.
- Requeue SEC `embed_queued` dead letters whose error is exactly "Ingestion budget or capacity exceeded mid-task" (~1k on prod).  A daily-fuse skip now defers 1h instead of dead-lettering.
- Worker `runTick` claims at most 5 tasks **across all running jobs** (`SEC_INGEST_TASKS_PER_TICK`).  Prod had 521 running jobs × 5 claims, so one tick leased thousands of `facts_extracted` rows and hung on `chunkDocument`; 2156 pending since 2026-08-10 never moved.
- Did not raise Pinecone daily/monthly caps.  Sibling #2748 parks incremental ingest when the 2.5M trial fuse is spent.

Touched:

- `src/lib/model-rotation.ts`
- `src/lib/red-team.ts`
- `src/lib/llm-request.ts`
- `src/lib/money.ts`
- `src/lib/alpaca.ts`
- `src/lib/db-rag-ingest.ts`
- `src/lib/rag/sec-ingest-worker.ts` (`SEC_INGEST_TASKS_PER_TICK` global claim cap)
- `src/lib/web-sources/roic-transcripts.ts` (cherry-pick)
- tests for the above
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Decisions & Trade-offs

- Did not empty the rotation pool on availability timeout (that aborted every run on 2026-08-13).  Only the two known-dead ids are dropped.
- Did not delete `kimi-latest` / `claude-fable-5` from the catalog UI — they still rotate when `/models/user` lists them as available.
- Did not steal #2748's fuse-park of ROIC/8-K/filings incremental lanes.
- Did not revive all SEC dead letters — only the misclassified budget error.

## Verification State

```bash
npx vitest run test/model-rotation.test.ts test/alpaca-limit-stop-price-guard.test.ts test/llm-request.test.ts test/red-team.test.ts test/sec-ingest-worker.test.ts test/roic-transcripts.test.ts
```

Full `land.sh` gate before the PR.

## Next Steps & Blockers

- After trial: drop `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` toward 60k and set `PINECONE_MONTHLY_WU_BUDGET` (owner/Infisical).
- #2748 should land so incremental lanes also park on the daily fuse.
- Dashboard Alpaca timeouts were already addressed in #2720 (retry dead sockets + health credits budget).

## Zero-Code Findings

Prod 2026-08-16: 1108 `embed_queued` dead_letter (almost all "Ingestion budget or capacity exceeded mid-task"); 212 `retry_wait` embed_queued (`fts_mirror_sliced` is healthy slice-resume); 2156 pending `facts_extracted`; 714 `roic-transcript-refresh` errors (stacked walks).  No stale SEC leases.
