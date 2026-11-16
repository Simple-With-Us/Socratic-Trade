# Ungate congress share, 8-K full body, CSP report-only, UM read token

**Date:** 2026-08-13  
**Branch:** `grok/st-ungate-share-8k-apple-csp`  
**Agent:** GROK

## What shipped

Owner asked to turn these **on and functioning**.  `VECTOR_ASOF_STRICT` stays off.  FMP transcript rights stay off.

| Flag | Code | Infisical prod | Notes |
|------|------|----------------|-------|
| `CONGRESS_SHARE_ENABLED` | path already live; example now `on` | set `on` | Also needs `CONGRESS_TRADE_TOKEN` |
| `WEB_SOURCE_SEC8K_FULL_BODY` | enabled safely with bounds | set `on` | Limit 5 + 12s budget + adaptive FTS batch |
| `CSP_ENABLED` | already report-only by default | set `on` | |
| `CSP_REPORT_ONLY` | already defaults report-only | set `on` | Do **not** enforce-block |
| `USAGE_READ_TOKEN` | already consumed by knobs/budget | copied (length-only verify) | Reprobe already hits `/api/health` |
| Web Apple Sign-In | code path + JWT mint helper | **waiting on secrets** | See keys below |

## 8-K event-loop bound

Full-body ingest no longer mirrors FTS with one sync `insertDocumentChunkFts` loop inside the commit-proof transaction.  It now:

1. Chunks **before** the write lock (`timeSync` + `yieldEventLoop`).
2. Uses `insertDocumentChunkFtsBatch` (adaptive groups, 250ms stretch budget, floor 1 / ceiling 40).
3. Stamps `ingested_accessions` only after FTS succeeds.
4. Caps the cycle with `WEB_SOURCE_SEC8K_FULL_BODY_LIMIT` (default 5) and `WEB_SOURCE_SEC8K_FULL_BODY_BUDGET_MS` (default 12s, hard cap 60s).

This is the same adaptive FTS-mirror lesson as the 2026-08-10/13 60s stall — do not reintroduce a mega-transaction.

## Usage-monitor reprobe

`src/lib/health-lane-reprobe.ts` already probes `https://usage.jays.services/api/ready` then `/api/health`, never `/health` (login 307).  Regression stays in `test/health-lane-reprobe.test.ts`.

## Apple web — waiting on secrets

`~/.secrets` has ASC/APNs keys only, not Sign in with Apple.  Infisical keys needed (no values):

- `AUTH_APPLE_ID` — Services ID (web), return URL `https://socratictrade.com/api/auth/callback/apple`
- `AUTH_APPLE_SECRET` — ES256 client-secret JWT (`aud=https://appleid.apple.com`)

Or, instead of storing the JWT:

- `AUTH_APPLE_TEAM_ID`
- `AUTH_APPLE_KEY_ID`
- `AUTH_APPLE_PRIVATE_KEY` — PEM of the **Sign In with Apple** `.p8` (not ASC, not APNs)

Until those exist, `/login` keeps Google/GitHub only.  Native iOS Apple Sign-In is a separate route.

## Verify

Focused vitest: `apple-web-auth`, `sec8k-full-body`, `dormant-features`, `health-lane-reprobe`, `security-headers`, `congress-share`.
