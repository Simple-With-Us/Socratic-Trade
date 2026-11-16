# 2026-07-01 - alpaca-custom-endpoint-checkbox-fix

## Summary

Fixed a real bug in the Accounts editor (`app/dashboard-client.tsx`) that could silently
lock a connected Alpaca account's `base_url` to the wrong (paper vs live) endpoint, and
corrected the one production account it affected.

## Why

User reported: a newly-added live Alpaca account ("Alpaca Standard") failed to start with
`Alpaca account check failed` / `Request failed with status code 401` on the readiness
check, despite showing as normal/connected in the Accounts UI, and despite having no
funding-related reason to fail.

Diagnosis (via direct, read-only production DB queries — same approach as the
2026-06-30/07-01 broker-reliability work):

- `connected_accounts` showed this account with `environment: "live"` (correctly inferred
  from its live API key/account number) but `base_url: "https://paper-api.alpaca.markets/v2"`
  — the PAPER endpoint. A live API key sent to the paper host is rejected outright by
  Alpaca; that's the 401. The other live account ("Roth IRA") correctly has
  `base_url: "https://api.alpaca.markets"`, confirming this was a real inconsistency, not
  expected behavior.
- The Accounts UI doesn't catch this because it only checks that credentials are stored,
  not that they authenticate against the account's configured host — so the account looks
  "Connected" right up until something actually calls Alpaca (the readiness check, or a
  real order).

Root cause, traced through `app/dashboard-client.tsx`'s account editor (confirmed with the
user, who correctly guessed they'd clicked the checkbox):

1. Clicking "+ Connect Alpaca" opens the editor with `environment: "paper"`,
   `baseUrl: ALPACA_PAPER_ENDPOINT` (hardcoded initial state).
2. If "Use a Custom Alpaca Endpoint" gets checked before the account number/API key fields
   are filled in (or otherwise before `baseUrl` has been auto-updated to match a live
   credential), the checkbox's `onChange` ran `baseUrl: checked ? (editing.baseUrl || "") : ...`
   — copying whatever `baseUrl` currently held (still the paper default at that point)
   into the "custom" field, with nothing typed by the user.
3. Once checked, the account-number and API-key fields' own `onChange` handlers stop
   auto-deriving `baseUrl` from the inferred environment (`isAlpacaRest && !showCustomEndpoint`
   gates that derivation), so typing in the real live account number/API key afterward
   correctly flips `environment` to `"live"` but leaves `baseUrl` locked on the stale paper
   value.
4. On save, `showCustomEndpoint && draft.baseUrl?.trim()` is true (checkbox checked,
   non-empty stale value) — so the save handler persists the stale paper URL verbatim
   instead of falling back to the correct live default.

## Files

- `app/dashboard-client.tsx` — the "Use a Custom Alpaca Endpoint" checkbox's `onChange`
  now sets `baseUrl: checked ? "" : defaultAlpacaEndpoint` instead of
  `checked ? (editing.baseUrl || "") : defaultAlpacaEndpoint`. Starting the custom field
  empty is safe on save either way: the existing save-handler fallback
  (`showCustomEndpoint && draft.baseUrl?.trim() ? draft.baseUrl.trim() : alpacaDefaultEndpointFor(draft.environment)`)
  already resolves an empty custom value to the correct environment-appropriate default, so
  a user who checks the box without actually typing a real custom URL now gets the correct
  endpoint instead of a silently-locked-in stale one. Editing an EXISTING account that
  genuinely has a custom endpoint is unaffected — `openAccountEditor` still populates the
  checkbox and field from the account's real stored values on open; this fix only changes
  what happens when the user actively toggles the checkbox on.

## Production data fix (not in git — a data correction, not a code deploy)

- Corrected `connected_accounts.base_url` for account id `717a4e52-248f-4d8c-ba1e-ea31c5ebf596`
  ("Alpaca Standard") from the paper endpoint to `https://api.alpaca.markets`, matching its
  `environment: "live"`. (Note: by the time this was verified, the user had already applied
  this same fix themselves via the Accounts -> Edit UI, so no direct DB write was needed —
  confirmed via `updated_at` timestamp and the corrected value already present.)
- Verified via `api_health_log`: `alpaca-broker` health checks succeed (ok=1) for this
  account after the fix, with no further 401s.

## Verification

- `npx tsc --noEmit` — clean.
- `npm test` — 172 files / 1671 tests, all passing (unaffected — no existing test coverage
  exercises this code path; see Follow-ups).
- `npm run lint` — 0 errors, 258 warnings (unchanged baseline).
- `npm run build` — clean.
- No automated test added for the fixed logic itself: this repo has zero React-component
  test infrastructure (no `.tsx` test files, no `@testing-library` dependency), and the
  affected helper functions (`inferAlpacaEnvironment`, `alpacaDefaultEndpointFor`,
  `hasCustomAlpacaEndpoint`) are not exported from `dashboard-client.tsx`. Verified by
  direct code trace (confirmed against the user's own account of what they clicked) rather
  than a new test.

## Follow-ups

- Consider adding a lightweight guard so a similar mismatch can't reach production
  silently again — e.g. server-side validation in `app/api/connected-accounts/route.ts`
  that rejects (or warns on) a save where `baseUrl` doesn't match the auto-detected
  `environment` unless the request explicitly opts into a custom endpoint. Not done here —
  the immediate UI-side fix closes the actual trap the user hit; a server-side belt-and-
  suspenders check is a reasonable but separate hardening step.
- If this file ever gets component-level test coverage, `inferAlpacaEnvironment` /
  `alpacaDefaultEndpointFor` / `hasCustomAlpacaEndpoint` / the checkbox behavior would be
  good first candidates — they're pure/near-pure and directly caused a real production
  incident.
