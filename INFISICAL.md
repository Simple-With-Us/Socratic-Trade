# INFISICAL.md — Infisical is the sole source of truth

> Fleet directive 2026-10-03 (owner): **Infisical is the sole source of truth** for this app.
> "Truth" means secrets AND env variables AND tunable settings knobs — everything the app's
> behavior depends on that is not code.  Per-user settings stay in the app's own store and
> never go in Infisical.

This repo was already most of the way there: since the 2026-09-18 strict-Infisical cutover,
no `.env` files exist and `scripts/infisical-run.mjs` injects every secret from Infisical into
the process at boot (see `docs/secrets.md`).  This document records what changed for the
fleet SOT rollout: the in-memory settings cache, background refresh, and write-through on
admin saves.

## How settings flow

```
Infisical (shared-at-ct project, then socratic-trade project shadows it)
   |  scripts/infisical-run.mjs  (boot: export + inject; scrubs bootstrap creds after)
   v
process.env  (SECRETS_SOURCE=infisical)
   |  instrumentation.ts -> initInfisicalSettings()
   v
in-memory settings cache (src/lib/infisical-settings.ts)
   |  reads: peekSetting()/getSetting() — memory only, never per-request network
   |  refresh: 5-min background timer + SIGHUP + POST /api/admin/settings-reload
   v
server knobs: DB override > settings cache > boot env > catalog default
              (src/lib/server-knobs.ts)
```

## Credential modes (read this before "fixing" refresh)

The app process holds **no** long-lived Infisical identity in production — `infisical-run.mjs`
scrubs every bootstrap credential (`INFISICAL_CLIENT_ID`, `INFISICAL_ST_CLIENT_ID`,
`INFISICAL_TOKEN`, …) from the final app environment by design, so a leaked process env can
never mint new Infisical tokens.  The settings service therefore runs in two modes:

| Mode | When | Cache source | Refresh | Write-through |
|---|---|---|---|---|
| Credentialed | universal-auth clientId/secret supplied (tests, operator tooling) | Infisical REST (shared first, app shadows) | 5-min timer + SIGHUP + admin reload | `setSetting()` writes Infisical FIRST, then cache |
| Uncredentialed | production (runner scrubbed creds) | runner-injected `process.env` snapshot at boot | unavailable (logged loudly, reported in status) | unavailable — admin knob saves land the DB override and report `infisicalWriteThrough: false` |

Both modes serve reads from memory only after `init()`.  Refresh failures log loudly and keep
serving the last-known-good cache — staleness is safer than an outage.  Init is fail-soft: a
failed credentialed init falls back to the boot-env snapshot rather than failing boot.

## Key inventory

### Tunable server knobs (write-through surface: Admin > Operations)

These 16 keys are the app-level knobs with a real admin UI.  Admin flips call
`writeServerKnobThrough()` — Infisical first, then cache, then the DB override layer.

Workers: `SEC_INGEST_WORKER_ENABLED`, `SEC_INGEST_DAYTIME_ENABLED`,
`SEC_INGEST_TASKS_PER_TICK_RTH`, `SEC_INGEST_TASKS_PER_TICK_OFF_HOURS`,
`TRANSCRIPTS_DAYTIME_ENABLED`.
Streams: `STREAMS_ALPACA_NEWS_ENABLED`, `STREAMS_ALPACA_TRADE_UPDATES_ENABLED`,
`STREAMS_ALPACA_PRICE_EVENTS_ENABLED`, `CONGRESS_STREAM_ENABLED`.
Budgets: `R2_USAGE_DAILY_DIGEST`, `RAG_INGEST_BUDGET_ENABLED`,
`RAG_PINECONE_WRITE_BUDGET_ENABLED`, `SEC_FILING_RAG_MAX_PER_RUN`.
Retrieval: `RAG_VECTOR_READ_QDRANT`, `RAG_VECTOR_WRITE_QDRANT`,
`CONGRESS_SHARE_FUNDAMENTALS_ENABLED`.

Non-sensitive defaults for these keys are seeded in the project's `dev` environment so the
inventory is real; `staging`/`prod` values are operator-managed.  Clearing a knob in the UI
(`value: null`) clears only the DB override and leaves the Infisical value alone.

### Secrets (in Infisical; never in code, logs, or chat)

