# 2026-06-19 - Data-source failure hardening

## Summary
Investigated the live Capitol Trades 503, Voyage vector-memory 429, and Massive S3
403 entitlement failures, then hardened the local paths that were causing avoidable
failures/noise. Follow-up in the same slice added a Massive Basic 5-calls/minute
REST budget so free-plan usage fails over instead of silently burning quota.

## Why
- Capitol Trades' public BFF currently returns HTTP 503 HTML from this server-side
  environment; the front-end site also hits a security checkpoint, so this is an
  upstream/CDN block rather than a parser bug. Senate eFD remains the authoritative
  working congressional source.
- Voyage vector storage was embedding too many SEC 8-K contexts in too few requests,
  which is incompatible with unpaid Voyage limits. After billing was added, a live
  `voyage-finance-2` probe succeeded; the app still keeps small caps to stay free or
  close to free.
- Massive REST grouped bars work, but flat-file S3 object GETs return
  `NOT_AUTHORIZED` 403 even with configured S3 credentials, indicating a plan or
  flat-file entitlement issue. The code still had a credential-ordering footgun, and
  Massive Basic's 5 REST calls/minute quota needed a local guard.

## Files
- `.env.example` - documented SEC 8-K RAG and vector embedding throttle knobs.
- `README.md` - documented the same operator knobs.
- `PLAN.md` - reflected paced/capped RAG ingestion as part of Phase 10 status.
- `docs/phase-9-web-sources.md` - clarified that Capitol Trades can be disabled with
  `WEB_SOURCE_CAPITOLTRADES_URL=off` when the secondary BFF is blocked.
- `docs/phase-10-signals-learning-ui-v2.md` - documented the Voyage/Pinecone hardening.
- `src/lib/vector-db.ts` - lowered default document batch size, trims context text,
  adds configurable inter-batch pacing, and retries Voyage 429s.
- `src/lib/web-sources/sec8k.ts` - caps SEC 8-K documents sent to vector memory per
  refresh via `WEB_SOURCE_SEC8K_RAG_LIMIT`.
- `src/lib/history.ts` - routes Massive per-symbol history through the shared REST
  budget and allows `MASSIVE_HISTORY_ENABLED=off`.
- `src/lib/market-signals/massive-s3.ts` - prefers `MASSIVE_SECRET_ACCESS_KEY` before
  the REST key for SigV4 signing.
- `src/lib/market-signals/massive.ts` - adds the shared Massive REST call budget,
  news caching, breadth date-probe cap, and updated S3 credential comments.
- `src/lib/web-sources/congress.ts` - allows disabling the Capitol Trades adapter with
  `off`/`false`/`disabled`/`none`.
- `test/history.test.ts` - covers the Massive-budget fallback path.
- `test/vector-db.test.ts` - added coverage for configured batching and 429 retry.

## Verification
- Live probe: Capitol Trades BFF returned HTTP 503 `text/html`.
- Live probe: `www.capitoltrades.com/trades` returned HTTP 429 `text/html` to the
  local non-interactive fetch path.
- Live probe: Voyage `voyage-finance-2` embedding succeeded with one 1024-dimension
  vector in about 0.4s after billing was updated.
- Live probe: Massive REST grouped bars for 2026-06-18 returned HTTP 200 with 12,299
  rows.
- Live probe: Massive S3 flat-file object GET returned HTTP 403
  `{"status":"NOT_AUTHORIZED","request_id":"","message":"forbidden"}` with both the
  dedicated S3 secret and the legacy REST-key fallback.
- `npx vitest run test/history.test.ts test/vector-db.test.ts test/web-sources-sec8k.test.ts`
  passed (19 tests).
- `npx tsc --noEmit` passed.
- `npm test` passed (226 tests across 30 files).
- `npm run build` passed.

## Follow-ups
- Keep Voyage/Pinecone for now: the official free token allowance and Pinecone starter
  storage should cover the current capped 8-K context workload. Revisit self-hosted
  vector storage if Pinecone storage approaches plan limits or if RAG expands to full
  filings/news/transcripts.
- User/account action: confirm Massive flat-file entitlement/access in the Massive
  dashboard or with Massive support; REST grouped bars remain the working bulk stock
  source.
- Data-source action: add a stable official House-disclosure parser or a paid
  congressional-trading provider if House coverage is required while Capitol Trades is
  blocked.
