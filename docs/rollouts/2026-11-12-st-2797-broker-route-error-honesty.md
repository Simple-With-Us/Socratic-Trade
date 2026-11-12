# ST-2797 — Broker-backed route API error honesty

## Context & Objective

Broker-backed GET routes threw uncaught gateway errors into Next's generic 500 page, and several JSON POST routes surfaced malformed bodies as 500.  This work adds one shared JSON error envelope so the web console and iOS can distinguish broker outages from server bugs.

## Changes Made

- Added `src/lib/api-error.ts` with `jsonError`, `brokerReadError`, and `parseRequestJson`.
- Wrapped broker reads on `app/api/positions`, `app/api/orders`, `app/api/portfolio`, and `app/api/accounts`.
- Standardized malformed JSON handling on `app/api/policy` PUT, `app/api/keys` POST, and `app/api/orders/cancel` POST; cancel maps unexpected broker failures to `brokerReadError` without changing cancel preconditions.
- Added `test/broker-route-error-honesty.test.ts`; updated `test/api-security-hardening.test.ts` for the cancel envelope.

## Decisions & Trade-offs

- Left success response bodies unchanged on broker GET routes; kept existing plain-text 400 for "No selected account."
- Did not touch `app/api/history`, `app/api/quote`, or `app/api/watchlist` (open PR #5138).
- Broker auth and outage messages are generic HTTP-status summaries only — no upstream body passthrough.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/broker-route-error-honesty.test.ts test/api-security-hardening.test.ts
npm test
npm run build
```

## Next Steps & Blockers

- Merge after PR `verify` is green; no deploy action from agent.

## Zero-Code Findings

None.
