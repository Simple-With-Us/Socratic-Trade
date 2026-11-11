# 2026-08-10 — OpenRouter credit monitor via management key + per-key limits (GROK)

## Summary

Redesign the `/api/health` `openrouterCredits` signal (and the Uptime Robot keyword
monitor that watches it) so it reflects **real** OpenRouter money state:

1. Account prepaid remaining via `GET /credits` (unchanged free endpoint)
2. **Any key's spend limit reached or low** via management-key `GET /keys`
   (`limit_remaining`)

Uptime Robot keyword is **unchanged**: `"openrouterCredits":{"ok":false`.

## Why

The previous path used the app inference key and only `/credits`. That missed:

- Per-key spend caps hitting zero while the account still had prepaid headroom
- Preferring the Management key that can list every key in the OpenRouter account
  (ST + CT share the same OR account; one health signal covers both)

Owner request: alert when any key's limit is reached, or when credits are low in
reality, via the management key.

## What

- `src/lib/openrouter-credits.ts` — prefer `OPENROUTER_MANAGEMENT_KEY` /
  `OPENROUTER_ADMIN_KEY`; detect management tier via `GET /key`; when management,
  also page `GET /keys` and evaluate `limit_remaining` for enabled keys.
  - `ok=false` reasons: `account_low` | `key_limit_reached` | `key_limit_low`
  - Fail-open on read errors (never page on our own fetch failure)
  - Cache still default 10 min (`OPENROUTER_CREDIT_CHECK_INTERVAL_MS`)
- `app/api/health/route.ts` — public projection adds non-secret counters
  (`source`, `keysChecked`, `keysLimitReached`, `reasons`, …); USD + key labels
  stay ops-token-only
- Env: `OPENROUTER_KEY_LIMIT_LOW_USD` (default $3; `0` = only fully exhausted keys)
- Tests updated for multi-URL fetch routing

## Production config (required for full signal)

Store a **Management / Provisioning** OpenRouter key in the **Socratic.Trade**
Infisical project as one of:

- `OPENROUTER_MANAGEMENT_KEY`, or
- `OPENROUTER_ADMIN_KEY` (already present in the operator handoff file)

Without it, the probe falls back to the inference key and account `/credits` only
(same as before for per-key limits — `keysChecked: false`).

## Uptime Robot

Existing monitor **OpenRouter credits low** (`id 803542990`):

- URL: `https://socratictrade.com/api/health`
- Keyword exists: `"openrouterCredits":{"ok":false`
- No dashboard change required (keyword stable)

## Verify

```bash
npx vitest run test/openrouter-credits.test.ts test/health-route-exposure.test.ts
# after deploy:
curl -sS https://socratictrade.com/api/health | jq '.checks.openrouterCredits'
# expect source=management, keysChecked=true when admin key is in Infisical
```
