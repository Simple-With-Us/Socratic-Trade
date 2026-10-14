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

## Round 2 (Kody, `settleEmbedProviderAttempt` asymmetric reset)

- **Context:** a late Kody thread flagged that a 4xx half-open probe cleared `probeInFlight` and
  `openUntil` but not `consecutive`, so the stale trip value let the very next counted failure
  re-open the breaker and re-log `embed circuit open` after a single fresh failure.
- **Confirmed real** with a standalone repro before touching anything (warn fired twice where the
  test expected once).
- **Fix:** `state.consecutive = 0` inside the `if (hadProbe)` block, mirroring
  `noteEmbedProviderSuccess`.  A 4xx is a client-side rejection, not provider ill-health, so the
  half-open probe should hand back a fully closed breaker.
- **Test:** new `fully resets the breaker after a 4xx half-open probe settles` case asserts
  `EMBED_BREAKER_FAILURES - 1` further counted failures do not re-trip, the Nth does, and no second
  `console.warn` fires early.

Files touched this round:

- `src/lib/rag/embed-resilience.ts` — `settleEmbedProviderAttempt` `hadProbe` branch.
- `test/embed-resilience.test.ts` — new regression test.

## Decisions & Trade-offs

- Provider embed responses use `.strip()`, not `.passthrough()` and not `.strict()`.  Kody asked for
  `.strict()` on the per-item object; that would reject real traffic — OpenRouter returns a per-item
  `id` and SiliconFlow returns a per-item `object`, so fail-closed on unknown keys would turn every
  live embed response into a `ZodError` and black-hole retrieval.  `.strip()` keeps the rule-22
  guarantee that matters (unknown keys are never *retained* or consumed downstream) while tolerating
  provider metadata.  Optional top-level `id` is declared explicitly for the same reason.

## Verification State

```bash
npm run lint -> ok (0 errors; 866 grandfathered warnings)
npx tsc --noEmit -> ok
npm test -> 13 pre-existing failures, all LLM credential-routing files; identical on the base commit (see below)
npm run build -> ok
```

Fast-to-slow order, one status per command.  Targeted runs during development:

```bash
npx vitest run test/embed-resilience.test.ts -> ok (10 tests, 9 pre-existing + 1 new reset case)
npm test -- test/embed-resilience.test.ts test/congress-share.test.ts test/embedding-response-schema.test.ts -> ok (103 tests)
npm test -- test/usage-compliance-classifier.test.ts -t "search-fusion" -> ok (1 test)
```

Round 2 full-suite receipt (this branch, `npm test`): `Test Files 4 failed | 816 passed | 1 skipped (821)`,
`Tests 13 failed | 9243 passed | 51 skipped (9307)`.  All 13 failures are in `test/chat-llm.test.ts`,
`test/llm-provider.test.ts`, `test/openrouter-credits.test.ts`, and `test/framework-review.test.ts` —
LLM credential-routing cases unrelated to this diff.  Confirmed pre-existing by re-running exactly
those four files against a clean `git stash` of the base commit: byte-identical `4 failed / 13 failed`.
Not introduced by this change.

## Next Steps & Blockers

- Merge #4606 after hosted `verify` green.

## Zero-Code Findings

None.