Broker: `APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `ALPACA_LIVE_API_KEY`,
`ALPACA_LIVE_SECRET_KEY`, `ALPACA_PAPER_API_KEY`, `ALPACA_PAPER_SECRET_KEY`.
Auth: `AUTH_SECRET`, `AUTH_GITHUB_ID`/`AUTH_GITHUB_SECRET`, `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`,
`AUTH_TWITTER_ID`/`AUTH_TWITTER_SECRET`, `AUTH_APPLE_ID`.
Data/embedding: `QDRANT_API_KEY`, `OPENROUTER_API_KEY`.
Ops: `ENCRYPTION_KEY`, `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_ST_API_TOKEN`,
`CONGRESS_TRADE_TOKEN`, `CONGRESS_TRADE_READ_TOKEN`, `CONGRESS_STREAM_SUBSCRIPTION_TOKEN`,
`USAGE_READ_TOKEN`, `ADMIN_REINDEX_TOKEN`, `ROBINHOOD_MCP_CLIENT_SECRET`.
Any secret key absent from an environment is "to be filled by the admin" — never invent,
guess, or copy a secret value.

### Env config (in Infisical)

Service URLs and wiring: `ALPACA_TRADING_BASE_URL`, `ALPACA_DATA_FEED`, `ALPACA_TRADE_WS_URL`,
`ALPACA_DATA_WS_URL`, `QDRANT_URL`, `QDRANT_COLLECTION`, `CONGRESS_TRADE_BASE_URL`,
provider base URLs (`OPENROUTER_API_URL`, `MINIMAX_API_URL`, `MOONSHOT_API_URL`,
`MISTRAL_API_URL`, `DEEPSEEK_API_URL`, `GEMINI_API_URL`, `XAI_API_URL`, `OPENAI_CHAT_URL`),
`ROBINHOOD_MCP_URL` + OAuth endpoints, `NEXT_PUBLIC_SITE_URL`, `PRIMARY_USER_EMAIL`
(+ `PRIMARY_USER_EMAIL_ALIASES`), `CF_ACCESS_*`, Datadog `DD_*`, `LITESTREAM_STATE_PATH`,
`DB_BOOTSTRAP`, `AUTH_COOKIE_DOMAIN`.

## Explicitly NOT in Infisical

- **Per-user settings** (app's own store — SQLite): per-user LLM daily budgets
  (`app/api/settings/llm-budget`), per-account broker API keys (`user_api_keys`, encrypted),
  per-user data-source settings (`app/api/settings/source-features`), per-user proxy settings,
  auto-resume, notification/delivery preferences, UI preferences.  The settings service never
  reads or writes these.
- **LLM runtime keys** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …): per-user Connections page,
  deliberately deleted from Infisical 2026-08-15.
- **Build/runtime constants**: `NODE_ENV`, `NEXT_RUNTIME`, `DD_VERSION`,
  `VERCEL_GIT_COMMIT_SHA`, `NEXT_PUBLIC_ALLOW_INDEXING` — not tunable settings.
- **Bootstrap-only**: the committed `.env.example` carries only the Infisical machine identity,
  `ENCRYPTION_KEY`, and the `REQUIRE_SECRETS_MANAGER` arming flag.  `ADMIN_USER_EMAILS`
  (the admin allowlist) lives in Infisical; see `src/lib/auth/admin.ts`.
- **Deliberately env-only safety interlocks** (still adjustable via Infisical, but never
  exposed as UI knobs so a mis-click cannot remove provider protection):
  `PROVIDER_RATE_LIMIT_DISABLED`, `API_CIRCUIT_BREAKER_DISABLED`,
  `LLM_PROVIDER_COOLDOWN_DISABLED`, `HEALTH_LANE_REPROBE_ENABLED`, `R2_COLD_SNAPSHOT_ENABLED`.
  See the exclusion list in `src/lib/server-knobs.ts`.

## Admin gating

The settings/secrets surface is admin-only: `POST /api/admin/server-knobs` and
`POST /api/admin/settings-reload` go through `requireAdmin()` (email allowlist
`ADMIN_USER_EMAILS` + optional `x-admin-token`) — non-admins get 403, and the Admin >
Operations UI is hidden for non-admins by `middleware.ts`.  "Admin" is the app's existing
admin concept; no parallel auth system was invented.

## Rotation

Rotate a value in the Infisical dashboard (or `scripts/infisical-secrets-safe.sh`): the
running app picks it up at the next 5-minute refresh, on SIGHUP, or via the admin
settings-reload route — no redeploy for knob/env-config values.  Secrets consumed once at
boot (broker keys, `ENCRYPTION_KEY`, `AUTH_SECRET`) still require a process restart; the
knob catalog's `effect` notes say when each flip takes effect.  Never commit a rotated
value anywhere; the old value stays valid until the provider side is rotated too.

## For agents

- Read `src/lib/infisical-settings.ts` before adding a new tunable setting.  New app-level
  knobs go in the `SERVER_KNOBS_CATALOG` (gets UI + write-through free); new secrets/env
  config go in Infisical + `docs/secrets.md`.
- Never add a direct `process.env` read for a setting that belongs in the settings cache —
  use `peekSetting()` (pre-init safe) or `getSetting()`/`getRequiredSetting()`.
- Never fetch Infisical per-request/per-tick.  Never put per-user settings in Infisical.
- The shared settings client is `createInfisicalSettings` from
  `@jaywedgeworth22/congress-trading-shared` (pinned `#v2.7.1` — fleet pin convention is an
  exact tag shared with Usage-Monitor; see `scripts/check-shared-package-pin.mjs`).
