# 2026-11-25 — ST-4674 Ingest embed 8-second timeout

## Context & Objective

Sentry SOCRATIC-TRADE-3T ("RAG embed timed out") logged 50 warning-level events from Nov 12 to Nov 21, all operation `embed documents`.  Since ST-4607 these are warnings by design, but each one is an ingest batch that was not embedded.  Every embed attempt shared `DEFAULT_EMBED_CALL_TIMEOUT_MS` (8 seconds), a budget sized for one short query string, while one packed document request carries up to 7,500 tokens.

## Changes Made

- `src/lib/rag/embed-resilience.ts` — `DEFAULT_EMBED_DOCUMENT_CALL_TIMEOUT_MS` (20 seconds), `embedDocumentCallTimeoutMs()` (env `EMBED_DOCUMENT_CALL_TIMEOUT_MS`, never below the query budget) and `embedAttemptTimeoutMs(inputType)`.
- `src/lib/vector-db.ts` — `embedWithRetry` passes `embedAttemptTimeoutMs(inputType)` to `createEmbedAttemptAbort`.
- `test/embed-resilience.test.ts` — budget per input type, env override and the floor.

## Decisions & Trade-offs

Queries keep 8 seconds, so strategy runs still fail fast and the SiliconFlow rescue still gets its turn.  Only document embeds wait longer, and abort/timeout is still not retried, so a slow provider costs at most 20 seconds per ingest request.  That OpenRouter needs more than 8 seconds for a full batch is inferred from the event pattern, not measured.

## Verification State

CI `verify` runs lint, typecheck, the suite and the build.  Not run locally on this seat.

## Next Steps & Blockers

Touches `src/lib/vector-db.ts`, as does the ST-4673 PR (different function).  Jay merges after `verify` is green.  Do not auto-merge.
