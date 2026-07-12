# CI / Deploy workflows — reference

All workflow definitions are now **active** in `.github/workflows/`:

- `ci.yml` — the required `verify` check (tsc → vitest → build)
- `security.yml` — gitleaks secret scan
- `e2e.yml` — Playwright smoke (`npm run test:e2e`)
- `deploy.yml` — production deploy on push to `main`

They were previously **staged here** while the agents' push token lacked the GitHub OAuth
`workflow` scope. That scope is now present on the token `git push` uses (via
`gh auth git-credential`), and `scripts/land.sh` is scope-aware — so **agents can push
`.github/workflows/` changes directly**; `ci-pending/` staging is only the fallback if the
scope is ever missing. This directory now keeps only the deploy/runner setup notes below.

## Deploy workflow (`deploy.yml`)

Auto-deploys every push to `main` (i.e. every merged PR) to the self-hosted production
host, and exposes a manual **Run workflow** button. The single job runs on the
`trading-live` runner and, in `~/apps/trading-live`:

```
git fetch https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git main
git reset --hard FETCH_HEAD       # NOT `git checkout main` — see below
npm ci
npm run build
pm2 restart trading --update-env
pm2 save
```

Two non-obvious implementation details (each cost a failed first deploy — see the
2026-06-22 rollout note):

- **Auth via `GITHUB_TOKEN`, not the box's git creds.** The launchd runner has no stored
  git credentials and no TTY, so a plain `git fetch origin` against the HTTPS remote fails
  with `could not read Username … Device not configured`. The job fetches through the
  job-scoped `GITHUB_TOKEN` (auto-masked in logs; `contents: read` is enough) instead.
- **`reset --hard FETCH_HEAD`, not `checkout main`.** `~/apps/trading-live` is a *linked git
  worktree* sharing the clone with the `~/Code/Agentic Trading` integration worktree, which
  already has `main` checked out. Git refuses to check out `main` in two worktrees
  (`'main' is already used by worktree …`), so the deploy resets this worktree's working
  tree to the fetched commit without switching branches.

It only resets **tracked** files, so `.env.local`, `data/app.db`, and `data/logos/` in the
production worktree are preserved. Any uncommitted hand-edits to *tracked* files on the prod
box would be discarded — commit or stash those first.

### Self-hosted runner setup (recommended — matches the PM2-on-your-own-box layout)

`deploy.yml` targets `runs-on: [self-hosted, trading-live]`, so GitHub hands the job to a
runner you register on the production machine. No inbound SSH is exposed; the box pulls jobs.

The production box is an Apple Silicon (M-series) Mac, so use the **macOS ARM64** runner
package and run `svc.sh` **without `sudo`** (macOS uses a per-user LaunchAgent; `sudo` is a
Linux-only thing and throws `unable to allocate pty` here). Setup that worked:

1. GitHub → repo **Settings → Actions → Runners → New self-hosted runner**, **Architecture:
   ARM64**. Download/extract into a standalone dir **outside** the app (e.g.
   `~/actions-runner`, no spaces in the path), as the user that owns `~/apps/trading-live`
   and can drive `pm2`.
2. `./config.sh --url … --token …`; at the prompts: runner group → Default, name →
   `trading-live-mac`, **labels → `trading-live`** (the `self-hosted` label is automatic).
3. Install as a background service (no `sudo` on macOS):
   `./svc.sh install && ./svc.sh start` — survives logout/reboot; running `./run.sh` in a
   terminal instead would stop when the window closes.
4. Ensure `git`, `node` (24.x), `npm`, and `pm2` are on the service `PATH`. `config.sh`
   captures the configuring shell's PATH into `.path`, which on this box already included
   Homebrew (`/opt/homebrew/bin`). If a deploy ever fails with `npm`/`pm2: command not
   found`, add `echo "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" >
   ~/actions-runner/.env` then `./svc.sh stop && ./svc.sh start`.
5. Optional: set repo **Variables** `DEPLOY_DIR` / `PM2_APP` if your path or app name differ
   from the defaults (`$HOME/apps/trading-live`, `trading`).

### Alternative: deploy over SSH from a GitHub-hosted runner

Use this only if you prefer not to run a self-hosted runner AND the box is reachable over SSH
from GitHub's runners (e.g. a Cloudflare Tunnel `cloudflared access` SSH route or a public
port). Replace the `deploy` job's `runs-on`/`steps` with:

```yaml
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_SSH_HOST }}
          username: ${{ secrets.DEPLOY_SSH_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          port: ${{ secrets.DEPLOY_SSH_PORT }}   # optional, defaults to 22
          script_stop: true
          script: |
            set -euo pipefail
            cd "${DEPLOY_DIR:-$HOME/apps/trading-live}"
            git fetch origin main && git reset --hard origin/main   # avoid `checkout main` on a linked worktree
            npm ci
            npm run build
            pm2 restart "${PM2_APP:-trading}" --update-env
            pm2 save
```

Required repo **Secrets**: `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`
(a dedicated deploy private key whose public half is in the box's `~/.ssh/authorized_keys`),
and optionally `DEPLOY_SSH_PORT`. Never commit the key — store it only as a secret.
