# Socratic Trade Dashboard

Local-only Next.js dashboard for managing supported agentic trading accounts,
including Robinhood through MCP and Alpaca through API keys.

## For AI Tools And Contributors

Read these before changing code:

1. `AGENTS.md` for durable repo rules, verification commands, and cross-file traps.
   `CLAUDE.md` is a symlink to the same file so Claude Code reads identical rules.
2. `STATUS.md` for the current handoff snapshot.
3. `PLAN.md` for the roadmap and acceptance checks.
4. `docs/rollouts/` for chronological handoff notes so Codex, Claude Code,
   Antigravity/Gemini, Cursor, or a human can resume cleanly.
5. The relevant `docs/phase-*.md` and latest matching `docs/rollouts/*.md`.

Non-trivial changes must update `STATUS.md`, `PLAN.md`, the relevant phase doc,
and a dated rollout note before commit/push. Do not recreate a single
`docs/HANDOFF.md`; that was intentionally replaced by rollout notes.

## What It Does

- Shows accounts, portfolio, positions, orders, and an audit feed.
- Runs an equity strategy loop in either proposal-only or decision mode.
- Scans the allowed equity universe with delayed quote data, fundamentals,
  technicals, macro/market signals, and cached public web-source evidence before
  asking the LLM for proposals.
- Lets an LLM propose trades, then enforces deterministic policy gates before live order placement.
- Reviews broker-routed orders through the active provider before placement when
  the provider supports a review step.
- Uses idempotency keys for live order placement.
- Trades through a connected broker account (paper or live) from Accounts. An
  account's `environment` decides paper vs. live; there is no local-simulation
  fallback, so the app can't place orders until an account is connected.

## Safety Defaults

- Equity execution only.
- Allowlist required before autonomy can be enabled.
- Allowlist can be either a custom ticker list or the built-in S&P 500 universe.
- Max `$10` per order.
- Max `$500` daily notional.
- Max `25%` portfolio exposure per symbol.
- Max `10` live orders per day.
- Kill switch blocks new orders immediately.

## Allowed Universe

Use **Allowed Universe** in the dashboard controls:

- `Custom allowlist` lets you type comma- or space-separated tickers and saves on blur or Enter.
- `S&P 500` allows all locally generated S&P 500 constituent symbols from Wikipedia's constituents table fetched on 2026-06-14.

The S&P 500 universe is stored locally in `src/lib/sp500.ts`; the app does not fetch constituents at runtime.

## Strategy Authority

Use **Strategy Authority** in the dashboard controls:

- `LLM proposes` records reviewed recommendations but does not submit orders, even when live mode is on.
- `LLM decides` uses the existing autonomous path: policy gate, broker review when available, then Test, Paper, or Brokerage handling depending on the active account mode.

## Setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

For one-off local development, open `http://127.0.0.1:3000`.

On the host machine, prefer the PM2-managed previews:

- Production deployed app: `https://socratictrade.com` -> `http://localhost:4000` (`~/apps/trading-live`, pm2 `trading`)
- Main integration/review beta: `https://trading-beta.jays.services` -> `http://localhost:4001` (`~/Code/Agentic Trading`, pm2 `trading-main`)
- Codex live preview: `https://codex.jays.services` -> `http://localhost:4101` (`~/apps/trading-codex`, pm2 `trading-codex`)

Do not create a second dev/beta hostname for this lane; use `trading-beta.jays.services`.

Bootstrap or repair those PM2 previews with:

```bash
bash scripts/setup-agent-previews.sh
```

For older disposable Codex sessions, the legacy pinned launcher is still available:

```bash
npm run dev:codex
```

Open `http://127.0.0.1:3001`. The legacy Codex launcher frees only port `3001` and
retries there if Next initially falls back to another port.

If the UI appears as plain, unstyled HTML, the dev server is likely serving stale
`.next` assets after a build. Stop the old listener only on the port your agent
owns, then restart the matching dev command. If you intentionally want the old
force-clean behavior for the default Claude/local port, use `npm run dev:clean`;
the default `dev` script does not kill unrelated port-3000 processes.

