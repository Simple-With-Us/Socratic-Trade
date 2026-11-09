# 2026-08-16 — Litestream L1 suffix, FilingAPI key, ROIC universe transcripts

## Context & Objective

Owner asked to actually resolve the Litestream L2/L3 empty wedge (not just detect it), fix FilingAPI using the key in `~/.secrets/global-api-keys` (mint a new one if that key is dead), and ingest ROIC.ai earnings calls as thoroughly as possible for the trading universe, including useful history, stored so an LLM can see many of them quickly and accurately.

## Changes Made

- **Litestream (ops):** Confirmed live `compaction failed` with the exact hole `(431e5-43206) -> (43225-43247)`.  B2 L1 had 5959 objects, 18 holes, 11 same-MaxTXID twins.  Deleted the non-contiguous prefix plus twins so Compact walks only the newest contiguous suffix (starts `4a86-4aa5`).  Did not touch L0, L2, L3, or L9.
- **FilingAPI:** Handoff `FILINGAPI` and Infisical `FILINGAPI` are the same 32-char value.  `GET /v1/company/AAPL` with `X-API-Key` returns 401 `Invalid API key`.  Public `/api/health` still said `ok: true` because there is no live probe and the 401 streak had been softened.  Vendor `POST /v1/signup/free` returns 429 `Free trial already claimed` for the owner's known emails.  Added a real re-probe so STOPPED/401 is honest.  Env keys are now trimmed so a Coolify newline cannot 401 a good key.
- **ROIC transcripts:** Retrieval now admits `source=roic-earnings-transcript` when the ROIC key is on (FMP rights / EarningsCalls no longer hide them).  Ingest is list-first, skip-if-stored, speaker-section chunks plus an extractive `earnings-summary` digest.  Universe is holdings, then watchlists, technical watchlist, each user's policy indices, then the 1k RAG manifest.  Individual depth is 20 quarters (the hidden env cap of 8 is gone).  A cursor continues mid-universe instead of sleeping 24h after 20 fetches.  Infisical `ROIC_TRANSCRIPTS_MAX_PER_RUN` set to 120.

### Files

- `src/lib/roic-transcripts-gate.ts` (new)
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/vector-db.ts`
- `src/lib/chat/orchestrator.ts`
- `src/lib/strategy.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/source-settings-catalog.ts`
- `src/lib/source-capability-matrix.ts`
- `src/lib/health-lane-reprobe.ts`
- `test/roic-transcripts.test.ts`
- `test/vector-db-retrieval.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Did not upgrade Litestream past 0.5.12 (tcp_mem).  Did not add `verify-compaction: true`.
- Did not start a Stripe Plus checkout for FilingAPI.  Free trial is claimed; a paid key is an owner dashboard action.  Code is ready the moment a live key is in Infisical `FILINGAPI`.
- ROIC Individual history is 20 quarters (vendor limit).  Professional would be 40.  Calendar walk is only the fallback when the list endpoint is empty.
- Retrieval enablement is env-key based (cycle-safe leaf).  Production has `ROIC_API_KEY` in Infisical.

## Verification State

```bash
cd ~/apps/trading-grok-ops-roic
./node_modules/.bin/vitest run test/roic-transcripts.test.ts test/vector-db-retrieval.test.ts test/provider-tier-plan.test.ts
# 53 passed
```

FilingAPI probe (length/status only): handoff=Infisical, HTTP 401, 28-byte `Invalid API key`.  Live compaction log matches the first L1 hole.

## Next Steps & Blockers

- Confirm L2 fileCount >= 1 within one 5-minute compaction after the L1 delete finishes.  L3 should follow within an hour.
- Owner: mint or upgrade FilingAPI at https://filingapi.dev (Plus checkout) and put the new value in Infisical `FILINGAPI`.  Do not leave a stale Connections row that shadows env.
- After deploy: ROIC scheduler walks the universe via the cursor.  Watch Pinecone WU; the producer parks on `wuExhausted` and does not mark those calls ingested.

## Zero-Code Findings

- #2709 only classified the empty L2.  The 2026-08-13 surgical delete left hole `a03c-a04a` (and later holes including `43207-43224`), so Compact never produced L2 again.
- FilingAPI public health green is a streak/soften artifact, not a live 200.
