# 2026-06-30 — Shared dependency via GitHub Packages (PR #279) + review fixes

## Summary

PR #279 switches `@jaywedgeworth22/congress-trading-shared` from a git/SSH-ref
install to the private **GitHub Packages** registry (`.npmrc`, `package.json`,
`package-lock.json`, and the `npm-ci-with-shared-deps.sh` helper). This rollout
note records the migration plus the follow-up fixes for the three Codex review
threads on the PR.

## Review follow-up (Claude)

- **P1 — production token leak via PM2 `--update-env` (`deploy.yml`).**
  `NODE_AUTH_TOKEN` was a job-level env var, so it remained in the shell through the
  `pm2 restart "$APP" --update-env` step (install + build + restart are one step),
  leaking the GitHub Packages token into the long-running production process's
  environment where runtime code could read it. Fix: `unset NODE_AUTH_TOKEN`
  immediately after `npm ci`, before build/restart. The token is only needed for the
  install.
- **P2 — preview sync had no package auth (`npm-ci-with-shared-deps.sh`, `sync-previews.yml`).**
  The helper only emitted npm.pkg.github.com auth when `NODE_AUTH_TOKEN` was set, but
  `sync-previews.yml` exported only `GITHUB_TOKEN`, so the first main push with the new
  lockfile would run `npm ci` unauthenticated and beta/agent preview worktrees would
  fail to refresh. Fix: the helper now falls back to `GITHUB_TOKEN` when
  `NODE_AUTH_TOKEN` is unset, and `sync-previews.yml` gains `packages: read`.
- **P2 — wrong token preferred for package installs (`ci.yml`, also `e2e.yml`, `deploy.yml`).**
  The chain `GH_PACKAGES_TOKEN || GH_PAT || GITHUB_TOKEN` preferred the Codex-Autofix
  PAT (`GH_PAT`, repo + workflow scope, **no** `read:packages`) over the packages-scoped
  job `GITHUB_TOKEN`, so in the common setup where only `GH_PAT` exists, installs would
  403. Fix: drop `GH_PAT` from the package-auth chain in all three workflows →
  `GH_PACKAGES_TOKEN || GITHUB_TOKEN`.

## Files

- `.github/workflows/deploy.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`; `unset` after install.
- `.github/workflows/ci.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`.
- `.github/workflows/e2e.yml` — drop `GH_PAT` from `NODE_AUTH_TOKEN`.
- `.github/workflows/sync-previews.yml` — add `packages: read`.
- `scripts/npm-ci-with-shared-deps.sh` — fall back to `GITHUB_TOKEN`.

## Verification

- `bash -n scripts/npm-ci-with-shared-deps.sh` — pass.
- YAML diffs reviewed for indentation; full `verify` + `smoke` + `gitleaks` CI gates the merge.

## Round 2 (Codex re-review)

- **Preview-sync token leak (same class as the deploy.yml P1):** `scripts/sync-preview-lanes.sh`
  restarted each preview with `pm2 restart --update-env` while `GITHUB_TOKEN` was still in the
  environment, so adding `packages: read` would have handed a package-capable token to every preview
  PM2 process. Now runs the restart via `env -u GITHUB_TOKEN -u NODE_AUTH_TOKEN pm2 restart ...` so
  the app never inherits the token (git fetch + npm ci above still use it).
- **ASCII-only script rule:** the fallback comment I added to `scripts/npm-ci-with-shared-deps.sh`
  used em dashes, violating the AGENTS.md `scripts/*.sh` ASCII-only rule; rewritten to ASCII.
- **Handoff docs:** `STATUS.md` and `PLAN.md` still described the old git+`220677a`-pin + deploy-key
  model; both now record the GitHub Packages registry switch (this PR).

## Round 3 (Codex re-review)

- **deploy.yml — `GH_TOKEN` also leaked into the PM2 restart:** the round-1 fix unset only
  `NODE_AUTH_TOKEN`, but the job-level `GH_TOKEN` (= `GITHUB_TOKEN`, which this PR grants
  `packages: read`) was still present and propagated via `pm2 restart --update-env`. Now
  `unset GH_TOKEN NODE_AUTH_TOKEN` before build/restart (both are only needed for the fetch + install).
- **Codex Autofix couldn't install the private package:** the autofix workflow lacked `packages: read`
  and a package token, so the agent's `npm install` (part of its verify trio) would 403 and it could
  not push fixes after review. Added `packages: read` + a job-level `NODE_AUTH_TOKEN`, and made
  `.npmrc` carry `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` so a plain `npm install`
  authenticates from the env var (empty/anonymous when unset — same tokenless behavior as before).

## Round 4 (Codex re-review) [codex-autofix]

- **`npm-ci-with-shared-deps.sh` — `GITHUB_TOKEN` fallback was outranked by project `.npmrc`.**
  The helper wrote the resolved token into a **userconfig** `.npmrc` (`NPM_CONFIG_USERCONFIG`),
  but the committed **project** `.npmrc` defines `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}`,
  and project config outranks userconfig. So a caller that only exported `GITHUB_TOKEN`
  (e.g. sync-previews) still resolved the higher-precedence project entry against an empty
  `NODE_AUTH_TOKEN` and 403'd on the private package. Fix: also `export NODE_AUTH_TOKEN="$NPM_PKG_TOKEN"`
  inside the auth block so the project `.npmrc` authenticates from the resolved (possibly-fallback) token.
- **`sync-preview-lanes.sh` — `GH_TOKEN` also leaked into the PM2 restart.** The restart stripped
  only `GITHUB_TOKEN` and `NODE_AUTH_TOKEN`, but the script supports a `GH_TOKEN` fetch path; a
  manual/alternate sync with `GH_TOKEN` set would leave that repo token in the long-running preview
  process via `--update-env`. Fix: add `-u GH_TOKEN` to the `env -u ...` restart (same class as the
  round-3 deploy.yml fix).
- Files: `scripts/npm-ci-with-shared-deps.sh`, `scripts/sync-preview-lanes.sh`.
- Verify: `npx tsc --noEmit` (pass), `npm test` (1578 pass / 165 files), `npm run build` (pass),
  `grep -nP '[^\x00-\x7F]' scripts/*.sh` (ASCII clean).

## Round 5 (Codex re-review)

- **`npm-ci-with-shared-deps.sh` — `GH_TOKEN` fallback now matches the fetch paths.**
  The helper already fell back to `GITHUB_TOKEN`, but local/operator preview syncs can use `GH_TOKEN`
  instead. The resolved package token now falls back through `NODE_AUTH_TOKEN`, `GITHUB_TOKEN`, then
  `GH_TOKEN`, and still exports `NODE_AUTH_TOKEN` for the project `.npmrc`.

## Follow-ups

- Confirm the `@jaywedgeworth22/congress-trading-shared` package grants `read` to the
  consuming repo so the job `GITHUB_TOKEN` (packages: read) can install it without a PAT.
- **Tokenless fresh-clone install (acknowledged):** switching the shared dep to a private registry
  means a bare `git clone` with **no** `NODE_AUTH_TOKEN`/`GITHUB_TOKEN` at all now fails `npm ci`
  (403) — inherent to the registry migration. CI/Actions and most cloud runners always provide
  `GITHUB_TOKEN`; for a truly tokenless local checkout the package README documents consuming the
  shared package from a git ref or local path. Follow-up: update the CLAUDE.md "no secrets required"
  cloud note to mention the package auth (or a git-ref fallback) for bare clones.
