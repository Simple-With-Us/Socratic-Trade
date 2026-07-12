# Production Deployment

Production is the self-hosted PM2 site at **socratictrade.com**, served by
`next start` (PM2 app `trading`) from the `~/apps/trading-live` worktree on the
owner's Apple Silicon Mac.

The pre-production beta route is **trading-beta.jays.services**, served by
`next dev` (PM2 app `trading-main`) from the editable integration checkout
`~/Code/Agentic Trading` on port `4001`. Production remains isolated on port
`4000`; beta should never point at an agent worktree such as `trading-claude`.

Cloudflare DNS, Tunnel ingress, Access apps, redirect-rule exclusions, and
documentation should use `trading-beta.jays.services` for the 4001 beta lane.
Do not create a second dev/beta hostname for this preview.

## Configuration & secrets — Infisical is the source of truth

**Every secret lives in [Infisical](https://infisical.com) (Cloud, free tier),
and the app launches through the Infisical runner, which injects them as env vars
at startup.** `.env.local` is **not** a secret source — it is git-ignored
(`.gitignore`: `.env`, `.env*.local`), never committed, and in production the app
is configured to **refuse to boot** off it (see *Enforcement* below). Full
runbook: `docs/secrets.md`; this is the deploy-side summary.

- **Run it:** `npm run start:secrets` (also `dev:secrets` / `build:secrets`) →
  `scripts/infisical-run.mjs` → `infisical run --env $INFISICAL_ENV --path
  $INFISICAL_PATH [--projectId …] -- next start`. The CLI authenticates, pulls the
  project's secrets, injects them into `process.env` **before** Next boots, and
  sets `SECRETS_SOURCE=infisical`. Injected values land before Next reads
  `.env.local`, and Next never overrides an already-set var, so Infisical always
  wins.
- **Projects** (slugs/IDs are identifiers, not secrets):
  - App secrets → **`Socratic.Trade`** (slug `socratic-trade`,
    project ID `39d93bb7-76f9-498c-8b50-a7def52e072f`), machine identity for the
    Socratic.Trade app project.
  - Shared App-A/B (congress-trade) secrets → **`shared-at-ct`**
    (`shared-at-ct-tg-v7`, `18f563a3-9c88-454c-96eb-28fc9678f3ba`), machine
    identity `shared-at-ct`. Set `INFISICAL_SHARED_CLIENT_ID` +
    `INFISICAL_SHARED_CLIENT_SECRET` (+ optional `INFISICAL_SHARED_PROJECT_ID`) and
    the runner pulls both projects, merging with the **app project winning** any
    overlapping key (shared is the fallback).
- **Bootstrap** (the only secrets-related values on the box — written to
  `deploy.env`/PM2 env, never in the repo): the machine identity's
  `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET` (universal auth — the runner
  mints a fresh access token each launch, so nothing expires), `INFISICAL_PROJECT_ID`,
  `INFISICAL_ENV=prod`. A pre-minted `INFISICAL_TOKEN` is an accepted fallback but
  expires — the Client Secret is **not** the access token (that mix-up is the
  "malformed token" 403).
- **Enforcement (ignore `.env.local`):** set `REQUIRE_SECRETS_MANAGER=1` on the
  box. At boot (`instrumentation.ts` → `assertSecretsManagerIfRequired`,
  `src/lib/secrets-source.ts`) the app **throws unless `SECRETS_SOURCE` is set** —
  i.e. unless it was launched via `start:secrets` — so a credential can never be
  silently served from a forgotten `.env.local`. Default off → no effect on local
  dev, tests, or CI.
- **`ENCRYPTION_KEY`** (decrypts the per-user `user_api_keys` and
  `connected_accounts` tables) is itself an Infisical secret and MUST stay stable
  — if it changes, every stored key becomes undecryptable after a restart.
- **Litestream sidecar** (`scripts/run-litestream.sh` / `litestream-restore.sh`)
  reads `LITESTREAM_*` from its **own** environment, not through the app's runner
  — run that PM2 process under `infisical run` too (or export its vars) so its R2
  credentials also come from Infisical.

> Production cutover: run `scripts/infisical-prod-cutover.sh` on the box (idempotent;
> needs your machine-identity `INFISICAL_CLIENT_ID` + `INFISICAL_CLIENT_SECRET`, or
> run it interactively and it prompts). It writes the bootstrap to
> `~/.config/agentic-trading/deploy.env`, imports `.env.local` into Infisical, and
> switches PM2 `trading` to `start:secrets`. From then on `deploy.yml` sources that
> bootstrap and builds via Infisical automatically — and falls back to a plain
> build/restart while the file is absent, so nothing breaks pre-cutover. See
> `docs/secrets.md`.

## How it deploys (automated)

`.github/workflows/deploy.yml` deploys on **every push to `main`** (i.e. every
merged PR) and via a manual **Actions → Deploy → Run workflow** button. The job
runs on the self-hosted runner labeled `trading-live` and, in `~/apps/trading-live`:

```
git fetch https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git main
git reset --hard FETCH_HEAD
npm ci
npm run build
pm2 restart trading --update-env
pm2 save
```

- A `deploy-production` concurrency group prevents overlapping deploys.
- `npm run build` intentionally runs `next build --webpack` while production
  still starts with `next start`; the default Next 16 Turbopack build did not
  emit the root `BUILD_ID` / route manifest files consumed by this runtime path.
- Only **tracked** files are reset, so `.env.local`, `data/app.db`, and
  `data/logos/` on the box are preserved.
- Auth uses the job's `GITHUB_TOKEN` (the headless launchd runner has no git
  creds); it resets to `FETCH_HEAD` rather than checking out `main` because
  `trading-live` is a linked worktree that can't share the `main` checkout held
  by the integration worktree. See
  `docs/rollouts/2026-06-22-deploy-workflow-activated.md` for the why.

