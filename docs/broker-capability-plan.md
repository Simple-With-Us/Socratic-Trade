# Broker Capability Plan — Alpaca, Robinhood, eToro, Public.com, IBKR

Comprehensive audit of what each broker this app could talk to actually offers (trading,
market data, streaming, MCP, non-trading read access, order-status monitoring), what this
app uses today, and a prioritized plan to close the gaps. Commissioned 2026-06-30 in
response to: (1) a user report that "Alpaca news" and another feature had never worked on
the admin connection-status page, and (2) a request to audit whether the app is using
everything each broker offers, including without ever placing a trade, and whether MCP
is the right transport.

Research method: 5 parallel research agents (one per broker) plus direct code reads of
`src/lib/alpaca.ts`, `src/lib/robinhood.ts`, `src/lib/broker.ts`, `src/lib/streams/*`, and
`src/lib/data-providers.ts`. For Robinhood specifically, the live Robinhood MCP connector
attached to this session (server id `7fd5cf6d-...`) was enumerated directly — not
research, ground truth: it exposes 43 tools today, confirmed by loading several tool
schemas. Do not treat that count as static; MCP servers evolve. For Alpaca/eToro/Public.com/
IBKR, findings are from Claude's web research on 2026-06-30 and should be re-verified
against current docs before any implementation, since broker APIs — especially the very
recently launched eToro and Public.com ones — change fast.

## 0. Fixes already shipped in this same session (context for the rest of this doc)

1. **Share-class symbol translation** (`BRK-B` → `BRK.B`). Our canonical symbol format
   uses a hyphen for share classes (Robinhood convention, `src/lib/sp500.ts:2`); Alpaca
   requires a dot everywhere — trading, market-data snapshots, and news. This was
   unconverted in four places, all fixed: `src/lib/alpaca.ts` (order placement, quotes),
   `src/lib/data-providers.ts` (`AlpacaSnapshotEnrichmentProvider`,
   `AlpacaNewsEnrichmentProvider`), `src/lib/streams/alpaca-trade-updates-stream.ts`, and
   `src/lib/streams/news-store.ts`. `toAlpacaSymbol`/`fromAlpacaSymbol` now live in
   `src/lib/money.ts` as the single conversion point.
2. **Broker-agnostic order-placement confirmation.** `executeProposal` and the autonomous
   run-loop in `src/lib/strategy.ts` used to record a proposal as `"placed"` any time
   `gateway.placeEquityOrder()` didn't throw — but Alpaca and Robinhood can both return a
   synchronous `rejected`/`canceled` state without throwing (HTTP 200 with a declined
   order). Added `isRejectedOrCanceledState()` in `src/lib/broker-side.ts` (case-insensitive,
   covers both spellings) and check it at both placement call sites; a synchronous decline
   is now recorded as `"rejected_by_broker"`, not `"placed"`, with its own notification.
3. **Robinhood order-id fabrication bug.** `HttpMcpRobinhoodGateway.placeEquityOrder` did
   `String(raw.id ?? raw.order_id)` with no fallback — a malformed MCP response with
   neither field became the literal string `"undefined"`, silently recorded as a
   confirmed "placed" order that could never be reconciled against Robinhood's real order
   list. Now throws (routes into the existing placement-uncertain/`placing_failed` path)
   when no order id comes back.
4. **Connection-status admin page root-cause diagnosis** — see §1.

All four are covered by new/updated tests; see the rollout note
`docs/rollouts/2026-06-30-broker-reliability-and-capability-audit.md` for the full list.

## 0.5 Follow-up round (2026-07-01) — streams enabled, Robinhood fundamentals verified

At the owner's explicit request ("I don't want those 3 features turned off for alpaca"):

5. **Enabled the 3 disabled Alpaca streams in production** (§9) plus `TRIGGER_ENGINE`
   (a prerequisite the price-events stream refuses to start without — see §9 for why this
   has broader scope than just price events). Found and fixed a real bug while verifying:
   the two auth-dependent streams (`alpaca-news-stream.ts`,
   `alpaca-trade-updates-stream.ts`) were resolving Alpaca credentials from a **stale
   legacy `user_api_keys` row** (last touched 2026-06-22) instead of the actively-used
   `connected_accounts` record (rotated 2026-06-29) the rest of the app reads from — a
   second, independent credential-drift bug from the one already documented in §1. Added
   `resolveAlpacaStreamAccount()` in `src/lib/db-api-keys.ts` to fix this, and made the
   trade-updates stream pick the correct live-vs-paper WebSocket host instead of
   hardcoding paper. See `docs/rollouts/2026-07-01-enable-alpaca-streams.md`.
