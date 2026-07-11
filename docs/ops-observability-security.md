# Ops Observability, Secrets, and Backup

This app now has opt-in scaffolding for the seven selected tools:

- **Infisical**: use `npm run dev:secrets`, `npm run build:secrets`, or
  `npm run start:secrets` to execute the app under `infisical run`. Configure
  `INFISICAL_PROJECT_ID`, `INFISICAL_ENV`, `INFISICAL_PATH`, and a machine identity
  token in the host environment. Do not commit `.env.local`.
- **Gitleaks**: `npm run gitleaks` runs a local secret scan. The GitHub Actions
  Security workflow runs the pinned gitleaks action on the self-hosted runner
  and clears stale macOS installer temp files before invoking the action.
- **Sentry**: full Next.js coverage across all three runtimes, env-gated and off by
  default. Set `SENTRY_DSN` for the server + edge runtimes
  (`sentry.server.config.ts` / `sentry.edge.config.ts`, loaded via the instrumentation
  hook) and `NEXT_PUBLIC_SENTRY_DSN` for the browser (`instrumentation-client.ts`).
  `next.config.mjs` is wrapped with `withSentryConfig` (org `jays-services`, project
  `socratic-trade`); set the build-time secret `SENTRY_AUTH_TOKEN` to upload source maps
  for de-minified production stack traces. `app/global-error.tsx` reports root-layout
  render errors. The previous build-wrapper instability did not reproduce on
  `@sentry/nextjs@10` + Next 16. Browser Session Replay is opt-in
  (`NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=true`) and masks all text + blocks all media when on.
  RAG provider failures, Pinecone index/metric checks, ingest budget trips, Pinecone Write
  Unit budget trips, malformed embedding rejections, and retrieval degradations are captured
  as warning/error events tagged `component=rag`, `rag.provider`, `rag.operation`, and
  `rag.key_source`; they stay no-op unless `SENTRY_DSN` is set.
- **Sentry Crons scheduler heartbeat**: a dead/hung scheduler still returns 200 from
  `/api/health`, so the scheduler tick can additionally report an "ok" check-in to the
  Sentry Crons monitor `scheduler-tick` every 60s tick (`sendSentrySchedulerCheckIn` in
  `src/lib/scheduler.ts`); Sentry alerts when check-ins stop. Opt-in — requires BOTH
  `SENTRY_DSN` and `SENTRY_CRONS_ENABLED=1` — placed after the single-leader gate so idle
  followers can't mask a dead leader, and fully try/catch-wrapped so monitoring can never
  break trading. The monitor is auto-created via the upsert config on first check-in
  (interval 1 minute, 5-minute checkin margin). Inertness is asserted by
  `test/sentry-inert.test.ts`.
- **Scheduler and strategy ownership leases**: scheduler single-leader coordination is ON by
  default, including when `SCHEDULER_SINGLE_LEADER` is unset or empty; only an explicit
  `false`/`off`/`0`/`no` disables it. Each strategy/approval invocation owns its account-scoped
  lease with a unique token. A 60-second heartbeat renews the five-minute strategy lease; refused
  or thrown renewals are caught and become sticky ownership loss, and the code synchronously
  re-proves ownership before it writes a placing intent or calls the broker.