## Environment

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini        # or gpt-4o for deeper reasoning
OPENAI_API_URL=...               # optional: override to use an OpenAI-compatible endpoint
ROBINHOOD_ADAPTER=mock           # "mock"/unset means Robinhood disconnected; "mcp" enables real Robinhood MCP
DATABASE_URL=file:./data/app.db
ENCRYPTION_KEY=...               # optional 64-char hex key; used for stored API keys
MARKET_SCAN_LIMIT=30
MARKET_SCAN_CACHE_TTL_MS=300000
MARKET_SCAN_EVENT_RESERVE=8
HISTORY_TTL_MS=1800000
MARKET_DATA_PENDING_TTL_MS=1800000 # how long an unfilled public OHLC request waits for a later shared cache fill
MARKET_DATA_SHARE_USER_KEYED_HISTORY=off # env-key/free OHLC is shared; user-keyed OHLC stays private unless set on

# Optional: fundamentals + analyst enrichment (Finnhub).
# Provides P/E, EPS, dividend yield, analyst ratings, sector/industry, and news
# sentiment per symbol. Yahoo Finance (no key required) is always the final
# enrichment tier, so every scanned symbol has real data even with no keys set.
# The scan's `source` field lists every provider that actually supplied data for
# that run (e.g. "nasdaq-delayed-screener+finnhub+yahoo-finance+alpaca-quotes");
# each table cell's tooltip names the single provider that value came from.
FINNHUB_API_KEY=...

# Optional: Financial Modeling Prep (adds P/E + analyst consensus; Finnhub preferred).
FMP_API_KEY=...
FMP_MAX_SYMBOLS=15               # cap enriched candidates per scan (free-tier quota friendly)
NEWS_CACHE_TTL_MS=21600000       # enrichment cache TTL (default 6h)

# Optional: Alpha Vantage NEWS_SENTIMENT enrichment.
ALPHAVANTAGE_API_KEY=...

# Optional: macroeconomic context injected into LLM prompt (Federal Reserve FRED API).
# Adds rates, inflation, labor, credit, oil, dollar, VIX/VIX3M, and derived curves.
# Without a key the prompt uses hardcoded recent defaults (updated periodically in macro.ts).
FRED_API_KEY=...

# Optional: public web-source and technical-signal controls.
SEC_EDGAR_USER_AGENT=SocraticTrade/1.0 (contact: you@example.com)
WEB_SOURCE_CONGRESS=on
WEB_SOURCE_INSIDER=on
WEB_SOURCE_FINRA=on
WEB_SOURCE_SEC8K=on
WEB_SOURCE_SEC8K_RAG_LIMIT=16      # cap SEC 8-K docs sent to Voyage/Pinecone per refresh
WEB_SOURCE_TECHNICAL=on
TECHNICAL_SOURCE=tradingview       # "tradingview" webhook or free "computed" Yahoo/Stooq OHLC
WEB_SOURCE_TECHNICAL_MAX=40
TRADINGVIEW_WEBHOOK_SECRET=...
TRADINGVIEW_WEBHOOK_IPS=...

# Optional: RAG context for filings/research.
VOYAGE_API_KEY=...
PINECONE_API_KEY=...
VECTOR_EMBED_BATCH_SIZE=8
VECTOR_EMBED_BATCH_DELAY_MS=21000  # unpaid Voyage accounts are limited to 3 RPM

# Optional: native Alpaca credentials. Users may also connect supported account
# types in Accounts; Paper accounts are optional and user-selected.
ALPACA_PAPER_API_KEY=...
ALPACA_PAPER_SECRET_KEY=...

# Optional/future provider keys routed through the per-user key system as it lands.
MARKETSTACK_API_KEY=...
TRADIER_API_KEY=...
MASSIVE_API_KEY=...
MASSIVE_REST_MAX_CALLS_PER_MINUTE=5 # Massive Basic quota guard; excess calls fall back/skip
MASSIVE_HISTORY_ENABLED=on          # set off to reserve Massive only for breadth/news
MASSIVE_NEWS_TTL_MS=1800000
MASSIVE_S3_ENDPOINT=...
MASSIVE_BUCKET=...
MASSIVE_ACCESS_KEY_ID=...
MASSIVE_SECRET_ACCESS_KEY=...