6. **Verified Robinhood fundamentals live, found and fixed a real risk before enabling.**
   `RobinhoodEnrichmentProvider` ("robinhood-fundamentals") already exists in
   `data-providers.ts` but is gated behind `ROBINHOOD_ENRICHMENT_ENABLED` — off in
   production (0 logged calls ever) — because its own code comment flags that field
   units/shape need verifying first. Called the live Robinhood MCP `get_equity_fundamentals`
   tool directly (this session happened to have a Robinhood MCP connector attached) and
   confirmed: the numeric fields (PE ratio, 52-week range, average volume) are clean and
   parse correctly, but `sector`/`industry` come back in Robinhood's own idiosyncratic
   taxonomy (e.g. `"Electronic Technology"` / `"Telecommunications Equipment"` for AAPL) —
   not the GICS-style taxonomy the rest of the app uses. That matters because
   `SymbolEnrichment.sector` feeds real risk enforcement: `market.ts` merges it into
   `MarketQuote.sector`, which `policy.ts`'s `sectorForSymbol`/`sectorCapFor` read to
   enforce `policy.sectorCaps` — so passing Robinhood's raw sector through would silently
   stop a symbol's sector cap from matching. Fixed `parseRobinhoodFundamentals` to map only
   the verified-safe numeric fields and drop `sector`/`industry` entirely. **Not yet
   enabled in production** — the code fix needs to deploy first (same gap as #5 above),
   then `ROBINHOOD_ENRICHMENT_ENABLED=on` is safe to set.
7. **Coordination**: Codex has separate, unmerged work adding new broker integrations
   (per the owner). This round's work deliberately stayed in the "use Alpaca/Robinhood
   more fully" lane and did not touch new-broker code, to avoid colliding with it.

## 1. "Alpaca news has never worked" — root cause (confirmed against production data)

The admin page is `app/admin/connections/connections-health-client.tsx` +
`app/api/admin/connections-health/route.ts`, backed by `src/lib/db-health.ts`. It is
generic: it lists whatever `service` names have rows in `api_health_log`, and a row shows
"Last success: never" whenever `lastSuccessTs` is null — that is almost certainly the
literal thing the user saw.

Querying the **production** `api_health_log` table directly (read-only) gave ground truth
instead of guessing:

| Service | Total calls | Ever succeeded | Root cause |
|---|---|---|---|
| `alpaca-news` | 160 | Yes (54) | **Self-resolved.** Every failure (106, all `HTTP 401`) is timestamped before 2026-06-30T10:01 UTC; every success is after. A credential on the top-ranked connected Alpaca account (`Roth IRA`, live, updated 2026-06-29T21:35 UTC) started working ~12h after that update. If the admin page still shows it red, that's a stale client-side cache — reload it. |
| `alpaca-snapshot` | 170 | Barely (2) | **Two stacked bugs, now fixed.** 105 `HTTP 401` (same credential issue as above — also self-resolved at the same 10:01 UTC cutover) **plus** 62 `HTTP 400` that persisted after the credential fix — this was the share-class symbol bug (§0.1): any batched snapshot request touching a hyphenated symbol like `BRK-B` (present in the S&P 500 scan universe, `src/lib/sp500.ts:72`) got the *entire batch* rejected. Fixed in this session; should now succeed like `alpaca-news` does. |
| `alpha-vantage` | 500 | **Never** | Free-tier rate limit exhausted (`"25 requests per day"` in every error). Not a code bug — this app calls it far more than the free tier allows. See §10 recommendation. |
| `twelvedata` | 297 | **Never** | `HTTP 429` on every call — same class of problem, different provider. |
| `congress.trade` | 500 | **Never** | `"This operation was aborted"` on every call — a timeout/abort, likely the companion congress-trade app being unreachable or too slow from this deployment. Separate app, out of scope for this doc. |

If the user's "something else" was `alpaca-snapshot`, it's fixed. If it was
`alpha-vantage`/`twelvedata`/`congress.trade`, those are **not code bugs** — they are
either an exhausted free-tier quota (alpha-vantage, twelvedata) or the sibling app being
unreachable (congress.trade), and are follow-ups, not part of this fix.

**A real gap surfaced by this investigation**: `src/lib/db-health.ts`'s
`logApiHealth()` is only called from the market-data enrichment providers in
`data-providers.ts`. None of the actual **broker gateway** calls (`alpaca.ts`'s
`getAccount`/`getPositions`/`getOrders`/`createOrder`/`getLatestQuotes`, or any Robinhood
MCP tool call in `robinhood.ts`) log health at all. So the admin connection-status page
cannot today tell you "your Alpaca trading connection is down" or "your Robinhood MCP
token expired" — only "an enrichment provider is down." Recommended follow-up in §10.

## 2. What's integrated today

| Broker | Status | Transport |
|---|---|---|
| **Alpaca** | Integrated | REST (`@alpacahq/alpaca-trade-api` SDK) primary; optional `alpaca-mcp` broker type routes the same calls through Alpaca's MCP server instead, with REST as fallback on failure (`src/lib/alpaca.ts`) |
| **Robinhood** | Integrated | MCP only (`agent.robinhood.com/mcp/trading`) — Robinhood has never offered a general-purpose REST API for retail; this is the only sanctioned programmatic path (`src/lib/robinhood.ts`) |
| **eToro** | Not integrated | Zero references anywhere in the codebase |
| **Public.com** | Not integrated | Zero references anywhere in the codebase |
| **IBKR** | Not integrated | Only appears as a watchlist *ticker symbol* (`src/lib/sp500.ts:241`, IBKR is Interactive Brokers' own public stock) and in "maybe someday" doc notes |

`BrokerGateway` (`src/lib/types.ts`) is equities-only: `getAccounts`, `getPortfolio`,
`getEquityPositions`, `getEquityOrders`, `getEquityQuotes`, `getEquityTradability`,
`reviewEquityOrder`, `placeEquityOrder`, `cancelEquityOrder`. No options, no crypto, no
futures/forex/bonds in the interface at all — this is a deliberate scope boundary, not an
oversight, and every gap below should be read against that boundary.

## 3. Alpaca — used vs. available

Used today (`src/lib/alpaca.ts`, `src/lib/data-providers.ts`,
`src/lib/streams/alpaca-*`): account info, positions, order history, latest quotes,
snapshots, REST news, equity order placement (market/limit/stop/stop-limit/trailing-stop,
bracket/OCO legs), order cancel, trade-updates stream (fills), news stream, minute-bar
price-event stream (breakout/move/volume-spike triggers).

**Available but unused** (from research, cross-checked against the SDK's actual surface):

- **Portfolio history** (`GET /v2/account/portfolio/history`) — a ready-made equity curve
  with zero implementation cost; this app currently derives its own equity history from
  local fill records only.
- **Account activities** (`GET /v2/account/activities`) — Alpaca's own audit trail of
  fills/dividends/transfers. Directly useful as a second source of truth for the
  reconciliation work in §0.2/§10 — cross-check local fill records against Alpaca's
  activity log instead of only polling `/orders`.
- **Corporate actions API** (announcements: dividends, splits, mergers, spinoffs) — pure
  reference data, zero trading required.
- **Calendar/Clock** (`GET /v2/calendar`, `GET /v2/clock`) — session open/close and
  holiday awareness; the app currently infers market hours elsewhere.
- **Screener** (most-actives, movers/gainers-losers) — an additional, free, real-time
  discovery source alongside the existing NASDAQ/S&P 500 scan universe.
- **Options chain with Greeks/IV** — read-only; useful for research even without the
  BrokerGateway supporting option orders.
- **News/Trade/Quote WebSocket streams for options and crypto** — n/a until/unless this
  app adds those asset classes (see §9 non-goal).
- **Official Alpaca MCP server** (`github.com/alpacahq/alpaca-mcp-server`, ~65 tools,
  `ALPACA_TOOLSETS` scope filtering) — see §7.

None of these are broker-agnostic order-confirmation or safety issues; they're pure
data/observability upside. Prioritized in §10.

## 4. Robinhood — used vs. available (live tool enumeration, not research)

Used today (`src/lib/robinhood.ts`, 9 of 43 tools): `get_accounts`, `get_portfolio`,
`get_equity_positions`, `get_equity_orders`, `get_equity_quotes`, `get_equity_tradability`,
`review_equity_order`, `place_equity_order`, `cancel_equity_order`.

**Available but unused** (34 tools) — grouped by what they unlock:

- **Options — an entire asset class**: `place_option_order`, `review_option_order`,
  `cancel_option_order`, `get_option_positions`, `get_option_orders`, `get_option_chains`,
  `get_option_instruments`, `get_option_quotes`, `get_option_historicals`,
  `get_option_watchlist`, `add_option_to_watchlist`, `remove_option_from_watchlist`.
  Single-leg only via MCP (covered calls, cash-secured puts, long calls/puts) — multi-leg
  spreads are not exposed even on Level 3 accounts. This is the single biggest capability
  gap for Robinhood and would require extending `BrokerGateway` (out of scope for a quick
  fix — real feature work, see §10).
- **Usable without ever placing a trade**: `get_equity_fundamentals` (PE, market cap,
  52-week range, dividend schedule — a free, redundant-but-valuable additional source
  alongside Finnhub/FMP/Yahoo), `get_equity_historicals` (OHLCV down to 15-second bars —
  finer granularity than anything currently pulled), `get_earnings_calendar` /
  `get_earnings_results` (market-wide and per-symbol earnings, free), `search`
  (natural-language instrument/crypto-pair/index resolution), `get_index_quotes` /
  `get_indexes` (SPX/NDX/DJI-style index levels), `get_realized_pnl` (Robinhood's own
  bucketed realized-gain calculation — a strong sanity-check against this app's own P&L
  math in `src/lib/performance.ts`), `get_watchlists` / `get_watchlist_items` /
  `get_popular_watchlists` (Robinhood-native watchlists, distinct from this app's own
  `user_watchlist` table).
- **Redundant-but-requested market discovery**: `get_scans` / `create_scan` / `run_scan` /
  `update_scan_config` / `update_scan_filters` — Robinhood's own screener with presets
  (`DAILY_GAINERS`, `DAILY_LOSERS`, `HIGH_OPTIONS_VOLUME_IV`, `UPCOMING_EARNINGS`) and
  custom RSI/volume filters. Explicitly redundant with the existing NASDAQ/S&P 500 Market
  Scan, which the user said is fine ("even if some are redundant").
- **Watchlist write tools**: `create_watchlist`, `update_watchlist`, `add_to_watchlist`,
  `remove_from_watchlist`, `follow_watchlist`, `unfollow_watchlist` — could sync this
  app's internal watchlist to/from a native Robinhood watchlist if that's ever wanted; low
  priority, organizational only.
- **Crypto and market indexes appear in `search`'s asset-type options and
  `get_realized_pnl`'s asset-class filter, but there are no crypto trading/quote tools in
  this MCP surface at all** — Robinhood does not expose crypto trading via MCP today, so
  this is a broker-side gap, not something this app is missing.

**No streaming, no webhooks, no sandbox — confirmed, not a gap to close.** Every one of
the 43 tools is poll-only; there is no push mechanism anywhere in the Robinhood MCP
surface, and there is no paper-trading account type at all. Order-status monitoring is
inherently poll `get_equity_orders`/`get_option_orders`, full stop — this is a Robinhood
platform limitation, not something a code change here can fix.

## 5. eToro, Public.com, IBKR — capability summaries (would-be new integrations)

### eToro — real reversal from "closed platform," still early-access

eToro launched an official **Public API + Builders Portal**
(`builders.etoro.com`, `api-portal.etoro.com`) on 2026-02-17 — REST + WebSocket, covering
order execution (market + Market-If-Touched orders, SL/TP, position close), portfolio
data, social/copy-trading feeds, and an **Agent Portfolios** concept purpose-built for
AI-agent-managed accounts. A full demo (paper) environment mirrors production 1:1.
API-key auth (`x-api-key` + `x-user-key` headers), idempotency via `x-request-id`. Real-time
push is via a private WebSocket topic (`wss://ws.etoro.com/ws`), not HTTP webhooks.
**Caveat: access is "select users globally" / early-access with a waitlist** — a
third party cannot self-serve production access today; expect an approval step before
this is buildable at all. eToro also publishes an **official MCP server**, but it's a
**documentation/schema-context server for coding assistants, not a trading executor** —
it doesn't place trades or fetch account data as MCP tool calls.

### Public.com — also reversed course, genuinely self-serve for personal use

Public.com now has an official **Individual API** (self-serve, free, instant, generated
in-app under Account Settings → Security → API) covering stocks, ETFs, options
(incl. multi-leg), corporate bonds, U.S. Treasuries, and crypto, with real order placement,
real-time quotes, historical bars, and options Greeks. **Licensing gotcha**: the
Individual API's Developer Program Agreement restricts it to the account owner's own
personal, non-commercial use — not licensed for a commercial multi-user product. A
separate **Partnership Program** (direct approval required, not self-serve) is the path
for that. Public.com also runs an **official hosted MCP server** for Claude/ChatGPT/
Perplexity. No sandbox/paper environment — testing is against a live (commission-free)
account. Order status is polling-only (`GET /{orderId}`); no streaming, no webhooks.

### Interactive Brokers (IBKR) — most powerful, most operationally expensive

Genuinely the broadest API in the space: 100+ order types, essentially every asset class
(stocks, options, futures, forex, bonds, mutual funds, combos), 150+ global markets, and a
**first-class paper-trading environment** identical to live except for the port number.
Two integration paths — the Client Portal Web API (REST + WebSocket) or the classic TWS
socket API — and **both require a persistent, interactively-authenticated local
gateway/desktop process**, not a static API key. Sessions expire (~5 min idle without a
keepalive `/tickle`, full re-auth roughly every 24h); unattended operation needs
third-party (unofficial) tools like IBC or IBeam to automate the login/2FA flow. Most
real-time market data requires separate paid per-exchange subscriptions. No official MCP
server exists; several community ones wrap `ib_insync`/`ib_async` and inherit the same
persistent-gateway requirement. **This is a real DevOps commitment (a monitored,
auto-restarting gateway process), not a config change** — treat it as its own project if
pursued, not a quick add.

## 6. What's usable without ever placing a trade (cross-broker)

Every broker researched has a meaningful non-trading surface. Summary of what's real and
currently unused by this app:

- **Alpaca**: portfolio history, account activities, corporate actions, calendar/clock,
  screener, options chain/Greeks, news (already used), assets/instruments metadata.
- **Robinhood**: fundamentals, historicals (15s-to-50y bars), earnings calendar/results,
  natural-language search, index quotes, realized P&L, watchlists, market scanners.
- **eToro** (if/when access is granted): copy-trading/social data (`get_user_live_portfolio`,
  performance history), user statistics, price alerts, balances.
- **Public.com** (if integrated): read-only balances/positions/portfolio value, order
  history, money-movement/dividend/interest records.
- **IBKR** (if integrated): account summary/balances, positions, portfolio
  performance/P&L, Flex Query bulk transaction/tax-document reports.

## 7. MCP vs. direct API — evaluation

`docs/alpaca-mcp-vs-api-evaluation.md` (existing, 2026-06 era) already covers Alpaca in
depth but conflates two different MCP scenarios that need separating — see the update
appended to that doc. Restated cleanly here, plus the other four brokers:

**Two different things called "MCP" in this codebase's context:**

1. **External chat client → broker's MCP server directly**, bypassing this app entirely
   (e.g. connecting Alpaca's MCP server to Claude Desktop/Cursor). This is what the
   existing eval doc is about: it bypasses every safety/policy/persistence layer this app
   has, and should only ever be used for read-only/interactive personal use with a
   restricted toolset, never for anything this app's automated strategies rely on.
2. **This app's own backend calling a broker's MCP server as its network transport**,
   instead of (or as a fallback from) that broker's REST API. This already exists —
   `AlpacaBrokerGateway` has an `isMcp`/`alpaca-mcp` mode, and **Robinhood's entire
   integration IS this** (there is no Robinhood REST alternative). In this scenario MCP
   is fully wrapped by the same policy/cap/review/persistence pipeline as REST — it's a
   transport choice, not a safety bypass. This is the scenario relevant to "should we use
   MCP more."
3. **This app's own in-app chat assistant (`app/api/chat/route.ts`,
   `src/lib/chat/orchestrator.ts`/`tools.ts`) getting direct MCP tool access to brokers (or
   other data sources) to answer richer questions.** This is a third, distinct thing from
   both of the above, and the one raised by "consider for some of the tools that they
   could be accessible to the chat client to enhance that." Addressed below.

### Scenario 3 — should the in-app chat assistant get MCP tool access?

The chat assistant already has a deliberate, narrow safety model: `buildTools()` in
`src/lib/chat/tools.ts` exposes a small, explicitly-typed tool registry (`get_quote`,
`draft_order`, `create_alert`, plus read-only state getters for positions/portfolio/
watchlist/alerts/proposals/P&L). Every tool's `input_schema` is validated server-side, the
model's input is treated as untrusted regardless of schema claims (see the comment on
`draft_order`), and — critically — **there is no execution tool**: `draft_order` returns a
ticket for a human to confirm; the chat layer can never place a real order by itself. This
is the same "chat can read/propose, only the gated pipeline executes" boundary the rest of
this app enforces.

Grafting raw MCP tool access onto this (e.g. registering Robinhood's `place_option_order`,
`get_option_chains`, `get_realized_pnl`, etc. directly as callable tools for the chat
model) would either:
- **Include write tools** (`place_equity_order`, `place_option_order`, `create_scan`,
  `follow_watchlist`, ...) — this reintroduces exactly the Scenario 1 risk
  (`docs/alpaca-mcp-vs-api-evaluation.md`): a broker call with none of this app's
  policy/cap/consent checks, reachable from a chat turn. Not acceptable for anything this
  app calls "the chat assistant" inside its own gated product.
- **Filter to read-only tools only** (Alpaca's `ALPACA_TOOLSETS`, or hand-picking
  Robinhood's `get_*` tools) — safer, but still bypasses this app's OWN input validation,
  per-user consent/data-pool rules (`hasDataPoolConsent`), caching, and rate-limiting that
  every existing `ToolDeps` call goes through. A raw MCP passthrough tool has none of that
  by default; it would need the same wrapping work as option 2 below to be safe, at which
  point it isn't really "raw MCP access" anymore.

**Recommendation: don't wire raw MCP tool access into the chat assistant. Get the same
user-facing capability boost by adding new, typed, read-only entries to
`buildTools()`/`ToolDeps`, backed by real broker calls** — e.g. `get_earnings_calendar`,
`get_option_chain`, `get_realized_pnl`, `search_instrument` as new tool definitions that
internally call `fetchRobinhoodFundamentals`-style functions (or new equivalents for
Alpaca's calendar/corporate-actions/portfolio-history endpoints from §3). This delivers
exactly what "give the chat client access to these broker capabilities" asks for — the
model can answer "what's Apple's PE ratio," "when does Tesla report earnings," "how did my
last 90 days do" — while keeping the same input-validation, consent, caching, and
never-executes-a-trade boundary every other chat tool already has. It's more upfront work
than pointing the model at an MCP server's tool list, but it's the same amount of *new
capability* delivered safely instead of by bypassing the app's own safety model.
This is a real, scoped feature addition (new tool defs + `ToolDeps` wiring + tests) — not
started in this round; flagged in §10 as a candidate next increment, pending the owner
picking which 2-3 tools matter most.

### Per-broker recommendation

| Broker | Recommendation | Why |
|---|---|---|
| **Alpaca** | Keep REST as primary; the existing `alpaca-mcp` fallback mode is fine to keep as-is | REST is mature, well-rate-limited (200 req/min, documented), has no licensing gotchas, and the official MCP server (~65 tools) doesn't offer anything REST can't already do for this app's use case — its main value-add (`ALPACA_TOOLSETS` scoping) matters for scenario 1 (chat clients), not scenario 2 |
| **Robinhood** | No choice to make — MCP is the only sanctioned path | Robinhood has never published a general-purpose REST API; the only historical alternative (`robin_stocks`, reverse-engineered private endpoints) is explicitly ToS-risk and unsupported. Current MCP integration is correct and should stay. |
| **eToro** | If/when access is granted, use the REST+WebSocket Public API directly, not their MCP server | eToro's official MCP server is documentation-only for coding assistants — it cannot place trades or fetch account data, so there is no MCP option here at all for actual integration |
| **Public.com** | REST Individual API directly for a single-account integration; MCP not relevant to this app's server-side automation | Public's MCP server is a hosted natural-language interface for chat clients (scenario 1) — same reasoning as Alpaca: fine for personal interactive use, not a substitute for this app's own policy-gated REST calls. **Licensing note**: confirm the Individual API's non-commercial restriction doesn't apply to this app's usage model before integrating live. |
| **IBKR** | Neither MCP nor REST is "easy" here — if pursued, go REST/WebSocket (Client Portal Web API) over the TWS socket API, and treat the persistent-gateway requirement as its own infrastructure project | No official MCP exists; community ones wrap the TWS socket API and inherit the same persistent-gateway auth burden either way, so MCP buys nothing here — the operational cost is the gateway process itself, not the protocol on top of it |

**Bottom line**: MCP is not a general-purpose upgrade path for this app. It's already the
mandatory transport for Robinhood, an optional fallback for Alpaca that isn't pulling its
weight, a dead end for eToro (docs-only), a redundant option for Public.com (their REST
API is simpler for server-side automation), and orthogonal to IBKR's real cost (the
gateway process, not the protocol). Where new brokers get integrated, default to REST/
WebSocket and only reach for MCP when — as with Robinhood — there is no REST alternative.

## 8. How to monitor order/trade status (cross-broker)

| Broker | Mechanism | Notes |
|---|---|---|
| Alpaca | `trade_updates` WebSocket (near-real-time, already implemented in `alpaca-trade-updates-stream.ts` but **disabled** — see §9) or poll `GET /v2/orders` | WebSocket is the only non-polling option Alpaca offers for a single account; no generic webhooks exist |
| Robinhood | Poll `get_equity_orders`/`get_option_orders` only | No push mechanism exists anywhere in the Robinhood MCP surface — this is a platform limitation, not a gap to close |
| eToro | Private WebSocket topic (`wss://ws.etoro.com/ws`) or poll order/position endpoints | No HTTP webhooks |
| Public.com | Poll `GET /{orderId}` only | No streaming or webhooks documented |
| IBKR | TWS API: push callbacks (`orderStatus`, `execDetails`) over a persistent socket — the most reliable/lowest-latency of any broker researched; Client Portal Web API: `sor` WebSocket topic or REST poll | IBKR explicitly recommends the websocket over REST once order volume is non-trivial (REST has a ~1000-order retrieval cap) |

## 9. Unused Alpaca infrastructure already built into this app (the literal ask: "make sure we're using the price events websocket stream and any others")

Three fully-implemented Alpaca WebSocket workers exist in `src/lib/streams/` and are
wired to start at boot (`src/lib/streams/index.ts` → `instrumentation.register()`), but
**all three are disabled in production** (confirmed via `pm2 env trading` and
`~/apps/trading-live/.env.local` — none of the flags below are set):

- `alpaca-news-stream.ts` — real-time Benzinga news push, `STREAMS_ALPACA_NEWS_ENABLED`
- `alpaca-trade-updates-stream.ts` — real-time fill/cancel/reject push,
  `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`
- `alpaca-price-events-stream.ts` — minute-bar breakout/move/volume-spike triggers,
  `STREAMS_ALPACA_PRICE_EVENTS_ENABLED` (also needs `TRIGGER_ENGINE` on)

This is a deliberate, documented rollout gate (see comments in each file — free IEX plan
has a 30-symbol concurrent-subscription cap, and price events specifically warn about
blowing through it with a full index universe), **not an oversight**, so this doc does not
recommend flipping them on unilaterally — that's a production behavior change with real
API-tier/cost implications the user should make explicitly. See §10 for how to decide.

## 10.5 Prefer free broker data over paid third-party sources (owner directive, 2026-07-01)

Explicit owner instruction: "robinhood and alpaca already would do lots of what we are
using other sources for and do so for free... take full advantage of all that these
brokers provide free and use other services when there is real value add or necessity."
Concretely, against the current `CascadingEnrichmentProvider` order in
`getEnrichmentProvider()` (`data-providers.ts`, first-non-null-per-field wins):

1. `AlpacaSnapshotEnrichmentProvider` (free, real-time) — already first. Good.
2. Congress.Trade cache, Webull-unofficial (both opt-in, off by default) — unaffected.
3. `RobinhoodEnrichmentProvider` ("robinhood-fundamentals", free) — coded, gated off,
   **verified and fixed this round (§0.5)**, not yet enabled pending deploy.
4. `TiingoEnrichmentProvider`, `FintechStudiosEnrichmentProvider` (both paid) — positioned
   *after* the free Robinhood tier, which is correct ordering:
   once Robinhood enrichment is live, these paid providers are only consulted for fields
   Robinhood didn't supply.
5. `FinnhubEnrichmentProvider` — has a usable free tier (production: 268/500 calls
   succeeded, ~54%) — fine where it sits.
6. `TwelveDataEnrichmentProvider` — **confirmed 0/297 successes ever in production**
   (`HTTP 429`, rate-limited free tier). This is calling out to a service that delivers
   zero value today and costs a network round-trip on every enrichment pass for nothing.
7. `AlpacaNewsEnrichmentProvider` (free, headlines/sentiment) — positioned *after* several
   paid providers (Tiingo/FintechStudios/Finnhub/TwelveData) that don't even
   supply headlines/sentiment, so this ordering doesn't cost anything in practice, but
   there's no reason it couldn't sit right after the Alpaca snapshot provider for clarity.
8. `AlphaVantageEnrichmentProvider` — **confirmed 0/500 successes ever in production**
   (free-tier "25 requests per day" exhausted immediately). Same zero-value-today problem
   as TwelveData.
9. `FmpEnrichmentProvider` (paid) — real, working paid provider; keep as-is.
10. `YahooFinanceEnrichmentProvider` (free, final fallback) — already last-resort by
    design, correct.

**Reading this against the owner's directive**: the ordering already generally prefers
free-then-paid where it matters (Robinhood before the paid mid-tier), and the two paid
providers with the WORST actual value (`alpha-vantage`, `twelvedata` — both 0% success in
production) are providers the owner is *already paying nothing extra for* in terms of
architecture cost, but they add latency/noise for zero benefit. This doc does not
recommend removing them unilaterally (that's a "do we still want this vendor relationship"
call, not a bug) — flagged again in §10 as a decision point, not auto-actioned.

## 10. Prioritized recommendations

**Already done — 2026-06-30 round** (§0): symbol translation, order-confirmation
correctness, Robinhood order-id bug, connection-status diagnosis.

**Already done — 2026-07-01 round** (§0.5): 3 Alpaca streams + `TRIGGER_ENGINE` enabled in
production; found+fixed a second independent stale-credential bug blocking 2 of those 3
streams; verified Robinhood fundamentals live and fixed a real sector/industry
taxonomy risk before it goes live.

**Blocked only on deploy (code is written, tested, and pushed — not yet on `trading-live`):**
1. `resolveAlpacaStreamAccount()` fix (§0.5/§9) — needed before the news/trade-updates
   streams actually succeed in production instead of reconnect-looping on `HTTP 401`.
2. `parseRobinhoodFundamentals` sector/industry fix (§0.5) — needed before it's safe to
   set `ROBINHOOD_ENRICHMENT_ENABLED=on`.
   Both are small, low-risk, already-tested diffs — this is a "when do we want to
   merge+deploy" decision, not further code work.

**Cheap, high-value, no new broker relationship required:**
3. Add `logApiHealth()` calls to the broker gateway paths in `alpaca.ts` and
   `robinhood.ts` (§1's gap) so the admin connection-status page can actually answer "is my
   broker connection healthy," not just "is an enrichment provider healthy." This is the
   most direct fix for the underlying confusion behind the user's original report.
4. Pull Alpaca's `GET /v2/account/activities` and Robinhood's `get_realized_pnl` as a
   periodic cross-check against this app's own fill/P&L records — cheap, high-confidence
   correctness signal for the exact "can we tell an order was placed" concern.
5. Add Alpaca portfolio history / calendar / clock — small, self-contained, no new broker
   relationship, immediate UI value (real equity curve, market-hours awareness).
6. Extend the chat assistant's `buildTools()` with 2-3 new read-only tools backed by real
   broker data (§7 Scenario 3) — e.g. earnings calendar, option chain lookup, realized
   P&L. Needs the owner to pick which 2-3 matter most before starting.

**Real feature work (needs its own design/plan, not a quick add):**
7. Robinhood options support — `BrokerGateway` would need an options-order surface
   distinct from equities; single-leg only per §4.
8. eToro / Public.com integration — gated on account access approval (eToro) or a
   licensing decision (Public.com's non-commercial clause), so these start with a
   business decision, not code. **Coordinate with Codex** (§0.5) — separate unmerged work
   on new-broker integration is already in flight; check for a pushed branch before
   starting anything here.
9. IBKR integration — gated on accepting an ongoing gateway-process operational
   commitment; do not start this without deciding who runs/monitors that process.

**Decision points for the owner (not auto-actioned):**
- Whether to keep paying for/calling `alpha-vantage` and `twelvedata` — both are
  confirmed 0% successful in production (§10.5). Not a code bug; a "is this vendor still
  worth it" call.
- `congress.trade` shows 0% success too, but that's the separate sibling app being
  unreachable/slow, not a paid-vendor question.