- **Langfuse**: add `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. LLM calls are
  traced around Bull, Bear, Red Team, post-mortem, and strategy-tuning requests.
  The default `LANGFUSE_CAPTURE_IO=summary` captures model/schema/counts and
  proposal summaries, not raw prompt/account/portfolio text.
- **Dependabot**: `.github/dependabot.yml` watches npm dependencies. CI, smoke,
  and security workflows are active under `.github/workflows/`; see
  `STATUS.md` for the current runner policy.
- **Audit hardening**: npm overrides pin transitive Axios and PostCSS to patched
  releases, and Vitest is on the current major so its Vite dependency is patched.
- **Litestream**: continuous WAL replication of `data/app.db` to Cloudflare R2, run as
  a PM2 sidecar (`litestream`) via `scripts/run-litestream.sh` against `litestream.yml`.
  Restore with `scripts/litestream-restore.sh`. Full setup, monitoring, and DR steps are
  in `docs/litestream.md`.
- **Playwright**: `npm run test:e2e` runs a browser smoke test against a production
  `next build && next start` server on `PLAYWRIGHT_PORT`, or against
  `PLAYWRIGHT_BASE_URL` if one is supplied. If the Codex PM2 `next dev` preview is
  running in the same worktree, stop it before build/e2e checks and restart it
  afterward so both processes do not mutate `.next` at the same time.

## Local Setup

Install host CLIs:

```bash
infisical --version
gitleaks version
litestream version
```

Install Playwright's Chromium browser once per machine:

```bash
npx playwright install chromium
```

## Privacy Defaults

The telemetry path treats this as a financial application:

- Sentry `sendDefaultPii` is disabled.
- Sentry events run through `redactForTelemetry(...)`.
- Langfuse does not capture full prompts or portfolio/account details unless
  `LANGFUSE_CAPTURE_IO=full` is explicitly set, and even then it redacts common
  credential/account keys and long strings.
- Account numbers, API keys, tokens, cookies, webhook URLs, and encryption keys are
  redacted by key name.

## Production Notes

### Expensive admin-operation admission controls

The paid/batch/long-running admin actions are admitted through
`src/lib/admin-operation-guard.ts` after `requireAdmin` succeeds. Limits are keyed by the stable
middleware-derived admin user ID (never a query/body `userId`) and return HTTP 429 with
`Retry-After` when exceeded:

- SEC 8-K and 10-K reindexes: 2/hour each. Manual admin requests share one process-wide
  `rag-reindex` single-flight group, so those two route invocations cannot overlap.
- IC backtest: 10/5 minutes, one in flight per admin.
- Tuning dry run: 6/10 minutes and mutually exclusive with the public strategy-tune route for the
  same user.
- Congress score evaluation: 6/10 minutes, one in flight per admin.
- Congress daily share: 2/hour, one manual admin request in flight process-wide.
- Forced web-source refresh: 4/10 minutes, one manual admin request in flight process-wide.
- Robinhood MCP probe: 20/5 minutes, one in flight per admin.

An overlapping run returns HTTP 409 before the expensive callback starts **and before rate quota is
debited**, so duplicate-button/retry spam cannot exhaust the accepted entrant's budget. Rejections
use stable bodies: `code=rate_limited` with `retryAfterSeconds` for 429, and
`code=operation_in_flight` with `activeOperation` for 409. Admission state is process-local, matching
the current single-Next-process deployment; a multi-instance topology would need a shared
limiter/lease store before these controls could be treated as cluster-wide.

Explicit validation/config rejection runs before quota admission: empty 10-K symbols, missing Congress
credentials, unknown refresh IDs, and a disabled Robinhood adapter do not consume budget. Historical
routes that interpret an absent/malformed body as a real default action still enter admission. The
process-wide route groups do **not** yet coordinate scheduler/background calls to the
same underlying share, filing-ingest, or web-refresh functions; moving the lock to those operation
boundaries is tracked separately. These budgets are anti-repeat controls, not hard cost ceilings for one
accepted backfill; operator-selected batch/limit inputs remain unchanged.

- **Infisical is the canonical store for production secrets** (see `docs/secrets.md`
  and `docs/deployment.md` → "Configuration & secrets"); deliver them with the
  `*:secrets` runner and enforce it with `REQUIRE_SECRETS_MANAGER=1` so the app
  refuses to boot off a local `.env.local`. The Litestream sidecar reads
  `LITESTREAM_*` from its own environment (not the app's runner), so run it under
  `infisical run` too. Don't rely on hand-edited `.env.local`.
- Litestream runs under PM2 (`litestream` sidecar) next to production `next start` — see
  `docs/litestream.md`. Periodically verify a restore to a scratch path
  (`scripts/litestream-restore.sh /tmp/app.db.restored`) before treating backups as ready.
  **Status as of 2026-07-01 (G9a audit item): restore has not yet been exercised** —
  only replication is verified live (`docs/rollouts/2026-06-21-litestream-r2-live.md`).
  See the "Restore verification status" runbook section in `docs/litestream.md` for the
  drill procedure and where to log results once it's run.
- Browser Sentry and the `withSentryConfig` build wrapper are now enabled and validated
  against `npm run build`. To activate telemetry in prod, set `SENTRY_DSN` +
  `NEXT_PUBLIC_SENTRY_DSN` (the `NEXT_PUBLIC_*` values are inlined at build time, so set
  them before `next build`/`build:secrets`). Add `SENTRY_AUTH_TOKEN` (store in Infisical) to
  turn on source-map upload. Session Replay stays opt-in via `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED`.
  Set `SENTRY_CRONS_ENABLED=1` (with `SENTRY_DSN`) to arm the `scheduler-tick` Crons
  heartbeat and configure a missed-check-in alert on that monitor in Sentry.