# Optional: webhook for trade notifications.
# Discord webhook URLs receive rich embeds; any other URL receives generic JSON.
WEBHOOK_URL=...
```

## Paper And Brokerage Accounts

- An account is an account: execution mode is decided purely by the connected
  account's `environment` — there is no local simulator and no "Test mode"
  fallback. With no connected account, the app cannot place orders.
- **Paper** is broker-hosted. Users enter Paper mode by connecting a supported
  provider's paper/sandbox account, such as Alpaca Paper. The app does not
  invent balances or fills for these accounts.
- **Brokerage** (live) is a production broker account, such as Robinhood MCP or
  Alpaca Brokerage. Broker-routed orders can affect real capital when policy,
  approval, and risk gates allow them.
- Both modes use the same market-data and policy paths; the account connection
  only changes where balances, positions, fills, and orders come from. (A
  `broker: "test"` gateway exists purely as test infrastructure for the unit
  suite — it is not a user-facing mode.)

To use a real MCP transport, set:

```bash
ROBINHOOD_ADAPTER=mcp
ROBINHOOD_MCP_URL=https://your-robinhood-mcp-server/mcp
ROBINHOOD_MCP_AUTH_TOKEN=...
```

The adapter calls MCP `tools/call` using JSON-RPC.

For hosted MCP servers that require OAuth instead of a static bearer token, leave
`ROBINHOOD_MCP_AUTH_TOKEN` empty. For Robinhood's official Trading MCP, the app
uses the documented MCP link (`ROBINHOOD_MCP_URL`) as the source of truth and
discovers OAuth endpoints from the MCP auth challenge:

```bash
ROBINHOOD_MCP_URL=https://agent.robinhood.com/mcp/trading
ROBINHOOD_MCP_RESOURCE=https://agent.robinhood.com/mcp/trading
# Optional. Leave blank in hosted environments; the app derives the public callback URL.
ROBINHOOD_MCP_REDIRECT_URI=
ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=off
ROBINHOOD_MCP_SCOPES=internal
```

For custom or non-discoverable MCP providers, set
`ROBINHOOD_MCP_OAUTH_DISCOVERY=off` and configure
`ROBINHOOD_MCP_AUTHORIZATION_URL`, `ROBINHOOD_MCP_TOKEN_URL`, and optionally
`ROBINHOOD_MCP_CLIENT_REGISTRATION_URL` / `ROBINHOOD_MCP_CLIENT_ID`.
When discovery is enabled for the official Robinhood MCP URL, discovered OAuth
endpoints take precedence over manual endpoint env values. `ROBINHOOD_MCP_RESOURCE`
defaults to `ROBINHOOD_MCP_URL` and is sent as the OAuth resource indicator on
authorization and token requests.
Then run the app locally and use Accounts -> Connect Robinhood Agentic Account
or open `/api/auth/robinhood/start` to complete consent. The app stores OAuth
state, the registered client, and refreshable tokens in the local SQLite
settings table.

For production behind the Cloudflare tunnel, the default is to leave
`ROBINHOOD_MCP_REDIRECT_URI` blank; the app will use `x-forwarded-host`,
`NEXT_PUBLIC_SITE_URL`, or `https://socratictrade.com` for
`/api/auth/robinhood/callback`. If Robinhood rejects the public callback during
the logged-in consent step, a same-machine operator can instead set
`ROBINHOOD_MCP_REDIRECT_URI=http://localhost:4000/api/auth/robinhood/callback`
and `ROBINHOOD_MCP_ALLOW_LOOPBACK_REDIRECT=on`. Public app login still starts
the flow; only Robinhood's provider callback returns through localhost, and the
state-bound callback redirects back to the public site after token storage.

## Tests

```bash
npx tsc --noEmit
npm test
npm run build
```

As of 2026-06-18 the suite is roughly 195 tests across 27 files; treat the
command output as authoritative because the count changes frequently.

## Design Docs

See `docs/` for phase-by-phase design notes, including `docs/phase-7-strategy.md`
(in-progress: trade-thesis tagging, post-mortem reflection loop, short-selling
support — see that doc's own risk-guardrail section before enabling `short`/`cover`
proposals in Live mode).

`docs/rollouts/` contains chronological handoff notes. Use these notes to
understand recent implementation decisions, verification results, and known
follow-ups before starting new work.
