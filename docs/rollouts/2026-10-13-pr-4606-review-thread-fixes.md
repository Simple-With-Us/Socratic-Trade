# PR #4606 review thread fixes

## Context & Objective

Address eight open Sentry/Kody review threads on `fix/embed-fail-fast-congress-share-backoff`: embed circuit-breaker failure classification, abort timeout coverage through response bodies, content-cache metering, congress upstream half-open probe recovery, duplicate breaker warnings, embed cache validity, and Zod validation for search-fusion embed responses.

## Changes Made

- `src/lib/rag/embed-resilience.ts` — `countsTowardEmbedProviderFailure`, cache validity guards, single open warning via `wasAlreadyOpen`.
- `src/lib/vector-db.ts` — defer abort cancel until after body read; skip breaker trips for non-counted errors; `servedFromContentCache` + skip `meterEmbed`/`recordRagOperation` on hits.
- `src/lib/congress-share.ts` — upstream probe claim expiry, probe release in `finally`, duplicate upstream warn fix.
- `src/lib/rag/embedding-response-schema.ts` — shared strip-mode Zod schema for provider embed JSON (vector-db + search-fusion).
- `src/lib/rag/search-fusion.ts` — shared schema parse; `settleEmbedProviderAttempt` on errors.
- `test/embed-resilience.test.ts`, `test/congress-share.test.ts`, `test/embedding-response-schema.test.ts` — regression tests.

## Decisions & Trade-offs

- Provider embed responses use `.strip()` (Kody rule 22), not `.passthrough()`; optional top-level `id` is declared so OpenRouter metadata validates without retaining unknown keys.

## Verification State

```bash
npm run lint          # PASS (0 errors; warnings only)
npx tsc --noEmit      # PASS
npm test -- test/embed-resilience.test.ts test/congress-share.test.ts test/embedding-response-schema.test.ts  # PASS (103 tests)
npm test -- test/usage-compliance-classifier.test.ts -t "search-fusion"  # PASS (1 test)
npm run build         # PASS
```

Full gate outputs captured on the Kody follow-up commit in the cloud worktree.

## Next Steps & Blockers

- Merge #4606 after hosted `verify` green.

## Zero-Code Findings

None.
