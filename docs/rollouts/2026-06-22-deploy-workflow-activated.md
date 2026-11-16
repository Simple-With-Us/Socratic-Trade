# 2026-06-22 - deploy workflow activated (self-hosted runner)

## Summary

Production now auto-deploys on every push to `main` via a GitHub Actions
**Deploy** workflow running on a self-hosted runner on the production Mac. Getting
there took the initial activation plus three fixes, each surfaced by a failed
deploy run.

## Why

After merging the docs + ticker-logo work, the user asked to deploy to the live
site. There was no deploy automation (only CI/e2e/security/Dependabot), and
production is a self-hosted PM2 box unreachable from the cloud agent env. We
staged `deploy.yml` (see `2026-06-22-deploy-workflow-staged.md`), then activated
and debugged it end-to-end with the owner.

## What shipped (chronological)

1. **Activation — PR #79.** Moved `deploy.yml` from `ci-pending/` into
   `.github/workflows/`. Direct pushes to `.github/workflows/` need the GitHub
   OAuth `workflow` scope (the agent push token lacks it) AND `main` is
   branch-protected (PR + `verify` required), so this was done via the GitHub
   API on a branch → PR → merge. A **Deploy** workflow then registered.
2. **Self-hosted runner** registered on the production Mac (Apple Silicon):
   ARM64 runner package, in `~/actions-runner`, labels `self-hosted,trading-live`,
   name `trading-live-mac`, installed as a LaunchAgent via `./svc.sh install`
   (no `sudo` on macOS — `sudo` gave `unable to allocate pty`).
3. **Fix 1 — git auth (PR #81).** First run failed in 8s: `git fetch origin main`
   → `could not read Username for 'https://github.com': Device not configured`.
   The launchd runner has no git creds / no TTY. Fix: fetch via the job's
   `GITHUB_TOKEN` (`https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git`),
   `permissions: contents: read`.
4. **Fix 2 — linked worktree (PR #82).** Next run got past auth but failed:
   `fatal: 'main' is already used by worktree at '/Users/jay/Code/Agentic Trading'`.
   `~/apps/trading-live` is a linked worktree of the same clone that already has
   `main` checked out. Fix: `git reset --hard FETCH_HEAD` instead of
   `git checkout -B main` — update the working tree without switching branches.
5. **PATH** turned out fine — `config.sh` had captured Homebrew (`/opt/homebrew/bin`)
   into the runner's `.path`, so `npm`/`pm2` resolved without extra config.

**Result:** Deploy run #6 succeeded on `trading-live-mac` (all steps green;
fetch → reset → `npm ci` → `npm run build` → `pm2 restart trading` → `pm2 save`).
`https://socratictrade.com/` returns HTTP 302 (the prod auth gate), i.e. the
site is up and serving the merged code (transparent ticker-logo default + tile
fallback, source-picker removal, strategic-framework docs/PDF).

## Final deploy.yml shape

- `on: push: branches: [main]` + `workflow_dispatch`.
- `concurrency: deploy-production`, `cancel-in-progress: false`.
- `runs-on: [self-hosted, trading-live]`, `permissions: contents: read`,
  `env.GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, optional `DEPLOY_DIR`/`PM2_APP` Variables.
- Steps as in Fix 1/2 above; resets only tracked files so `.env.local`,
  `data/app.db`, `data/logos/` are preserved.

## Files

- `.github/workflows/deploy.yml` (added via PRs #79/#81/#82, on `main`)
- `ci-pending/deploy.yml` (removed — moved into `.github/workflows/`)
- `ci-pending/README.md` (now an operations reference; deploy section updated to
  the real token-auth + `FETCH_HEAD` design and macOS/ARM64 runner setup)
- `STATUS.md` (deploy-live entry)
- `docs/deployment.md` (new — concise production deploy runbook)
- `docs/rollouts/2026-06-22-deploy-workflow-activated.md` (this note)

## Verification

- Deploy run #6: success, all steps green on `trading-live-mac`.
- `curl -I https://socratictrade.com/` → HTTP 302 (auth gate; site live).
- CI `verify` + `gitleaks` green on PRs #79/#81/#82 before merge.

## Follow-ups / notes

- Docs handoff for the deploy PRs (#79/#81/#82) was skipped during the live
  debugging; this note + the STATUS/README/deployment-doc updates backfill it.
- The owner's browser identity hit `/access-denied` on the live site — expected
  auth-gate behavior; their email needs to be on the allowlist
  (`PRIMARY_USER_EMAIL` / `ADMIN_USER_EMAILS` / Cloudflare Access policy). Not a
  deploy issue.
- Every future merge to `main` now deploys automatically; manual redeploy via
  Actions → Deploy → Run workflow.
