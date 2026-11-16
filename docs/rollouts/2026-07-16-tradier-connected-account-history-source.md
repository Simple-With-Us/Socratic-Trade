# 2026-07-16 — Tradier: broker-connection-only, no duplicate API-key Settings card

## Summary

Removed Tradier from Settings' generic API-keys card and rewired its price-history credential
resolution to come from the connected Tradier BROKER account instead of a separate stored API
key. Tradier now appears in Settings exactly once — as a broker connection to sync/authenticate
to (Settings -> Accounts) — not also as a generic pluggable "data source" alongside FMP/Finnhub/
Marketstack.

- `app/api/keys/route.ts` — removed the `tradier` entry from `API_KEY_CATALOG` (and its now-dead
  `API_KEY_ENV_MAP`/`API_KEY_SERVICE_ALIASES`/`API_KEY_TIER` entries in `src/lib/db-api-keys.ts`).
- `src/lib/history.ts` — `fetchDailyOHLC`'s Tradier price-history fetch now resolves its
  credential via a new `resolveTradierHistoryCredential()`, which reads the "local" (owner's)
  connected Tradier broker account (`getConnectedAccountByBroker("tradier", "local")`, new
  export in `src/lib/db-api-keys.ts`) rather than `resolveApiKeyWithSource("tradier", ...)` /
  `TRADIER_API_KEY`. Base URL (sandbox vs production) tracks the connected account's own
  `environment`, matching `tradier.ts`'s existing derivation for order placement.
- Cache scope for Tradier-sourced history is now unconditionally `"shared"` (not routed through
  `cacheScopeForKeySource`) — it's the owner's single connected broker account, not a per-user
  key, so it naturally serves the whole app the same way any other operator-funded shared source
  does.

## Why

Owner request: "tradier shouldn't be listed as a data source for API on settings and should just
be a source that users sync to and then I am the first/only user and I am sharing the data we
can get from tradier." Investigation confirmed Tradier was backed by TWO independent
credentials — a per-user broker access token (`connected_accounts`, used for trading) and a
separate "Tradier API key" (`user_api_keys`/`TRADIER_API_KEY` env var, used only for price-history
enrichment) — presented identically to FMP/Finnhub in Settings despite one being a genuine
broker connection and the other a market-data-only key. Given the ambiguity of how far to take
the fix (hide the UI card only, vs. actually repoint the credential source), asked the owner via
`AskUserQuestion`; they chose the full rewire: the connected broker account becomes the ONLY way
Tradier data enters the app, with the existing `MARKET_DATA_SHARE_USER_KEYED_HISTORY`/data-pool-
consent sharing mechanism naturally applying (unchanged) as if it were any other "user" sourced
key — but since only "local" ever exists today, this trivially satisfies "I'm the only user and
I'm sharing the data."

## Codex P2 follow-up: don't require Tradier to be the ACTIVE execution broker

Codex flagged a real bug in the first version of this PR: `getActiveConnectedAccountByBroker`
filtered on `is_active = 1`, but `isActive` means "the currently loaded/executing broker"
(Settings' single-active-account UI only ever loads one broker at a time) — an orthogonal
concept to "this credential exists and can source data." A user trading through Alpaca as
their active account, who connects Tradier purely as a shared data source, would have found
Tradier history silently disabled — exactly the "connect Tradier once as the shared history
source" flow this PR exists to enable. Renamed the function to `getConnectedAccountByBroker`
and dropped the `is_active` filter (ordering by `is_active DESC, updated_at DESC` so an
active Tradier row is still preferred if one happens to exist, otherwise falling back to the
most recently updated connected Tradier account). Added a regression test connecting Alpaca
as the active broker and Tradier as a non-active connection, confirming history still
resolves via Tradier.

## Files

- `app/api/keys/route.ts` — removed the `tradier` catalog entry.
- `src/lib/db-api-keys.ts` — removed `tradier` from `API_KEY_ENV_MAP`, `API_KEY_SERVICE_ALIASES`
  (`tradier_api_key` alias), and `API_KEY_TIER` (now unreachable dead entries with the catalog
  removed); added `getConnectedAccountByBroker(broker, userId)` (NOT restricted to the active
  execution broker — see the Codex P2 follow-up above).
- `src/lib/history.ts` — `KEYED_HISTORY_SERVICES` no longer includes `"tradier"`; added
  `resolveTradierHistoryCredential()`; `fetchTradier` now takes an explicit `baseUrl` param
  instead of reading `TRADIER_BASE_URL`; the Tradier cascade entry's cache scope is hardcoded
  `"shared"`.
- `test/history.test.ts` — Tradier-sourced tests now call a new `connectTradier()` helper
  (`upsertConnectedAccount`) instead of setting `TRADIER_API_KEY`/`upsertUserApiKey(..., "tradier",
  ...)`; the two tests that specifically exercised PER-USER private/pool-consent key-sharing
  semantics were switched to use Marketstack as their vehicle instead, since Tradier is no longer
  per-user at all. Added a `beforeEach` cleanup deleting any `connected_accounts` row with
  `broker = 'tradier'`, since the shared `historyTestDb` persists across tests in the file and a
  connected account (unlike the deleted env vars) would otherwise leak into later tests.
- `scripts/migrate-market-keys-to-user.ts` — removed the now-pointless `tradier`/`TRADIER_API_KEY`
  migration entry.
- `.env.example`, `README.md` — replaced `TRADIER_API_KEY`/`TRADIER_BASE_URL` with a note pointing
  to the connected-account flow.
- `docs/market-data-provider-pricing.md`, `docs/phase-11-multi-user.md` — updated to describe the
  connected-account credential source.

## Verification

```bash
npx tsc --noEmit                                                    # clean
npx vitest run test/history.test.ts                                 # 14/14 passed
npx vitest run test/web-sources-technical.test.ts                   # 10/10 passed (unaffected)
npm test                                                            # full suite
npm run build
npm run lint
```

## Follow-ups

- No migration/backfill needed for any pre-existing `user_api_keys` row with `service='tradier'`
  or a set `TRADIER_API_KEY` env var — both are simply orphaned (harmless, unread) now rather than
  actively cleaned up, matching this codebase's usual approach of not read from vs. intrusively
  purging stale rows.
- If a future multi-tenant deployment ever has more than one real user, `resolveTradierHistoryCredential`
  always resolves the "local" user's connected account specifically (not a scan across all users'
  connections) — this matches the owner's stated single-tenant-today intent, but would need
  revisiting if Tradier connections become genuinely per-tenant later.
