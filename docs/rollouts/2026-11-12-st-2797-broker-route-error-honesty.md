# ST-2797 — Broker-backed route API error honesty

## Context & Objective

Broker-backed GET routes threw uncaught gateway errors into Next's generic 500 page, and several JSON POST routes surfaced malformed bodies as 500.  This work adds one shared JSON error envelope so the web console and iOS can distinguish broker outages from server bugs.

## Changes Made

- Added `src/lib/api-error.ts` with `jsonError`, `brokerReadError`, and `parseRequestJson`.
- Wrapped broker reads on `app/api/positions`, `app/api/orders`, `app/api/portfolio`, and `app/api/accounts`.
- Standardized malformed JSON handling on `app/api/policy` PUT, `app/api/keys` POST, and `app/api/orders/cancel` POST; cancel maps unexpected broker failures to `brokerReadError` without changing cancel preconditions.
- `parseRequestJson` answers a body that cannot be read at all (stream error, body already consumed) with 400 `unreadable_body` instead of rethrowing, and logs the sanitized error (`console.error` plus Sentry `captureException` of a new Error that carries only the sanitized message, not the raw exception).  `app/api/keys` POST, `app/api/orders/cancel` POST and `app/api/policy` PUT all parse through it, so none of them falls through to an unhandled 500.
- Broker-backed GET routes (`accounts`, `positions`, `orders`, `portfolio`) keep the classified broker envelope; any other fault (an adapter defect such as a `TypeError`) is logged and answered as a 500 `internal_error` envelope.  `app/api/orders/cancel` keeps rethrowing non-broker faults so cancel behaviour is unchanged.
- Added `test/broker-route-error-honesty.test.ts`; updated `test/api-security-hardening.test.ts` for the cancel envelope.
- PUT `/api/policy` validates the body with a strict `PolicyUpdateSchema` after `parseRequestJson`; unknown keys or wrong field types return 400 `invalid_payload`. Domain validation after a successful parse is unchanged.
- GET `/api/history` resolves identity before the provider `try`. Provider/gateway failures return 502 `broker_unavailable` and are reported via `reportHandledError`. Identity denials stay 401, and local faults (SQLite, adapter defects) stay 500 `internal_error`. An empty-but-successful provider response is still 200 with `bars: []`.
- `isBrokerGatewayError` / `extractHttpStatusFromMessage` recognise eToro adapter messages (`No eToro account connected.`, `eToro keys are missing`, `eToro /me 500`).
- `reportHandledError` calls `Sentry.captureException` with a new Error that carries only the sanitized message (original error name and a rewritten stack; no raw `cause`), so handled faults reach Sentry without enabling `enableLogs` and without leaking upstream bodies or credentials.

## Decisions & Trade-offs

- Left success response bodies unchanged on broker GET routes; kept existing plain-text 400 for "No selected account."
- Did not touch `app/api/quote` or `app/api/watchlist` (open PR #5138). GET `/api/history` is owned here because #5138 does not change that route.
- Broker auth and outage messages are generic HTTP-status summaries only — no upstream body passthrough.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/broker-route-error-honesty.test.ts test/api-security-hardening.test.ts test/history-route.test.ts test/sentry-metrics.test.ts
npm test
npm run build
```

## Next Steps & Blockers

- Merge after PR `verify` is green; no deploy action from agent.

## Zero-Code Findings

None.
