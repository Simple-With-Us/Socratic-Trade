# 2026-11-25 — ST-4673 Query-embed timeouts page hard

## Context & Objective

Sentry SOCRATIC-TRADE-1X ("OpenRouter embed connection failed") has 263 events since Aug 13, 12 in the two weeks to Nov 24.  Every recent event is operation `embed query` with reason `TimeoutError embed provider timed out`, tagged level error and failure class hard.  ST-4607 routed only `embed documents` provider timeouts to `reportRagEmbedDocumentsTimeout`, so retrieval timeouts still fell through to the hard `alertRagConnectionFailure` path.  That page fires inside `withRagApiHealth`, before the query path's SiliconFlow rescue runs.

## Changes Made

- `src/lib/vector-db.ts` — `alertRagConnectionFailure` sends `embed query` provider timeouts through `reportRagEmbedDocumentsTimeout` as well:  warning while the streak is inside the escalation window, error after it, fingerprint `rag/embed-timeout`.
- `test/rag-ingest-embed-timeout-classification.test.ts` — a retrieval query-embed timeout files as "RAG embed timed out" at warning, with no "connection failed" capture, no hard failure class and no "connection failed" notification.

## Decisions & Trade-offs

Query and document timeouts share one streak and one cooldown key per lane, because they hit the same provider lane.  Failures that carry an HTTP status, and ECONNREFUSED, keep the hard path unchanged.  Health rows were already soft for this text (`isSoftHealthFailure`), so only the Sentry and notification path changes.

## Verification State

CI `verify` runs lint, typecheck, the suite and the build.  Not run locally on this seat.

## Next Steps & Blockers

Touches `src/lib/vector-db.ts`, as does the ST-4674 PR (different function).  Jay merges after `verify` is green.  Do not auto-merge.