## Preview lane sync

`.github/workflows/sync-previews.yml` runs on the same self-hosted Mac after
every push to `main` and calls `scripts/sync-preview-lanes.sh`.

The sync updates only local preview lanes:

- `trading-beta.jays.services` / PM2 `trading-main` / port `4001`
- `claude.jays.services` / PM2 `trading-claude` / port `4100`
- `codex.jays.services` / PM2 `trading-codex` / port `4101`
- `antigravity.jays.services` / PM2 `trading-antigravity` / port `4102`

Production remains owned by the Deploy workflow. Preview sync skips dirty
worktrees, unexpected branches, and merge conflicts. If a lane advances but
fails local `/api/health` or root-page checks, the script rolls that lane back
to its previous commit and restarts the PM2 app.

Optional PM2 polling fallback:

```bash
pm2 start ~/Code/Agentic\ Trading/scripts/sync-watchdog.sh --name trading-sync-watchdog
pm2 save
```

## Runner

A GitHub Actions self-hosted runner registered on the Mac:
`~/actions-runner`, labels `self-hosted,trading-live`, installed as a LaunchAgent
(`./svc.sh install && ./svc.sh start`, **no sudo** on macOS). Setup details and
the SSH-from-hosted-runner alternative live in `ci-pending/README.md`.

Optional repo **Variables** `DEPLOY_DIR` / `PM2_APP` override the defaults
(`$HOME/apps/trading-live`, `trading`).

## Manual deploy (fallback)

If the runner is down, deploy by hand on the box:

```bash
cd ~/apps/trading-live
git fetch origin main && git reset --hard origin/main
npm ci && npm run build
pm2 restart trading && pm2 save
```

## Verifying a deploy

- Actions → Deploy → latest run is green.
- `curl -I https://socratictrade.com/` returns a response (a `302` to the
  app `/login` page is expected for an unauthenticated request — it means the app is up).
- `curl -I https://trading-beta.jays.services/` should reach the beta tunnel service
  on `http://localhost:4001`.
- Auth.js sign-in is the site auth layer. The Cloudflare tunnel may stay in
  front of the app, but Cloudflare Access should not be the login gate for
  `socratictrade.com`. As of 2026-06-28, the Zero Trust Access app
  `agentic-trading-dashboard` keeps a bypass policy
  `42c4adc9-1421-416b-b744-f291afc87938` for that root hostname.
- The shared Infisical overlay still has legacy `CF_ACCESS_TRUST_EMAIL_HEADER=1`;
  the app prod project overrides it to `0`. App code ignores the variable, but
  keep the override while the shared key exists.
