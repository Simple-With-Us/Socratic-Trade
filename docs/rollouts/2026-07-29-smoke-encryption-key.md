# 2026-07-29 — Playwright Smoke ENCRYPTION_KEY fix [KIMI]

## Context & Objective
The `Playwright Smoke` workflow on `main` has failed on every run since
2026-07-29 07:08Z (runs 30430543832, 30437957889, 30448030331, 30471162885).
Smoke is NOT a required merge check, but a permanently red main-branch signal
hides real regressions and the nightly browser baseline is useless while it
fails. Owner directive this session: resolve all outstanding PR/CI issues
through merge + production deploy.

## Changes Made
- Root cause: the smoke `webServer` (`playwright.config.ts`) boots via
  `npm run build && npm run start`, i.e. `NODE_ENV=production`. Since #1787
  (`assertEncryptionKeyConfiguredInProduction` in `src/lib/db-api-keys.ts`,
  invoked from `instrumentation.ts`), production boot refuses to start without
  a valid 64-char hex `ENCRYPTION_KEY`. The smoke runner env has none, so the
  webServer crash-loops and every smoke run fails.
- Fix: set a fixed, clearly-labeled test-only `ENCRYPTION_KEY`
  (`"0123456789abcdef".repeat(4)`) in the Playwright `webServer.env`, alongside
  the existing `CF_ACCESS_TRUST_EMAIL_HEADER` / `PRIMARY_USER_EMAIL` smoke
  overrides. The smoke DB is a throwaway CI artifact, so a deterministic key
  carries no credential-rotation risk.
- Files touched:
  - `playwright.config.ts` (webServer env)
  - `docs/EFFORT-LOG.md` (effort row)
  - `docs/rollouts/2026-07-29-smoke-encryption-key.md` (this note)

## Decisions & Trade-offs
- Fixed key vs. generated key: a per-run `openssl rand` key would also pass the
  guard, but a fixed key keeps the config declarative and matches how the other
  smoke env overrides are expressed. No real credentials exist in the smoke DB,
  so key secrecy is irrelevant here.
- Did NOT touch the guard itself — refusing ephemeral keys in production is
  correct for a real-money trading app; the test harness was simply never
  updated when the guard landed.
- Committed via GitHub Contents API (no local checkout) because the
  `~/apps/trading-kimi` worktree had a concurrent Kimi session mid-commit at
  the time; avoided worktree contention entirely.

## Verification State
- Pattern match confirmed against the exact `webServer.env` block on
  `origin/main` before patching.
- Full gates run in CI: the required `verify` check on this PR runs
  `tsc --noEmit` → `npm test` → `npm run build`.
- Post-merge confirmation step: watch the next `Playwright Smoke` run on
  `main` (push-triggered) and confirm the webServer boots and tests execute.

## Next Steps & Blockers
- Merge on green `verify` (auto-merge armed), then confirm the next main-branch
  smoke run passes.
- Separately noted for owner: both X64 `socratic-ci` runners on `ci-cpx32`
  (77.42.35.209) are offline and the host does not answer ping/SSH — likely
  needs a Hetzner console reboot. All CI is currently draining serially through
  the single ARM64 runner `oracle-a1-socratic-ci`.
