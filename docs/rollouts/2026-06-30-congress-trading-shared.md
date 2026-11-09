# 2026-06-30 - Congress.Trade Shared Contract Package

## Summary

Integrated the private `@jaywedgeworth22/congress-trading-shared` package into Agentic Trading's Congress.Trade App A/B integration. The app now imports shared wire types, API path constants, and Zod schemas instead of keeping duplicated local definitions for transaction reads, outbound share payloads, and inbound event envelopes.

## Why

The two apps were carrying overlapping TypeScript contracts for the same cross-app API. Centralizing those contracts reduces schema drift and lets both sides share runtime validation. The first shared-package commit was not installable as a git dependency because its tarball contained only `package.json`; companion shared-package PR #1 adds `prepare`/build/publish metadata so git installs produce `dist`.

## Files

- `.github/workflows/ci.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/sync-previews.yml`
- `package.json`
- `package-lock.json`
- `scripts/cloud-setup.sh`
- `scripts/npm-ci-with-shared-deps.sh`
- `scripts/sync-preview-lanes.sh`
- `src/lib/congress-score.ts`
- `src/lib/congress-share.ts`
- `src/lib/congress-shared-aliases.ts`
- `src/lib/congress-trade-client.ts`
- `src/lib/congress-trade-events.ts`
- `src/lib/web-sources/congress-analytics.ts`
- `src/lib/web-sources/congress.ts`
- `src/lib/web-sources/types.ts`
- `test/congress-analytics.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/congress-trade-consume.md`
- `docs/congress-trade-share.md`
- `docs/rollouts/2026-06-30-congress-trading-shared.md`

## Decisions

- Pin the app dependency to shared-package commit `220677a3fb768c9e378404736e8f1f8c933220e1` until the package is published or a versioned release process is active.
- Keep private repo access narrow: set the shared repo's Actions access to `user` and add read-only deploy keys on the shared repo. Agentic Trading stores matching private keys as the Actions and Dependabot secret `CONGRESS_TRADING_SHARED_DEPLOY_KEY`; install entrypoints use `scripts/npm-ci-with-shared-deps.sh` so CI/smoke/deploy/cloud setup/preview sync load the key only for the `npm ci` process.
- Remove unrelated PR drift from the app branch: page-title copy changes, `scripts/deploy.sh`, and the auto-deploy `AGENTS.md` block do not belong to this integration.

## Verification

- Shared package: `npm run typecheck`
- Shared package: `npm run build`
- Shared package: `npm audit --audit-level=moderate`
- Shared package: `npm run pack:dry`
- Shared package: `npm run publish:dry`
- App: `npm install --package-lock-only`
- App: workflow YAML parse check with Ruby `YAML.load_file`
- App: `bash -n scripts/npm-ci-with-shared-deps.sh scripts/cloud-setup.sh scripts/sync-preview-lanes.sh`
- App: touched install-script ASCII check with Perl (`scripts/cloud-setup.sh`, `scripts/npm-ci-with-shared-deps.sh`, `scripts/sync-preview-lanes.sh`)
- App: clean install using the deploy-key private-git auth pattern: `npm ci`
- App: `npm run lint` - passed with the existing warning backlog and 0 errors
- App: `npx tsc --noEmit` - passed
- App: `npm test` - 159 files / 1537 tests passed
- App: `npm run build` - passed; existing Next middleware-to-proxy deprecation warning only

## Follow-ups

- Merge/publish `jaywedgeworth22/congress-trading-shared#1`, then move Agentic Trading from a pinned git commit to a versioned GitHub Packages release if desired.
- Rotate/delete the deploy key if this package moves to GitHub Packages and Agentic Trading no longer needs git-based private dependency access.
