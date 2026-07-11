# Phase 11 - Multi-user & API-key management (plan)

Goal: let multiple users use the app — logging in at the same or different times —
each getting analysis and trade proposals tailored to **their own preferences and
their own API keys**. With no connected broker account the app cannot place any
order by default; no live-trading behavior change.

**Current identity model:** middleware derives the request user from a verified
Auth.js v5 session. The Cloudflare tunnel may still expose the app, but
Cloudflare Access email headers are not trusted as app identity. The primary
operator and configured aliases still map to the legacy `local` dataset; other
allowed users map to isolated hashed user IDs only when present in
`ALLOWED_EMAILS`. When auth is not configured locally, development falls back to
`local`.

## What already exists (foundation)
- `user_api_keys` table + `getUserApiKey`/`listUserApiKeys`/`upsertUserApiKey`/
  `deleteUserApiKey`/`resolveApiKey(service, userId?)`/
  `resolveApiKeyWithSource(service, userId?)` in `src/lib/db.ts`. Service names are
  canonicalized, saved keys are encrypted, user keys win, and env vars remain the
  shared fallback.
- `connected_accounts` account storage for the default `local` user.
  Connected account credentials are encrypted at rest, omitted from dashboard
  snapshots, decrypted only for backend active-account use, and preserved when
  editing account metadata with blank key fields. Alpaca now resolves credentials
  from the active connected account and does not fall back to generic paper/env
  keys for a selected connected account with missing or unreadable credentials.
  Robinhood is connected through the MCP OAuth/status flow rather than manual API
  key fields, and users may connect one or more supported account types from
  Accounts. Paper accounts are optional; users do not need to connect one unless
  they want broker-hosted sandbox execution.
- Execution mode is derived purely from the active connected account's
  `environment` — `broker/paper` or `broker/live` — with no local-simulation
  toggle in the mix. When there is no connected account, `deriveExecutionState`
  (`src/lib/execution-mode.ts`) returns a distinct "No account" state
  (`mode: undefined`, `submitsBrokerOrders: false`): the app simply cannot
  place orders rather than falling back to a fake local fill. LLM prompts,
  post-mortems, strategy tuning, red-team review, and dashboard labels
  distinguish broker-hosted paper environments such as Alpaca Paper from live
  broker production accounts.
- Strategy-run audit lookups for Latest Decisions and Strategy Tuning are scoped
  by `connectedAccountId`, matching the per-account run lock/state model so a
  stale failure from one account does not appear under another selected account. Each approval
  invocation has its own owner token, and a heartbeat-loss guard refuses broker placement when
  that account-scoped ownership can no longer be proved.
- Dashboard Activity/Audit feeds and run history now follow the selected
  connected account as the default view, while retaining user-wide/system audit
  rows in account views for context. Rows display the account label when present,
  so the operator stream stays unified without hiding which account generated a
  strategy or broker event.
