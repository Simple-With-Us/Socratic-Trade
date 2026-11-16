# 2026-07-31 — Token-gated market-data read routes for congress.trade (KIMI)

## 1. Context & Objective

congress.trade (App A) wants to pull EOD price history FROM SocraticTrade (App B) as its
primary price source (cache-aside), symmetric with the reads App B already does against App A
(`src/lib/api-clients/congress.ts`). This adds the two missing App B read endpoints using the
exact envelopes the shared `CongressTradeClient` parses
(`@jaywedgeworth22/congress-trading-shared`: `PriceSeriesSchema`, `ClosesEnvelopeSchema`).

## 2. Changes Made

- `GET /api/market/prices/{symbol}?from=YYYY-MM-DD&to=YYYY-MM-DD` →
  `{ ticker, closes: [{date, close, volume?}, ...], currentPrice, currentPriceDate }`.
  Closes are DESCENDING (closes[0] = latest). `from`/`to` optional, inclusive; omitted `from`
  defaults to ~1y back, `to` to today; malformed params fall back to the default window.
  Unknown symbol / empty range → 200 with `{ ticker, closes: [], currentPrice: null,
  currentPriceDate: null }` (never an error status — App A falls back to another provider only
  on non-200).
- `GET /api/market/spx?from=&to=` → `{ closes: [...] }` DESCENDING, served from SPY daily bars
  (the benchmark convention the consumer already uses).
- Auth: the SAME `APP_B_INGEST_TOKEN` bearer secret as `POST /api/admin/securities/import`
  (`verifySecuritiesImportToken`, constant-time, default-closed). Middleware passes
  unauthenticated bearer requests through to the handlers — scoped to exactly
  `/api/market/prices/` + `/api/market/spx`; `/api/market/flatfile` stays session-gated.
- Bars come from `fetchDailyOHLC` — the app's canonical daily-OHLC cascade (local imported-EOD
  tier → App A → Massive → Tradier → Marketstack → Yahoo → Stooq, ~30min in-process cache).
  No new pipeline; the cascade's own cache is the cache-aside store.

Files:
- `app/api/market/prices/[symbol]/route.ts` (new)
- `app/api/market/spx/route.ts` (new)
- `src/lib/market-read.ts` (new — range parsing, inclusive filter, envelope shaping; injectable
  fetcher so tests never touch the network)
- `middleware.ts` (one added else-if branch: bearer pass-through for the two new paths)
- `test/market-read-routes.test.ts` (new — 22 tests)
- `STATUS.md`, `docs/EFFORT-LOG.md`, `docs/congress-trade-share.md` (reverse-direction section), this note

## 3. Decisions & Trade-offs

- **Data source = `fetchDailyOHLC`, not `data/history-5y`.** `data/history-5y/` is dev-only:
  written by `scripts/hoard-5y-universe.ts`, not in git, not in the Docker image, and the prod
  persistent volume (`/app/data`) only carries the litestream-restored `app.db`. The
  `fetchDailyOHLC` cascade (Massive keyed first) is the freshest practical source in the
  deployed container and reuses its existing in-process cache.
- **`currentPrice` is range-independent** (newest close of the FULL series) so a historical
  backfill response still reports the true latest; `closes` honors `from`/`to`.
- **Middleware bypass deliberately narrow** — only the two new paths, bearer-only (no
  `x-admin-token`), so the session-gated `/api/market/flatfile` surface is unchanged.
- No `history-5y` reader added; no DB persistence added (the imported-EOD tables already feed
  the cascade when `SECURITIES_IMPORT_HISTORY_TIER_ENABLED` is on).
- Built in a dedicated worktree (`~/apps/trading-kimi-market-read`) because the `trading-kimi`
  lane was actively being used by a concurrent KIMI session (notification fixes on
  `agent/kimi-lane`) mid-task — it branch-switched the shared worktree and wiped the first
  uncommitted draft of this change.

## 4. Verification State

Worktree `~/apps/trading-kimi-market-read`, branch `agent/kimi-market-read-routes` (from
`origin/main` @ 68c24dba). NOTE: this machine's default `node` is v26 but `.nvmrc` pins Node 24
and `node_modules` native modules are built for it — all gates run with
`PATH=/usr/local/bin:$PATH` (node v24.16.0); running vitest under node 26 fails to load
`better_sqlite3.node` (NODE_MODULE_VERSION 137 vs 147).

- `npx vitest run test/market-read-routes.test.ts` — 22/22 pass
- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors (grandfathered warning backlog only)
- `npm test` (full suite) — green
- `npm run build` — green

## 5. Next Steps & Blockers

- Land via PR (verify CI gates merge; not merged from this lane per parent instruction).
- congress.trade side: point its price cascade at
  `https://socratictrade.com/api/market/prices/{ticker}` + `/api/market/spx` with the shared
  `st_ingest_...` bearer (`APP_B_INGEST_TOKEN` on this app); treat non-200 as fallback-trigger,
  `closes[0]` as latest. Response shapes are exactly the shared-package `PriceSeries` /
  `{ closes: PriceClose[] }` schemas.
