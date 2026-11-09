# CI workflow publishing reference

Active workflow definitions live directly in `.github/workflows/`. The GitHub
credential used by `scripts/land.sh` has the `workflow` scope, so this directory
is only a fallback staging location if that scope is ever removed.

Production deployment is not a GitHub Actions job. Coolify's GitHub App
auto-deploys every push to `main`; see `docs/deployment.md` and
`docs/rollouts/2026-07-10-auto-deploy-on.md`.

The retired Mac/PM2 `.github/workflows/deploy.yml` workflow and its
`self-hosted,trading-live` runner instructions were removed on 2026-07-11. Do
not restore them while Coolify is the production scheduler: a second live PM2
process could trade the same connected accounts concurrently.
