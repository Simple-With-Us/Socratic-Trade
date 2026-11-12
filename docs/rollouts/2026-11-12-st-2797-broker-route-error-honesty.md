# ST-2797 — Broker-backed route API error honesty

## Context & Objective

Broker-backed GET routes threw uncaught gateway errors into Next's generic 500 page, and several JSON POST routes surfaced malformed bodies as 500.  This work adds one shared JSON error envelope so the web console and iOS can distinguish broker outages from server bugs.

## Changes Made

- Added `src/lib/api-error.ts` with `jsonError`, `brokerReadError`, and `parseRequestJson`.
- Wrapped broker reads on `app/api/positions`, `app/api/orders`, `app/api/portfolio`, and `app/api/accounts`.
- Standardized malformed JSON handling on `app/api/policy` PUT, `app/api/keys` POST, and `app/api/orders/cancel` POST; cancel maps unexpected broker failures to `brokerReadError` without changing cancel preconditions.
- `parseRequestJson` answers a body that cannot be read at all (stream error, body already consumed) with 400 `unreadable_body` instead of rethrowing, and logs the sanitized error (`console.error` plus Sentry `captureException` of a new Error that carries only the sanitized message, not the raw exception).  `app/api/keys` POST, `app/api/orders/cancel` POST and `app/api/policy` PUT all parse through it, so none of them falls through to an unhandled 500.
- Broker-backed GET routes (`accounts`, `positions`, `orders`, `portfolio`) keep the classified broker envelope; any other fault (an adapter defect such as a `TypeError`) is logged and answered as a 500 `internal_error` envelope.  Identity resolution on those routes, plus history, keys, policy, and orders/cancel, goes through `resolveRequestUserIdOrApiError` so a local SQLite fault becomes the JSON 500 envelope instead of Next's default non-JSON 500.  `app/api/orders/cancel` still rethrows non-broker post-cancel faults so cancel behaviour is otherwise unchanged.
- Added `test/broker-route-error-honesty.test.ts`; updated `test/api-security-hardening.test.ts` for the cancel envelope.
- PUT `/api/policy` validates the body with a strict `PolicyUpdateSchema` after `parseRequestJson`; unknown keys or wrong field types return 400 `invalid_payload`. Domain validation after a successful parse is unchanged.
- POST `/api/keys` validates the body with a strict `KeyUpsertSchema` (defined in `src/lib/key-upsert-schema.ts` with `import "server-only"`, not exported from the route module) after `parseRequestJson`; unknown keys or wrong field types return 400 `invalid_payload`. The Zod error (which could include a submitted apiKey) is never returned or logged. Domain checks after a successful parse are unchanged.
- GET `/api/history` resolves identity before the provider `try` (via shared `resolveRequestUserIdOrApiError`, also used on the other broker-backed routes in this PR). A thrown provider/gateway failure is classified the same way as other broker reads: 504 `broker_timeout`, 502 `broker_auth_failed`, or 502 `broker_unavailable`. `fetchDailyOHLC` now distinguishes those cases: when any live provider confirms no usable series it returns `[]` (even if another tier failed), and the route answers 200 with `bars: []`.  When every attempted tier failed, the route passes `throwOnProviderFailure: true` and receives the last provider failure as a payload-free `HistoryProviderError` (provider id, HTTP status, timeout marker only; never the upstream body, headers, or keyed URL), so it answers 504 `broker_timeout`, 502 `broker_auth_failed`, or 502 `broker_unavailable`.  Other callers still get `null`.  When every tier was skipped it returns `null`, and the route answers 502 `broker_unavailable` with “Price history is temporarily unavailable.”  The cascade logs only that payload-free message.  Identity-resolution faults are reported through `reportHandledErrorThrottled` (key `request-identity`).  Provider-failure telemetry is throttled process-wide to one `reportHandledError` per ten minutes. Identity denials stay 401. Local identity faults stay 500 `internal_error` and are never classified as `broker_*`, even when the error message looks gateway-shaped. Policy reads on positions, portfolio, orders, and policy are inside the JSON error handler.
- `isBrokerGatewayError` / `extractHttpStatusFromMessage` recognise eToro adapter messages (`No eToro account connected.`, `eToro keys are missing`, `eToro /me 500`).
- `reportHandledError` sanitizes once (via `sanitizedCapturedError`) before any telemetry leaves the process: `console.error` and Sentry both receive only the sanitized message. `captureHandledException` does not overwrite a caller-supplied `extra.error`, so the Sentry attribute matches `console.error` and the truncation count stays correct. Handled faults reach Sentry without enabling `enableLogs` and without leaking upstream bodies or credentials.

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