- Robinhood MCP now has a hardened Streamable HTTP path: the adapter defaults to
  Robinhood's official Trading MCP endpoint, sends `Accept: application/json,
  text/event-stream` plus `MCP-Protocol-Version`, parses both JSON and SSE `data:`
  responses, unwraps Robinhood's `data` envelope, and exposes
  `/api/broker/mcp/health` for OAuth/token and `tools/list` diagnostics. As of
  2026-06-27, Settings -> Accounts uses that health result to label stored
  Robinhood rows without a usable token as `OAuth Needed` with Reconnect instead
  of implying the account is fully connected. Robinhood OAuth start remains
  authenticated, but the provider callback is public, strips forged identity
  hints in middleware, and completes only against the one-time server-side OAuth
  state row. Hosted callback URLs are derived from forwarded/public site origin
  when the configured redirect is loopback, preventing production from sending
  Robinhood back to `localhost`.
- Dashboard snapshots now include `accountReadiness`, a server-derived status for
  the selected execution account. It keeps stored/backfilled connected-account
  rows visible for management while failing closed for actual execution readiness
  when OAuth/auth, broker account enumeration, selected-account availability,
  broker `agenticAllowed`, or portfolio/balance reads fail. This applies to
  Robinhood and Alpaca paths.
- Strategy profiles and prompts are now consistently scoped by `userId` for the
  default-user path; active-profile persistence writes to `user_settings`.
- Request-level user resolution now has central helpers,
  `resolveRequestUser(request)` and `resolveRequestUserId(request, body?)`, that
  read only middleware's trusted `x-authenticated-user-email` header. Body/query
  `userId` hints are ignored; local development falls back to `local` only when
  auth is not armed.
- Ops foundation is now scaffolded for hosted/multi-user readiness: Infisical CLI
  wrappers for secret injection, local Gitleaks scanning, Sentry runtime error
  capture, Langfuse LLM traces with redacted summary capture by default, npm
  Dependabot, Litestream SQLite backup scripts, and a Playwright dashboard smoke
  test. GitHub CI, Playwright smoke, and gitleaks Security workflows are active
  under `.github/workflows/` and currently use the self-hosted runner while
  GitHub-hosted billing is blocked. See `docs/ops-observability-security.md`.
- Market-data sharing is now explicit for the first keyed OHLC path: free/env-key
  history is cached as shared market data, while history fetched through a saved
  user key is private unless `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on` is set.
  Broker quote attribution also derives the actual provider (`alpaca-quotes`,
  `robinhood-quotes`, etc.) instead of hardcoding one broker in `MarketScan.source`.
- Public OHLC misses now write durable `market_data_demands` rows. If a later
  shared cache fill gets the same symbol before `MARKET_DATA_PENDING_TTL_MS`
  expires, the pending rows are marked fulfilled and open dashboards receive a
  `market-data` SSE refresh. This back-populates only from shared facts: env-key,
  no-key/free, or explicitly opted-in user-keyed history. A private user-key fill
  does not satisfy another user's pending demand.
- Mobile/PWA/native clients now share one backend command gateway rather than
  talking to every web endpoint directly. `/api/mobile/*` exposes a
  request-scoped snapshot, audited command queue/status model, SSE updates, and
  a multi-step account deletion flow. The phone PWA at `/mobile` and the
  SwiftUI starter in `ios/SocraticTrade/` both treat the backend as the source
  of truth; broker/provider secrets, MCP calls, scraping, calculations, and
  order placement stay server-side. See `docs/mobile-api-and-clients.md`.

## Milestones

### M1 `[done]` Connections Settings section (buildable now, single-user)
A Settings -> **"Connections"** tab listing provider keys with a status badge
(Set / Using env / Not set) and a masked input to save/clear each key. Stored
per-user via `upsertUserApiKey` under the default user.
- **LLM providers:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`,
  `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`.
- **Optional enrichment / signals:** `FINNHUB_API_KEY`, `FMP_API_KEY`,
  `ALPHAVANTAGE_API_KEY`, `MARKETSTACK_API_KEY`, `TRADIER_API_KEY`, `FRED_API_KEY`
  (macro), `SEC_EDGAR_USER_AGENT` (politeness).
- **No key needed (note this in the UI):** Yahoo Finance, Senate eFD, Capitol
  Trades, SEC EDGAR (UA only), FINRA short-volume.
- **Live trading (optional):** the `ROBINHOOD_MCP_*` credentials. The default
  Trading MCP URL is `https://agent.robinhood.com/mcp/trading`.
- Each row shows what it unlocks and links to where to get it. Never display stored
  secrets (mask), and never log them.

Current implementation: Settings -> Connections lists OpenAI, Anthropic,
xAI/Grok, Google Gemini, Mistral, DeepSeek, Finnhub, FMP, Alpha Vantage,
Marketstack, Tradier, FRED, SEC EDGAR User-Agent, and Massive with Set / Using
env / Not set badges, docs links, masked write-only inputs, Save, and Clear.
Backend `GET/POST/DELETE /api/keys` serves the same catalog and never returns
secret values. Strategy lets the selected account strategy choose a Green
Team model for proposal generation and an optional separate Red Team model for
Bear review; if no Red Team override is set, Red reuses Green. Connections owns
provider API keys only, while Account Settings -> Strategy keeps model behavior
account-scoped and credentials user-scoped.
The visible model list omits legacy OpenAI `gpt-4o`/`o1`/`o3` options from curated selectors,
keeps `gpt-5.4-nano` as the cheapest listed OpenAI option, offers Claude alongside
OpenAI for Green/Red Team and review work, uses current Gemini 3 selections
(`gemini-3.1-flash-lite`, `gemini-3.5-flash`, `gemini-3.1-pro-preview`), current
Mistral Small/Medium selections (`mistral-small-2603`, `mistral-medium-3-5`), and
current DeepSeek V4 selections (`deepseek-v4-flash` / `deepseek-v4-pro`) instead
of the older DeepSeek aliases. Provider-specific reasoning/thinking controls are
shown only for selected models that expose them.
Settings -> Operate stays focused
on universe, authority, horizon, and system Start/Stop controls. Settings ->
Accounts continues to own brokerage-account credentials. Settings -> Accounts
presents Robinhood through the same supported-account button
row as Alpaca. The client still checks `GET /api/broker/mcp/health` silently so
the Robinhood button can sync an authenticated MCP session or start OAuth, but it
does not render a separate disconnected MCP status panel. Stored Robinhood rows
now show `OAuth Needed` when the MCP token is absent/invalid, so stored metadata
cannot masquerade as a live balance/order connection. Mutable
account/key/order/policy route handlers touched by this flow are marked
`dynamic = "force-dynamic"` so production builds do not attempt static page-data
collection for request-bound operations.
API-key badges now distinguish "Your key" from "Operator env" so users can see
whether usage is attached to their stored credential or an operator fallback.

### M2 `[partial]` Route providers through `resolveApiKey(service, userId)`
Replace direct `process.env.X` reads in `data-providers.ts`, `macro.ts`, the LLM
caller, and `web-sources/*` with `resolveApiKey(service, userId)` so a user's own key
takes precedence, with the env var as the shared fallback. Keep capability-gating:
missing key → that provider is skipped (neutral/stale signal), never faked.

Current partial implementation: account settings are broker-aware rather than
Alpaca-only. Alpaca uses the active connected account first; Robinhood syncs the
agentic brokerage account through MCP after OAuth; and the account UI presents
supported account buttons instead of requiring a Paper account.
The direct Alpaca account form keeps endpoint details out of the top helper text,
infers Paper from either account number `PA...` or API key `PK...`, defaults Paper
to `https://paper-api.alpaca.markets/v2`, defaults live Brokerage to
`https://api.alpaca.markets`, and only asks for a custom endpoint when the user
explicitly enables that override. Alpaca IRA subtype detection is best-effort:
when broker payloads expose `account_type`/`account_sub_type`, the gateway maps
Roth/Traditional into account capabilities; otherwise manual tax treatment remains
the reliable source. The Accounts list keeps the user-entered Alpaca label as the
row title while showing Paper/Brokerage as broker environment metadata.
`resolveApiKey` now routes OpenAI proposal/tuning/red-team/post-mortem calls,
Finnhub/FMP/Alpha Vantage enrichment, FRED macro + macro history, Tradier/
Marketstack/Massive OHLC, Massive breadth/news/flat-file helpers, SEC EDGAR
User-Agent, Pinecone/Voyage, and Apify/congress (`fetchApifyCongress` accepts an
optional `userId` and calls `resolveApiKey("apify", userId)`). The chat `getLLM`
path also passes `userId` to `resolveLlmCredential` so per-user Anthropic/OpenAI
keys are respected in chat responses. Pinecone vector metadata/query filters use a
sanitized tenant ID, while Pinecone/Voyage credential lookup still uses the raw
app user ID so saved keys keep working for identity-provider IDs with punctuation.
Current API-key routes resolve their request user through the central request
helper and still default to `local` when no user hint is present. Remaining work
is mostly architectural: make every future keyed connector accept `userId`,
continue removing legacy direct env reads when new sources land, and verify
source attribution when a saved user key overrides env.

### M3 `[done]` Per-user preferences & policy
`TradingPolicy`, strategy profiles, prompt, and tuning are fully scoped by `userId`.
`getPolicy(userId)`, `setPolicy(policy, userId)`, `getStrategyPrompt(userId)`,
`setStrategyPrompt(prompt, userId)`, and all profile CRUD (`createStrategyProfile`,
`updateStrategyProfile`, `activateStrategyProfile`, `deleteStrategyProfile`,
`listStrategyProfiles`, `getStrategyProfile`) accept `userId` and filter by
`user_id = ?`. The legacy global `settings` rows for `policy` and `strategyPrompt`
are dead weight (never read at runtime); a one-time migration copies any
existing global rows to the `local` user so existing single-user DBs lose
nothing. A `DELETE /api/profiles/[id]` route was added with ownership-scoped
404 semantics; deletion of an active profile reassigns the active flag to the
oldest remaining profile. Two-user isolation is verified by
`test/per-user-policy-isolation.test.ts` (6 tests, all passing as of 2026-06-21).

### M4 `[partial]` Per-user data isolation
`fill_events`, `portfolio_snapshots`, `trade_proposals`, scorecards, and the
`web-sources` *datasets* — decide what's shared vs per-user. Market data + scraped
signals (congress/insider/FINRA) are **shared** (same for everyone, cached once);
**policies, proposals, fills, P&L, learning scorecards are per-user**. Add a
`user_id` column (default `local`) to the per-user tables and scope all queries.
Some default-user paths are already scoped, including proposal approval, daily
execution stats, strategy-run audits, fill reconciliation, fill insertion, and
portfolio snapshots. Current implementation also scopes paper portfolio projections,
thesis/regime/sector/signal/factor scorecards, tax and wash-sale reads,
and strategy profiles. Remaining work: deciding whether any
future learning materialization tables are shared or per-user.

Current market-data rule:
- **Shared by default:** public/free sources, env-key/system-key market data, web-source
  datasets, and generic quote/OHLC facts that do not reveal a user's account,
  positions, strategy, or watchlist intent.
- **Private by default:** user-saved keyed provider fetches, raw broker/MCP account
  responses, balances, positions, orders, fills, proposals, prompts, tuning choices,
  tax lots, and learning scorecards.
- **Opt-in shared:** user-keyed non-personal OHLC facts may enter the shared cache only
  with `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`, after the operator has confirmed
  entitlement/data-sharing policy for that deployment.
- **Pending demand:** a failed public OHLC request records that a user wanted the
  symbol, but it does not spend another user's key. A later shared cache fill can
  satisfy the old miss; a private user-key fill cannot. Events intentionally carry
  only fill metadata/counts, not the symbol, to avoid leaking watchlist intent over
  the shared SSE stream.

### M5 `[done]` Concurrent per-user execution
The background scheduler `src/lib/scheduler.ts` iterates over all active users and triggers `runStrategyOnce(userId)`. It runs concurrently with a bounded limit (e.g. `MAX_CONCURRENCY = 3`) to balance API rate limits with overall throughput, collecting due users and racing promises.

### M6 `[done]` Identity / auth (last)

Real identity via Auth.js v5 sign-in. Key changes:

- **Fail-closed arming signal fixed**: the previous `NODE_ENV === "production"` gate was
  unreliable in the edge runtime (Next.js inlines NODE_ENV at build time — at runtime in
  the live deployment `isProd` was always `false`, causing every request to fail open).
  Replaced with: `authConfigured = !!AUTH_SECRET`. This is evaluated at request
  time. The moment `AUTH_SECRET` is set, auth is armed.

- **Admin authorization is independently fail-closed**: middleware forwards an identity-source
  provenance header together with the authenticated email. `requireAdmin` accepts an allowlisted or
  primary email only when its source is verified Cloudflare Access or Auth.js; the auth-unconfigured
  `PRIMARY_USER_EMAIL` fallback never grants admin access. The timing-safe `x-admin-token` remains
  the explicit non-session operator path. `NODE_ENV` and request hostnames are never authorization
  signals, and there is no unauthenticated local bypass.

- **Identity sources** (first match wins):
  1. Auth.js v5 session JWT cookie, verified through the shared edge-safe HS256 helper.
  2. `PRIMARY_USER_EMAIL` fallback — only when `authConfigured=false` (local dev/tests).

- **Auth providers**: `src/lib/auth/auth.ts` configures Auth.js v5 with Google and GitHub
  providers when their credentials are present. GitHub requests `user:email` and accepts
  only a verified GitHub email, so a Google and GitHub sign-in with the same verified email
  lands on the same app user ID.

- **New files**: `src/lib/auth/auth.ts` (Auth.js v5 config, provider wiring, JWT strategy),
  `src/lib/auth/session-token.ts` (shared HS256 session encode/decode helper),
  `src/lib/auth/session-edge.ts` (edge-safe session cookie verifier),
  `app/api/auth/[...nextauth]/route.ts` (route handlers), `app/login/page.tsx`
  (provider sign-in buttons), and `app/logout/route.ts`.

- **Visible session controls**: the dashboard shows the signed-in email when available,
  exposes a Sign out command, and `/logout` clears Auth.js cookies before redirecting
  to the app's public `/login` page. It no longer calls Cloudflare Access logout.

- **Robinhood OAuth redirect/client integrity**: the OAuth callback route is public
  but state-bound, callback completion uses the redirect URI stored at OAuth start,
  and dynamic client registration takes precedence when
  `ROBINHOOD_MCP_CLIENT_REGISTRATION_URL` is configured. This prevents a stale
  static client id or callback-time localhost default from replacing the public
  production redirect/client during reconnect.

- **Inert until configured**: with no `AUTH_SECRET`/provider creds, behavior is unchanged
  (PRIMARY fallback). Middleware/auth tests cover fail-closed behavior, Auth.js cookies,
  ignored Cloudflare Access headers, public Auth.js routes, and protected Robinhood OAuth routes.

Per-user Robinhood account linking (originally noted in M6 scope) is deferred as a follow-up.

### M7 `[done]` App account deletion and re-onboarding

Signed-in users can start a deletion flow from Settings -> Data -> Delete this
app account. The server exposes one request-scoped endpoint:

- `GET /api/account/deletion` returns a preview for the verified user: current
  email, userId, whether the identity maps to the shared `local` operator
  dataset, connected accounts, private row counts, and blockers.
- `POST /api/account/deletion` prepares deletion. It halts that user's system,
  clears `strategy_run_lock:<userId>`, cancels any older prepared request, and
  records a fresh prepared deletion request. It does not delete data.
- `DELETE /api/account/deletion` performs the final deletion only after the
  user has prepared the request, typed the verified email, typed
  `DELETE MY ACCOUNT`, acknowledged app-data deletion, broker/API connection
  deletion, provider-revocation limitations, broker-position limitations, and
  fresh sign-in behavior. If `userId === "local"`, it also requires the
  `DELETE LOCAL OPERATOR ACCOUNT` phrase and an explicit local-operator checkbox.

Final deletion blocks with `409` while any strategy run is `running`, any
proposal is `placing`, or any broker-routed fill is still
`pending_reconciliation`. The app does not auto-cancel broker orders or close
broker positions during account deletion.

Deletion removes the user's private app rows from user API keys, connected
accounts, strategy profiles/runs/settings, proposals, snapshots, fills,
synthetic stops, notifications, watchlists, alerts, chat, user memory,
learned-context pending rows, learned-context rows where they are either owner
or contributor, LLM usage, market-data demands, and normal audit events. It also
clears per-user Robinhood MCP OAuth tokens and pending OAuth states while
preserving the global MCP client registration. The only retained deletion record
is `account_deletion_audit`, which stores a non-reversible subject hash, schema
version, timestamps, and row counts; it does not store raw email, raw userId,
symbols, broker account numbers, chat text, proposal JSON, or credentials.

Provider identity deletion is intentionally separate. This app cannot delete a
Google account, GitHub account, Apple ID, or broker account. After app-data deletion, signing in
again with Google, GitHub, or Apple can create a fresh empty app account; users who also
want to remove the OAuth grant should revoke the app from their Google Account
third-party access page, GitHub Authorized OAuth Apps, or Apple ID Sign in with Apple settings. Before
Apple private-relay identities become a first-class login path, add a
`user_identities` table keyed by provider + provider account id so identity is
not derived from relay email alone.

Help and Data Sources copy should be updated in the same change whenever a
provider, source, API-key destination, account-flow label, or user-facing system
description changes. The Help modal should reflect the actual provider stack,
avoid giving one provider special treatment unless the runtime does, and link
source names to their provider or API-key pages when applicable.

### M8 `[foundation]` Shared mobile API, PWA, and SwiftUI client

The mobile path is intentionally a backend-mediated command system, not a second
set of trading controls:

- `mobile_commands` stores command id, authenticated user, idempotency key,
  command type, payload, status, result/error, client metadata, and timing fields.
- `POST /api/mobile/commands` validates and queues commands; the backend worker
  claims queued rows, runs the existing server-side trading/account/watchlist/
  alert/policy functions, audits success or failure, and emits status events.
- `GET /api/mobile/snapshot` packages the dashboard snapshot into a phone-friendly
  response with readiness, policy, portfolio, positions, proposals, accounts,
  watchlist, alerts, and recent commands.
- `GET /api/mobile/events` streams command and dashboard freshness updates for
  the signed-in user.
- `/mobile` is a phone-first PWA control surface using the same command model as
  the native app. It has clear Start/Stop/Close-only/Run-once controls, approval
  cards, watchlist and alert controls, command history, backend-source-of-truth
  messaging, and a danger-zone deletion workflow.
- `ios/SocraticTrade/` provides a SwiftUI starter that uses the same endpoints
  and keeps only the backend session on-device.
- Account deletion routes reuse the audited M7 deletion lifecycle: prepare first,
  type the signed-in identity and required phrase, then confirm/sign out with
  provider-side guidance for optional OAuth grant revocation.

## Sequencing & risk
M1 → M2 are near-term and low-risk (additive; default user). M3–M5 are the real
architectural lift (userId scoping across the DB + scheduler) and should land
together behind the existing single-user default so nothing breaks during testing.
M6 (auth) is deliberately last.

Ops hardening should remain additive while Phase 11 is incomplete: Sentry and
Langfuse stay disabled until DSNs/keys are configured, Infisical wraps existing
commands instead of changing local `.env.local` behavior, and Litestream restore
commands must not overwrite an existing DB without a separate manual decision.

## Acceptance
Single-user behavior is byte-for-byte unchanged with the default user; adding a key
in Settings makes that provider use it (verified via the source attribution string);
two users with different policies produce different proposals from the same shared
market data; secrets are never shown or logged; with no connected broker
account the app cannot place orders by default.
