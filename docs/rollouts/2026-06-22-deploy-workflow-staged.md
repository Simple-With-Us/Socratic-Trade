# 2026-06-22 - deploy workflow staged in ci-pending

## Summary

- Added `ci-pending/deploy.yml`: a GitHub Actions workflow that auto-deploys
  `main` (every merged PR) to the self-hosted production host, plus a manual
  `workflow_dispatch` button.
- Expanded `ci-pending/README.md` with a Deploy section: activation command,
  self-hosted-runner setup steps, and a full SSH-based alternative with the
  required secrets.

## Why

- After merging PR #48 the user asked to deploy to "the actual site." Merging to
  `main` does not deploy: there is no deploy workflow, and production is a
  self-hosted PM2 box (`~/apps/trading-live`, app `trading`, socratictrade.com)
  unreachable from the cloud agent environment. This stages an automated path so
  future merges roll out without manual host steps.

## Design

- **Trigger:** `push` to `main` + `workflow_dispatch`.
- **Concurrency:** `group: deploy-production`, `cancel-in-progress: false` — no
  overlapping deploys; in-flight deploys finish rather than being cancelled.
- **Runner:** `runs-on: [self-hosted, trading-live]` (recommended for the
  PM2-on-own-box layout; no inbound SSH). SSH-from-hosted-runner documented as
  the alternative.
- **Steps:** `git fetch/checkout/reset --hard origin/main` → `npm ci` →
  `npm run build` → `pm2 restart <app> --update-env` → `pm2 save`, all in the
  production worktree. Only tracked files are reset, so `.env.local`,
  `data/app.db`, and `data/logos/` are preserved.
- **Config:** `DEPLOY_DIR` / `PM2_APP` repo Variables override the defaults
  (`$HOME/apps/trading-live`, `trading`), resolved with shell fallbacks so unset
  is fine.

## Why staged (not in .github/workflows/)

- The session's push credential lacks the GitHub OAuth `workflow` scope, so files
  under `.github/workflows/` are rejected on push. `ci-pending/` is a normal
  directory and pushes fine. Activate with a workflow-scoped token:
  `git mv ci-pending/deploy.yml .github/workflows/`.

## Files

- `ci-pending/deploy.yml` (new)
- `ci-pending/README.md` (expanded: Deploy section)
- `STATUS.md` (active-focus entry)
- `docs/rollouts/2026-06-22-deploy-workflow-staged.md` (this note)

## Verification

- `python3 -c "import yaml; yaml.safe_load(open('ci-pending/deploy.yml'))"` — valid YAML.
- No app code touched; tsc/test/build unaffected.

## Follow-ups

- Owner action required to go live: move `deploy.yml` into `.github/workflows/`
  with a workflow-scoped token, then either register the self-hosted runner with
  the `trading-live` label OR switch to the SSH variant and set the SSH secrets.
- One-time manual deploy to ship the already-merged changes before automation is
  active (transparent-logo default, tile fallback, framework docs): on the host,
  `cd ~/apps/trading-live && git pull origin main && npm ci && npm run build && pm2 restart trading && pm2 save`.
