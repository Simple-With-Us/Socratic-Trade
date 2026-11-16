# ST-4631 — Session auth and a rate limit on GET /api/market/flatfile

## Context & Objective

`GET /api/market/flatfile` downloads every ticker's daily bar for one date from Massive REST or S3.  Sibling `/api/market/*` read routes reject a missing credential in the handler and call `enforceRateLimit`.  Flatfile only called `resolveRequestUserId`, which falls back to the dev user when no session is attached, so a request that reached the handler could stampede the upstream.  Middleware already keeps this path off the peer-bearer pass-through.  This change puts a session refusal and a throttle in the handler without opening the route to `APP_B_INGEST_TOKEN`.

## Changes Made

The handler returns 401 unless middleware attached a session identity (Auth.js, Cloudflare Access, or the auth-unconfigured local fallback).  A peer bearer is not that identity.  A valid session is then limited to 6 requests per minute per user (`RATE_LIMITS.flatfile`, route key `market/flatfile`) before `fetchGroupedBarsRest` or `fetchGroupedDailyBars`.  A malformed date is still 400 and does not spend the limit or call upstream.  The bar payload is unchanged.

Files:

- `app/api/market/flatfile/route.ts`
- `src/lib/rate-limit.ts`
- `test/flatfile-route-auth.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-11-12-st-4631-flatfile-rate-limit-auth.md`

## Decisions & Trade-offs

- Did not call `verifySecuritiesImportToken` as the allow check.  That check is how the peer routes accept `APP_B_INGEST_TOKEN`.  Using it here would let a missed middleware matcher serve the whole tape to the peer bearer.  The in-handler 401 is the session check, and the failure body matches the other market reads (`{ ok: false, error: "unauthorized" }`).
- Did not add `/api/market/flatfile` to `isPeerMarketReadPath`.
- The limit matches the grouped-daily refresh cap (6 per minute) rather than the 120/min peer-read cap, because one call is the whole market.  It is keyed by the session user id, not the shared `peer-app` bucket, so a flatfile burst does not consume Congress.Trade's peer-read allowance.
- Local fallback remains a session so an auth-unconfigured dev boot that middleware already marks `local-fallback` can still read.  A request with no identity headers cannot.
- No phase doc owns this route.  This note is the record.  No order, sizing, or risk-gate change.

## Verification State

Node 26 (`v26.13.1`).  Before the handler change, `npx vitest run test/flatfile-route-auth.test.ts` failed three tests: a request with no session returned 200, a valid `APP_B_INGEST_TOKEN` bearer returned 200, and `RATE_LIMITS.flatfile` was missing.  After the change that file passed, along with `test/rate-limit.test.ts` and `test/market-read-routes.test.ts` (52 tests).  The existing middleware assertion that a bearer does not bypass `/api/market/flatfile` still passes.

Full gate, in order:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` passed with 0 errors and 869 grandfathered warnings.  `npx tsc --noEmit` passed.  `npm test` finished 10255 passed, 17 failed, 41 skipped (905 files; 11 failed).  The 17 failures are outside this change: they expect no provider key or a GitHub credential, and this VM already has those (OpenAILLM where the test wants MockLLM, `llm_error` where it wants `no_llm_key`, and the Kody check-run lookup).  None of the failed files touch flatfile auth.  The first `npm run build` aborted at the default heap (exit 134, JavaScript heap out of memory near 2 GB).  A retry with `NODE_OPTIONS=--max-old-space-size=8192` completed, including `stamp-csp-static-hashes`.  There is no Sentry issue for this gap.

## Next Steps & Blockers

Open one PR against `main`.  Do not merge, do not enable auto-merge, and do not deploy.  Linear ST-4631 stays In Progress until that PR merges.

## Zero-Code Findings

None.  The missing handler gate was confirmed by reading `app/api/market/flatfile/route.ts` and by the red tests above.
