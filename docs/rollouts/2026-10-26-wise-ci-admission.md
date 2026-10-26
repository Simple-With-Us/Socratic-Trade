# Restore verified Wise CI actor admission

## Context and objective

The footer repair ST-4583 is blocked before verification because its same-repo fix push comes from `swu-wise[bot]`.  CI, secret scanning and Playwright smoke explicitly admit Echo but omit Wise.  Echo verified Jay's October 20 decision that all swu bots are trusted CI actors; this correction adds only the known Wise app rather than an unchecked wildcard.

## Changes

- `.github/workflows/ci.yml`, `.github/workflows/security.yml` and `.github/workflows/e2e.yml`: add exact `swu-wise[bot]` to the existing actor list.
- `test/ci-wise-admission.test.ts`: execute the actual shell clauses against Wise, Echo and unknown bot names; preserve fork/same-repo checks.

No autofix steering, credentials, token permissions, review requirements, deployment settings or native shipping changes.  PR #4940 touches a separate ci.yml test-command hunk around line 370; this correction only touches actor admission around line 298.

## Authority and verification

The verified owner decision covers CI execution for fleet swu apps.  This exact Wise admission stays within that scope; autofix remains separately gated.

Targeted admission and queue-safety tests: 14 pass.  Scoped eslint and diff check pass.  Current-head hosted checks and Kody review remain required before merge.  This does not repair the footer by itself or prove a production deployment.
