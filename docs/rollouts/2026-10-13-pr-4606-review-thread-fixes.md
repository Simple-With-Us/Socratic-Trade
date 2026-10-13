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

- Provider embed responses use `.strip()`, not `.passthrough()` and not `.strict()`.  Kody asked for
  `.strict()` on the per-item object; that would reject real traffic — OpenRouter returns a per-item
  `id` and SiliconFlow returns a per-item `object`, so fail-closed on unknown keys would turn every
  live embed response into a `ZodError` and black-hole retrieval.  `.strip()` keeps the rule-22
  guarantee that matters (unknown keys are never *retained* or consumed downstream) while tolerating
  provider metadata.  Optional top-level `id` is declared explicitly for the same reason.

## Verification State

```bash
npm run lint -> ok (0 errors; warnings only)
npx tsc --noEmit -> ok
npm test -> ok
npm run build -> ok
```

Fast-to-slow order, one status per command.  Targeted runs during development:

```bash
npm test -- test/embed-resilience.test.ts test/congress-share.test.ts test/embedding-response-schema.test.ts -> ok (103 tests)
npm test -- test/usage-compliance-classifier.test.ts -t "search-fusion" -> ok (1 test)
```

## Next Steps & Blockers

- Merge #4606 after hosted `verify` green.

## Zero-Code Findings

None.
