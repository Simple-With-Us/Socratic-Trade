# Shared Market-Data Pool — Consent & Scope

## What it is
An opt-in, reciprocal market-data **pool**. A consenting user's **general market data** — pulled
via their own provider API keys or broker MCP — is contributed to a shared cache that other
**consenting** users can read, and in exchange they read data others contributed. This pools API
spend (fewer redundant calls across users) and enriches everyone's data coverage/freshness.

## Hard scope boundary (privacy)
**Only general market data is pooled.** Specifically: quotes, fundamentals, price history (OHLC),
news, and similar non-personal symbol data.

**Never pooled — always private to the owner:** personal account data — positions, orders, order
history, balances/buying power, P&L, tax lots, watchlists, strategy/policy config, and
credentials/API keys. None of this enters any shared tier.

## Reciprocity model (cache tiers)
Three cache scopes (see `src/lib/history.ts`, generalizes to other market-data caches):
- **`private`** — keyed `user:<userId>:<symbol>`. A non-consenting user's own key-pulled data.
- **`pool`** — keyed `pool:<symbol>`. A consenting user's key/MCP-pulled general data. **Read and
  written only by consenting users.**
- **`shared`** — keyed `shared:<symbol>`. Public/free-source data (Yahoo, Stooq, env-key providers)
  — readable by everyone, since it isn't user-contributed-private.

A **consenting** user reads `private → pool → shared` and writes their keyed pulls to `pool`.
A **non-consenting** user reads `private → shared` only and writes keyed pulls to `private` (never
contributes, never reads the pool). The legacy global override `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`
still forces keyed data to `shared` for all (operator escape hatch).

## Consent record
- Stored per user in `user_settings` key `data_pool_consent` =
  `{ accepted, acceptedAt, version }` (`src/lib/db.ts`: `get/setDataPoolConsent`, `hasDataPoolConsent`).
- **Versioned** (`DATA_POOL_CONSENT_VERSION`, currently 2): a stale acceptance under an older terms version does
  NOT count — the user is re-prompted when the terms materially change.
- **Mandatory share (owner 2026-08-17):** `hasDataPoolConsent` is true only after an explicit
  accept at the current version.  Unset users (`version === 0`, no `acceptedAt`) do **not**
  silently share.  Decline does not resolve the first-use gate — accept or the app stays locked.
- Every change is audited (`data_pool_consent` audit event).
- The same first-use surface records the versioned legal clickwrap (`legal_notice_consent`).

## Surfaces
- `GET /api/consent` → status + `needsConsent`. `POST /api/consent {accepted:true}` records accept;
  `{accepted:false}` returns 400.
- A blocking first-use gate (console + iOS) requires Accept.  Settings → Data sharing shows the
  required pool as status, not an off switch.  Fail-closed: if consent status cannot be loaded,
  the gate stays up.

## Status / follow-ups
- **Implemented:** consent record + API + the `pool` tier wired into the OHLC/history path
  (`history.ts`) + the dashboard consent gate + fail-closed client behavior when consent
  GET/POST fails.
- **Finding (important):** the enrichment cache in `data-providers.ts` (Finnhub/FMP/Alpha Vantage/
  Yahoo/Alpaca-news/Robinhood-fundamentals) is keyed by `provider:symbol` with NO user scope — so a
  user's key-pulled fundamentals/news/quotes are **already pooled globally across all users, today,
  without consent**. That delivers the data-utilization benefit but bypasses the consent boundary.
- **Next:** route that enrichment cache through the same consent-gated `private`/`pool`/`shared`
  tiers (as `history.ts` now does), so ALL general-market-data pooling is consent-based and a
  non-consenting user neither contributes nor reads pooled key-data. Until then, operators who care
  about the boundary should treat enrichment fundamentals/news as already-shared. Enable first-party broker fundamentals (Robinhood `get_equity_fundamentals`)
  into the pool after validating field units via `GET /api/admin/robinhood-probe`.
- **Requiring consent to use broker-keyed features:** the UI gate makes consent the precondition;
  enforce server-side on any future endpoint that would surface pooled data.
