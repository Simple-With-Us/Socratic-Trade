# ST-3854: Quiver retired lanes — durable report sanitize + admin footnote

## Context & Objective

ST-3854 / PR #4217 already moved the five Quiver carrier fields into `COVERAGE_RETIRED_LANE_FIELDS` and removed them from `COVERAGE_TRACKED_FIELDS`.  Production can still serve pre-merge `enrichment_coverage_runs.report_json` rows that list those fields at 0%, which keeps the admin board noisy after redeploy.  This follow-up sanitizes on read and documents retired lanes in the API/UI.

## Changes Made

- `sanitizeEnrichmentCoverageReport()` strips retired-lane rows from `fields`, `missingFields`, and `partialFields`.
- `resolveEnrichmentCoverageReport()` always returns a sanitized report.
- New builds stamp `retiredLaneFields` on `EnrichmentCoverageReport`.
- Admin enrichment-coverage page shows a one-line retired-lane footnote (not scored).
- Playwright visual regression for the footnote (`test/e2e/admin-enrichment-coverage-visual.spec.ts`) with a **separate** admin webServer (`playwright.admin.config.ts` + deterministic test `AUTH_SECRET` via `playwright-admin-auth.ts`). Default smoke harness (`playwright.config.ts`) stays auth-unconfigured (PRIMARY_USER_EMAIL fallback).
- Regression tests for sanitize and `retiredLaneFields` on build.

Files:

- `src/lib/enrichment-coverage.ts`
- `src/lib/db-enrichment-coverage.ts`
- `app/admin/enrichment-coverage/enrichment-coverage-client.tsx`
- `test/e2e/admin-enrichment-coverage-visual.spec.ts`
- `test/e2e/playwright-session.ts`
- `test/e2e/playwright-admin-auth.ts` (CI: `PLAYWRIGHT_AUTH_SECRET`; local: gitignored file)
- `test/e2e/playwright-throwaway-fixtures.ts` (hash-derived throwaway `ENCRYPTION_KEY`)
- `playwright.admin.config.ts`
- `playwright.config.ts` (`testIgnore` for admin spec)
- `package.json` (`test:e2e:admin`)
- `.github/workflows/e2e.yml` (runs admin suite after smoke)
- `test/e2e/admin-enrichment-coverage-visual.spec.ts-snapshots/enrichment-coverage-retired-lanes-footnote-chromium-linux.png`
- `test/enrichment-coverage.test.ts`
- `docs/rollouts/2026-10-15-st-3854-quiver-coverage-sanitize.md`
- `STATUS.md`

## Decisions & Trade-offs

- Exclusion over N/A rows in the table (matches #4217 rollout); footnote only for discoverability.
- Sanitize on resolve, not on persist — avoids rewriting historical SQLite rows.

### codex-autofix round 1 (2026-10-15)

- The two Kody visual-coverage threads were already answered in a prior round (asked rather than guessed;
  the cited `visual-tests/` directory does not exist in this repo — coverage lives in `test/e2e/visual.spec.ts`).
- Two new threads, one finding: a hardcoded `PLAYWRIGHT_AUTH_SECRET` fallback string (38 chars, punctuation
  suffix) duplicated at `playwright.config.ts:19` and `test/e2e/playwright-session.ts:6` — **not** quoted in
  this doc (rule 35); the literal was removed from the tree in `636ef4d0` / follow-ups.
- Round cap: 0 prior `[codex-autofix]` commits on this branch (the 9 `[codex-autofix]` commits visible in
  `git log` belong to `main`'s history, not this branch).

**Why this round escalated rather than fixed on its own.**  Kody's proposed patch makes both call sites
hard-throw when `PLAYWRIGHT_AUTH_SECRET` is unset.  That value was set nowhere in CI at the time —
`.github/workflows/e2e.yml` referenced no `secrets.*` at all, so the throw would have fired on **every**
smoke run, and `e2e.yml` triggers on `push: main` plus a nightly schedule.  Making it work requires editing
`e2e.yml`, which is out of bounds for the fixer role, so blind adoption would have broken the main branch.

**Outcome: a concurrent agent landed a superset fix while this round was in flight** (`636ef4d0`, `938ef2e0`,
`0e7a45e3`, `e62c9feb`).  The literal is gone from the tree entirely:

- `test/e2e/playwright-admin-auth.ts` — reads `PLAYWRIGHT_AUTH_SECRET` from env, **hard-throws under `CI`**,
  and otherwise creates/reuses a per-worktree `0600` random secret file.
- `test/e2e/playwright-throwaway-fixtures.ts` — derives the throwaway `ENCRYPTION_KEY` with
  `sha256(...)` instead of a literal.
- `e2e.yml` generates the CI secret with `openssl rand -hex 32` and runs the admin suite as a separate
  `test:e2e:admin` step, so the smoke server keeps running with auth genuinely unconfigured.

That keeps the fail-closed posture Kody wanted without a repo literal, and also removes the pre-existing
`ENCRYPTION_KEY` literal that made the original finding inconsistent within a single file.  This round's
`origin/main` merge proved redundant (already merged upstream) and was dropped; the round commits docs only.

**Thread state.**  Both AUTH_SECRET threads anchor to code that no longer exists — they are outdated and
were resolved per protocol.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npx vitest run test/enrichment-coverage.test.ts test/enrichment-coverage-persistence.test.ts test/source-value.test.ts
npm test
npm run build
```

codex-autofix round 1 verification:

```bash
npx tsc --noEmit   # clean, exit 0
npm test           # 13 failures, all pre-existing (see below)
npm run build      # clean, exit 0
```

`npm test` exits 1 with 13 failures across `test/llm-provider.test.ts`, `test/chat-llm.test.ts`,
`test/framework-review.test.ts`, and `test/openrouter-credits.test.ts`.  These are **not** caused by this
PR — none of those files are in its diff.  Reproduced identically on a clean `origin/main` worktree
(`13 failed | 47 passed (60)` over the same 4 files): the assertions assume no provider keys are present,
and this sandbox's environment has OpenRouter/native keys injected.  Same class of failure already recorded
in `STATUS.md` for PR #4716.  The PR's own suites are green:
`test/enrichment-coverage.test.ts`, `test/enrichment-coverage-persistence.test.ts`,
`test/auth-secret-guard.test.ts` → 28/28 passed.

Note: those failure messages print credential-shaped values into test output.  Treat any key seen there as
compromised and rotate it; do not paste it into a PR or thread.

## Next Steps & Blockers

- Deployer merges PR; Linear ST-3854 can move to Done after verify on prod admin page.

## Zero-Code Findings

Core ST-3854 code landed in #4217 (`a8e23a64`); this PR closes the durable-report gap only.
