# ST-4606 paid quote provider circuit breakers

## Context & objective

Production span failures were mostly paid quote providers returning HTTP 429 and HTTP 402 (PagerDuty #611, Linear ST-4606).  The quote fallback chain kept calling those providers, and each failed call became another span.

## Changes made

Paid quote lanes (`twelvedata`, `tiingo`, `marketstack`, `roic`) now open an in-memory hold on 429 and 402.  A 429 uses Retry-After when that header is present (capped at one hour) and exponential backoff when it is not (base 1s, cap 15 minutes).  A 402 holds the lane for six hours.  While the hold is cooling, `fetchWithRetry` throws `CircuitOpenError` before the fetch, and history fetchers return without calling the network.  That skip writes no health row and does not record a provider failure.  Enrichment and the Tiingo quote admit their local quota only after a cooling check, so a skip does not burn a credit.  The half-open probe is still one call after the hold elapses.  Other providers keep the existing retry, and a non-quote 429 opens the older hold only after retries are exhausted and only when Retry-After is present.  HTTP 402 on a paid quote lane is logged as a soft health row so it does not also paint a hard consecutive-failure streak.  Error bodies are cancelled on the retry and error paths in `fetchWithRetry`, `politeFetch`, and the Yahoo chart helper in `history.ts`.

Open holds are on `GET /api/health` as `checks.quoteProviderBreakers` and on `GET /api/ops/snapshot` as `quoteProviderBreakers`.  Neither field changes health `ok` or the 503 decision.  The public health view may include provider names and the lane key source (`env` or `user`).  It does not include secrets.

- `src/lib/api-circuit-breaker.ts`
- `src/lib/response-body.ts`
- `src/lib/data-providers.ts`
- `src/lib/history.ts`
- `src/lib/quotes-cascade.ts`
- `src/lib/web-sources/http.ts`
- `src/lib/web-sources/roic-financials.ts`
- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/health/route.ts`
- `test/quote-provider-circuit-breaker.test.ts`
- `test/setup-peer-lane-cleanup.ts`
- `STATUS.md`
- `PLAN.md`

## Decisions & trade-offs

- The hold reuses the existing in-memory lane map, keyed by service and key source, so one user's 402 does not close the env lane.
- Paid-quote 429 does not sleep inside the call.  The cascade falls through, and the hold is what stops the next symbol from calling the same provider.
- The first 429 or 402 still performs one network call.  Later calls in that process skip until the hold elapses.
- History paid providers stay on `politeFetch` (not the residential proxy) and share the same hold.  Yahoo chart retries in `history.ts` only cancel the body.  `src/lib/yahoo-finance.ts` is not edited.  `src/lib/proxy-fetch.ts` is not edited (ST-3999).
- Holds are process-local.  A restart clears them, and the next 429 or 402 opens them again.
- `API_CIRCUIT_BREAKER_DISABLED=1` still disables trips and skips.
- Vitest uses one worker, so the test setup clears the in-memory hold after every test.  A 402 hold would otherwise leak into the next file.
- No trading account, policy, or order-path change.

## Verification state

```bash
npx tsc --noEmit
npx eslint . --quiet
env -i PATH="$PATH" HOME="$HOME" npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

- `npx tsc --noEmit` exited 0.
- `npx eslint . --quiet` exited 0.
- Hermetic `npm test` (injected provider keys unset, matching CI): 902 files passed, 1 skipped, 10251 tests passed, 42 skipped.
- `npm run build` exited 0 with a 4 GB Node heap.  The default heap aborted during webpack.

## Next steps & blockers

- Open the PR against `main`.  Do not merge and do not enable auto-merge.
- `verify` CI is the gate.  Merge `origin/main` if it moves, without a force-push.

## Zero-code findings

None.  The breaker is implemented in this change.
