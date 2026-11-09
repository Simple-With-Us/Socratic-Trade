# 2026-06-22 — Fix Playwright smoke (prod-mode auth) + drop transactional fill+snapshot

## Summary

Two queued items resolved here:

1. **e2e smoke fix (implemented).** The Playwright `dashboard-smoke` spec failed:
   `getByText('Agentic Trading')` never became visible. Root cause: the smoke
   server is started with `next start` (`NODE_ENV=production`), so the auth
   middleware (`middleware.ts`) fails closed and redirects `/` → `/access-denied`
   for an unauthenticated request — the dashboard never renders. (The dev/test
   convenience that falls back to the primary user only applies when *not* prod.)

2. **Transactional fill+snapshot (dropped — not a safe fix).** See reasoning below.

## Changes

- **`playwright.config.ts`** — authenticate the test browser the way production
  does: set `CF_ACCESS_TRUST_EMAIL_HEADER=1` + `PRIMARY_USER_EMAIL=<smoke email>`
  on the `webServer.env`, and present `cf-access-authenticated-user-email` via
  `use.extraHTTPHeaders`. The middleware then trusts that verified-upstream
  identity (and it matches the allowlist as the primary user), so the authenticated
  dashboard renders. Email is overridable via `PLAYWRIGHT_AUTH_EMAIL`.

No change to `test/e2e/dashboard-smoke.spec.ts` or `ci-pending/e2e.yml` — the fix
is entirely in the committed config, so it applies automatically wherever
`npm run test:e2e` runs (locally and once `e2e.yml` is activated).

## Why transactional fill+snapshot was dropped

The queued item ("wrap fill + portfolio-snapshot writes in a transaction") is not a
valid/safe fix as scoped:

- `recordFillFromProposal` and `recordPortfolioSnapshot` are each a **single atomic
  INSERT**, written separately by design. The run loop writes a **pre-run** snapshot
  (baseline) and a **post-run** snapshot bracketing the per-proposal fills, so the
  equity curve is reconstructable even on a mid-loop crash.
- Coupling a **real-broker (live) fill's** durability to a second write would be
  *harmful*: if the snapshot write failed, the transaction would roll back the record
  of a trade that already executed at the broker — desyncing from reality.
- The real double-book/desync risks are already guarded: the **execution CAS**
  (`claimProposalForExecution`) prevents proposal re-execution; the **synthetic-stop
  claim** marks the stop `triggered` *before* the exit fill (`synthetic-stops.ts`),
  so a crash between the fill insert and the `lastPrice` upsert can't re-fire it.

This mirrors the earlier `fill_events` idempotency drop — both looked like fixes but
the money path is already protected, and forcing the change would add risk. Do not
re-attempt either without new evidence of an actual un-guarded failure.

## Follow-up (owner action)

Activating `e2e.yml` still requires a `workflow`-scoped token (the push credential
lacks it — same constraint as `deploy.yml`):

    git mv ci-pending/e2e.yml .github/workflows/

## Verification

Isolated worktree off `origin/main`, `npm ci`:
- `npx tsc --noEmit` — clean
- `npm run test:e2e` — `dashboard-smoke` passes (was failing)
- `npm test` (vitest) — unaffected, all pass
