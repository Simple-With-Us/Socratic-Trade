# ST-4606 paid quote provider circuit breakers

## Context & objective

Production span failures were mostly paid quote providers returning HTTP 429 and HTTP 402 (PagerDuty #611, Linear ST-4606).  The quote fallback chain kept calling those providers, and each failed call became another span.

## Changes made

Paid quote lanes (`twelvedata`, `tiingo`, `marketstack`, `roic`) retry an HTTP 429 for the remaining budget and honor a positive Retry-After.  The hold opens only after that budget is spent, and only for that Retry-After duration (capped at one hour).  A 402 holds the lane for six hours.  While the hold is cooling, `fetchWithRetry` throws `CircuitOpenError` before the fetch, and history fetchers return without calling the network.  That skip writes no health row and does not record a provider failure.  Enrichment and the Tiingo quote admit their local quota only after a cooling check, so a skip does not burn a credit.  The half-open probe is still one call after the hold elapses.  Other providers keep the existing retry, and a non-quote 429 opens the older hold only after retries are exhausted and only when Retry-After is present.  HTTP 402 on a paid quote lane is logged as a soft health row so it does not also paint a hard consecutive-failure streak.  Error bodies are cancelled on the retry and error paths in `fetchWithRetry`, `politeFetch`, and the Yahoo chart helper in `history.ts`.

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
- A paid-quote 429 or 402 is stored on the credential fingerprint when the caller has one.  The public list still shows `env` or `user`, not the fingerprint.  `API_CIRCUIT_BREAKER_DISABLED=1` also restores the in-call 429 retry for these four providers.  Twelve Data's HTTP 200 credit message opens the six-hour 402 hold.  `GET /api/health` sets `checks.quoteProviderBreakersError` to `unavailable` when the list cannot be read, and that field does not change `ok`.
- A header-less 429 does not open a hold.  The in-call retry spends the remaining budget, and the next symbol is blocked only when a positive Retry-After or an HTTP 402 opened the lane.  The quote path and the history path both cap that Retry-After at one hour.  A Twelve Data credit or quota body opens the six-hour hold and is a soft health row.  A rate-limit phrase stays a soft signal and does not open a 429 hold.
- A 402 still performs one network call, then later calls skip until the hold elapses.
- History paid providers stay on `politeFetch` (not the residential proxy) and share the same hold.  Yahoo chart retries in `history.ts` only cancel the body.  `src/lib/yahoo-finance.ts` is not edited.  `src/lib/proxy-fetch.ts` is not edited (ST-3999).
- Holds are process-local.  A restart clears them, and the next 429 or 402 opens them again.
- `API_CIRCUIT_BREAKER_DISABLED=1` still disables trips and skips.
- Vitest uses one worker, so the test setup clears the in-memory hold after every test.  A 402 hold would otherwise leak into the next file.
- A later response cannot shorten a hold that is already open.  A longer Retry-After or a 402 still extends it.  The old per-credential strike map is gone, because the hold length comes from Retry-After and nothing read the count.
- The cooling check looks at the credential fingerprint first, then the plain key-source lane, matching the skip check.  A consecutive-failure hold on the plain lane therefore skips before `admitProviderRequests`.
- `API_CIRCUIT_BREAKER_DISABLED=1` still disables trips and skips.  A paid-provider 402 stays a soft health row while the switch is on.
- A Twelve Data minute or rate-limit body does not open a 429 hold.  A day or unscoped credit message still opens the six-hour 402 hold.
- Suppressing 429 on a paid-quote caller still skips that lane's hold.  The same suppression on a non-quote provider only drops the health row.  The older rate-limit hold still opens when Retry-After is present.
- The in-call Retry-After wait, in `fetchWithRetry` and paid history, uses the same one-hour cap as the hold.
- A ROIC history page with one non-object row keeps the other bars.  `next_page_url` of an unexpected type stops pagination instead of throwing away the bars already collected.
- ROIC profile enrichment passes `retries: 0` because it reserves one provider request.  A transcript fetch reserves one call, then one more call when that response is HTTP 429 and `Retry-After` is at most 5 seconds.  A longer header skips the second call and holds later transcript calls for that credential until Retry-After expires, capped at one hour.  A 402 holds those transcript calls for the six-hour quota window.  The hold is the credential, it drops expired entries, and API_CIRCUIT_BREAKER_DISABLED turns it off.  That hold does not open the quote lane.  The identifier loop does not sleep.  The wait is outside the ROIC limiter.  A missing or zero Retry-After waits 600 ms.  429 stays suppressed, so that retry does not open the quote lane.  Ratios already used `retries: 0`.
- `src/lib/web-sources/roic-transcripts.ts` and `src/lib/web-sources/roic-financials.ts` import `server-only`.
- Paid history retries one 5xx, one network error, and one 429.  A 402 is not retried.  The lane stays per credential, because a 402 on these keys is account credit rather than one endpoint.  Plan-gated ROIC transcripts, financials, and ratios do not open the quote lane on 402 or 429.
- No trading account, policy, or order-path change.

## Verification state

```bash
npx tsc --noEmit
npx eslint . --quiet
env -i PATH="$PATH" HOME="$HOME" npm test
NODE_OPTIONS=--max-old-space-size=4096 npm run build
```

- GB-Fixer (2026-11-12): merged `origin/main`; resolved `app/api/health/route.ts` import conflict (`listOpenApiCircuitBreakers` + `TRADING_LIVENESS_FLEET_DARK_ACCOUNT_KEY`).  Re-ran `npm run lint`, `npx tsc --noEmit`, and `npx vitest run test/quote-provider-circuit-breaker.test.ts test/history.test.ts` — all exited 0 (48 tests).
- The quote-breaker suite captures `API_CIRCUIT_BREAKER_DISABLED` and the quote hold env vars before the file runs, then restores those values in `afterEach`.
- Follow-up review (2026-11-12): `npx tsc --noEmit` and `npm run lint` exited 0.  `npx vitest run test/quote-provider-circuit-breaker.test.ts test/history.test.ts test/roic-transcripts.test.ts test/roic-financials.test.ts test/roic-archive-resume.test.ts test/pinecone-write-class.test.ts` exited 0.  `NODE_OPTIONS=--max-old-space-size=4096 npm run build` exited 0.
- `npx tsc --noEmit` exited 0.
- `npx eslint . --quiet` exited 0.
- Hermetic `npm test` (injected provider keys unset, matching CI): 902 files passed, 1 skipped, 10256 tests passed, 42 skipped.
- `npm run build` exited 0 with a 4 GB Node heap.  The default heap aborted during webpack.

PagerDuty #611 is the existing Sentry HTTP trace failure rate (`tracesSampleRate` in `sentry.server.config.ts`, default 0.2).  This change adds no new metric and no alert.  A cooling skip returns before `fetch`, so that call does not open a failed HTTP span.  After deploy, the same PagerDuty #611 signal is the check that the rate falls.  Open holds stay on `GET /api/health` and `GET /api/ops/snapshot`.

## Next steps & blockers

- The review findings are addressed on the open PR.  Do not merge and do not enable auto-merge.
- `verify` CI is the gate.  Merge `origin/main` if it moves, without a force-push.

## Zero-code findings

None.  The breaker is implemented in this change.
