# RAG / SEC advanced enablement (paid-tier operational)

## Context & Objective

Owner asked whether `SEC_FILING_INGEST_TTL_HOURS` was too long, and to run the clean-text corpus reindex if needed so every advanced RAG feature the current paid tiers can actually run is on.

## Changes Made

Live Infisical (ST prod) still had the 2026-08-10 emergency pause: `SEC_FILING_INGEST_TTL_HOURS` length 5 (`87600` / 10 years).  Claude re-enabled the worker + `SEC_FILING_RAG_MAX_PER_RUN=25` on 2026-08-12 but left that TTL in place, so `isFilingIngestDue` kept ingest dark.

Infisical prod (values verified by length only; no secret dump):

- `SEC_FILING_INGEST_TTL_HOURS` 5 → 2 (`24`)
- `VECTOR_EMBED_CLEAN_TEXT` missing → 2 (`on`)
- `RAG_MULTIQUERY` missing → 2 (`on`)
- `RAG_HYDE` missing → 2 (`on`)
- `RAG_EMBED_DISCLOSURES` 1 (`0`) → 2 (`on`)
- Left alone: `SEC_INGEST_WORKER_ENABLED` already `on`, `SEC_FILING_RAG_MAX_PER_RUN` already `25`, `VECTOR_EMBED_BATCH_DELAY_MS` already `0`, `RAG_EMBED_PROVIDER` `openrouter`

Code (this PR): catalog default TTL 168 → 24; Settings overrides now actually drive `VECTOR_EMBED_CLEAN_TEXT` / `RAG_MULTIQUERY` / `RAG_HYDE` (they used to be env-only while the UI wrote user settings).  Runtime still fails open to env if the settings store is down.

- `src/lib/source-settings-catalog.ts`
- `src/lib/web-sources/sec-filings.ts`
- `src/lib/vector-db.ts`
- `src/lib/rag/multi-query.ts`
- `src/lib/dormant-features.ts`
- `test/sec-filings.test.ts`
- `test/dormant-features.test.ts`
- `test/source-settings.test.ts`
- `.env.example`
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- 24h, not 6h: 6h was the Pinecone-trial drain.  24h is the documented paid cadence.  Keep `SEC_FILING_RAG_MAX_PER_RUN=25` (not 200) after the 2026-08-10 event-loop/litestream incident.
- Enable MULTIQUERY + HyDE: embeds are OpenRouter bge-m3 (~$0.0013/1k chunks); HyDE is one `gpt-5.4-mini` draft per pass; `RAG_RUN_BUDGET_ENABLED` stays on.
- Enable disclosure embed: parser path was already ready.
- Do **not** enable FMP transcript rights (needs a commercial rights agreement), `WEB_SOURCE_SEC8K_FULL_BODY` (FTS/event-loop budget), or `VECTOR_ASOF_STRICT` (needs as-of coverage proof).
- Do **not** `purge-legacy` after reindex until an unscoped run reports completed with zero failures.
- Retrieval filters by `embed_model`, not `embed_rev`, so flipping clean-text does not punch a recall hole.  Mixed rev=1/rev=2 cosine is slightly incomparable until reindex finishes.

## Verification State

- Infisical `has` lengths after write: TTL=2, CLEAN_TEXT=2, MULTIQUERY=2, HYDE=2, DISCLOSURES=2.
- Coolify `socratic-app` was already `running:healthy`; a main webhook deploy (`95fe0c2c`) was queued behind a usage-monitor build (concurrent_builds=1).  Infisical is pulled at container start, so the queued deploy is the pickup.
- Focused tests: `source-settings`, `sec-filings` TTL case, `dormant-features`, `rag-multi-query`, `vector-db-staleness-and-clean-text`.
- Full gate (`lint` / `tsc` / `test` / `build`) run before land.

## Follow-up (same session)

- Settings visibility toggle is now **Show Advanced Features** — it does not enable anything.
- ROIC max/run 12 → **20** (catalog + Infisical).  Free is 5 req/min so 20 is ~4 minutes; Individual is 300/min.
- EarningsCalls daily 8 → **12**.  The RapidAPI key is present; the real cap is still ~200 requests/month (180/195 ledgers).  12 is a larger daily sip, not a bigger plan.  Monthly/rolling budgets are now Settings knobs if the RapidAPI plan is actually larger.
- Coolify prod env is already Infisical-bootstrap-only.  Deleted leftover **preview** `HOSTNAME` + `NODE_OPTIONS` (previews retired).
- Public.com execution parked (`PUBLIC_EXECUTION_ENABLED` default off).  eToro connect disabled (no API access).  Webull connect disabled (later).

## Next Steps & Blockers

1. Wait for the queued `socratic-app` deploy to finish and `/api/health` to stay 200.
2. Confirm live `GET /api/admin/reembed` `activeEmbedRevision` is the clean-text (`v2-…`) space.
3. `POST /api/admin/reembed` (full corpus, no symbol scope, no purge).
4. Poll progress; do not purge rev-1 until completed + failed=0.
5. Watch `[slow-sync]` / health for a repeat of the 2026-08-10 event-loop pin now that ingest is due again.

## Zero-Code Findings

The 168h catalog default was a Voyage-free weekly pin, not a product requirement.  The live 87600h value was the 2026-08-10 pause and had never been restored.  Combined with a **global** `webSource:sec10k:lastAttempt` stamp (not per-symbol), one ingest attempt froze every symbol for the whole TTL.
