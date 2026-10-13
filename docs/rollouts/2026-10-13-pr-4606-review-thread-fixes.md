# PR #4606 review thread fixes

## Context & Objective

Address eight open Sentry/Kody review threads on `fix/embed-fail-fast-congress-share-backoff`: embed circuit-breaker failure classification, abort timeout coverage through response bodies, content-cache metering, congress upstream half-open probe recovery, duplicate breaker warnings, embed cache validity, and Zod validation for search-fusion embed responses.

## Changes Made

- `src/lib/rag/embed-resilience.ts` — `countsTowardEmbedProviderFailure`, cache validity guards, single open warning via `wasAlreadyOpen`.
- `src/lib/vector-db.ts` — defer abort cancel until after body read; skip breaker trips for non-counted errors; `servedFromContentCache` + skip `meterEmbed`/`recordRagOperation` on hits.
- `src/lib/congress-share.ts` — upstream probe claim expiry, probe release in `finally`, duplicate upstream warn fix.
- `src/lib/rag/search-fusion.ts` — Zod embed response parse; filtered breaker failures.
- `test/embed-resilience.test.ts`, `test/congress-share.test.ts` — regression tests.

## Decisions & Trade-offs

- `EmbeddingResponseSchema` uses `passthrough()` on items so OpenRouter `id` metadata does not fail validation while `embedding` arrays stay strictly numeric.

## Verification State

```bash
npm test -- test/embed-resilience.test.ts
npm test -- test/congress-share.test.ts -t "logs upstream circuit"
npm test -- test/usage-compliance-classifier.test.ts -t "search-fusion"
npm run lint
npx tsc --noEmit
```

All commands above passed in the cloud worktree.

## Next Steps & Blockers

- Merge #4606 after hosted `verify` green.

## Zero-Code Findings

None.
