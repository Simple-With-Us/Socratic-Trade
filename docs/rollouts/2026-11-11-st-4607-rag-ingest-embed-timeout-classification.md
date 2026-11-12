# ST-4607 — Classify ingest embed provider timeouts

## Context & Objective

Production ingest (`embed documents` on the rag-embed lane) was still capturing OpenRouter `TimeoutError` / `embed provider timed out` as hard `OpenRouter embed connection failed` events (Sentry SOCRATIC-TRADE-1X) after ST-4601 fixed only the strategy retrieval deadline path.  This change classifies provider-side document-embed timeouts as `failureClass: timeout` at warning level so they do not page like a broken integration, with bounded escalation after sustained timeouts.

## Changes Made

- `src/lib/rag/embed-resilience.ts` — `isRagEmbedProviderTimeout` / `isRagEmbedProviderTimeoutText` reuse the abort/timeout helpers from ST-4601 / network-errors (distinct from strategy deadline).
- `src/lib/vector-db.ts` — `reportRagEmbedDocumentsTimeout` short-circuits `alertRagConnectionFailure` for `embed documents`; Sentry fingerprint `rag/embed-timeout`; soft health rows; escalation after `HEALTH_TRANSIENT_ESCALATION_MS` on a consecutive timeout streak.
- `src/lib/db-health.ts` — `connectionHealthFailureClass` maps ingest timeout text to `timeout`.
- Tests: `test/rag-ingest-embed-timeout-classification.test.ts`, cooldown key in `test/rag-sentry-cooldown-key.test.ts`.

## Decisions & Trade-offs

- Scoped to operation `embed documents` only (ingest).  Query-embed retrieval keeps existing paths.
- ECONNREFUSED and HTTP 5xx after retries stay on the hard / transient-network ladder unchanged.
- No change to chunking, storage, budgets, dedup, or ingest requeue behavior.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Focused: `npm test -- test/rag-ingest-embed-timeout-classification.test.ts test/rag-sentry-cooldown-key.test.ts`.

## Next Steps & Blockers

- Open PR against `main`.  Do not merge or auto-merge.  Jay merges after `verify` is green.

## Zero-Code Findings

- Soft health rows do not populate `streakStartedTs` for hard-failure walks; embed-timeout escalation walks `api_health_log` for consecutive `embed provider timed out` rows instead.
- Embed-timeout Sentry cooldown anchors at streak start only while still in the warning window (parity with transport-blip `:transient` keys); after escalation it stores `now` and uses the one-hour connection-alert cooldown so error-level pages do not repeat on every ingest.
