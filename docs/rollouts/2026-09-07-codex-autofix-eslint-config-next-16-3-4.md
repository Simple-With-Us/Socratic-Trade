# 2026-09-07 — Codex-autofix handoff records for eslint-config-next 16.3.4 (PR #3181)

## Summary

Dependabot bumped `eslint-config-next` 16.3.1 → 16.3.4 (PR #3181, commit `fbc0f4fe1`).  Codex flagged the bump as missing the repo's mandatory handoff records (STATUS.md + docs/EFFORT-LOG.md) before landing.  Round 1 of this codex-autofix lane added those records so the repository snapshot and cross-agent ledger reflect the dependency upgrade.  Round 2 records the verification outcomes Codex asked for.  Round 3 (this round) adds the remaining handoff items Codex flagged on the round-2 tree:  the PLAN.md entry (and its place in the Files list) and a Decisions & Trade-offs section.  No runtime code changed.

## Why

The repo handoff protocol (AGENTS.md) requires STATUS.md and docs/EFFORT-LOG.md updates before a change lands on main, and the merge gate requires every Codex review thread to be resolved.  A Dependabot bump cannot write those records itself, so the codex-autofix lane adds them for PR #3181 — the same pattern already used for PR #3177 (`docs/rollouts/2026-09-07-codex-autofix-next-react-16-3-4.md`) and PR #3178 (`docs/rollouts/2026-09-07-codex-autofix-observability-group-bump.md`).

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-07-codex-autofix-eslint-config-next-16-3-4.md`
- `package.json` / `package-lock.json` (the dependabot commit `fbc0f4fe1` itself)

## Decisions & Trade-offs

- The bump aligns the repo's lint preset with Next 16.3.4's bundled `eslint-config-next`.  `eslint-config-next` is a dev-only dependency, so the change is confined to `package.json` / `package-lock.json` and lint-preset resolution; no runtime, API, middleware, or iOS path is affected.
- The ESLint 9 pin is deliberately unchanged.  `eslint-config-next@16` bundles `eslint-plugin-react@7.x`, which calls `context.getFilename()` — an API ESLint 10 removed — so moving to ESLint 10 would break lint at load.  Keeping `eslint` on `^9` preserves the repo's known-good gate.
- The handoff records are doc-only and follow the same codex-autofix pattern already used for PR #3177 / #3178 / #3179:  a STATUS.md snapshot entry, a docs/EFFORT-LOG.md row, a PLAN.md note, and this rollout note.  PLAN.md carries a minimal entry because the repo pre-commit protocol lists PLAN.md as a required handoff file for any landed change; there is no scope or timeline change to record beyond the bump itself.
- No lint/verify compatibility edge cases are left unaddressed beyond what the repo's verify gate already exercises:  `npx tsc --noEmit`, `npm test`, and `npm run build` all pass on this head (see Verification).

## Verification

Run 2026-09-07 in the codex-autofix runner at commit `7ba05fe0`:

- `npx tsc --noEmit` — PASS (exit 0).
- `npm run lint` — PASS, 0 errors (801 warnings are the grandfathered warn-only backlog).
- `npm test` — 9 failures across 5 files, all LLM-key-sensitive tests, caused by the runner's injected `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` being picked up as configured LLM keys.  Re-running those 5 files with the injected Anthropic env scrubbed passes (64 tests).  This is a runner-env artifact, not a regression from this PR (a devDependency bump only).  The repo's `verify` and `verify-hosted` checks are green on the same commit.
- `npm run build` — PASS (exit 0).

Overall build status: green.  The only local test failures are the runner-env LLM-key artifact above; CI (`verify-hosted`) passes the full suite on this head.

Round 3 re-ran the trio on the doc-only round-3 head with the runner's injected Anthropic env scrubbed (the runner injects `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, which LLM-key-sensitive tests otherwise pick up as configured keys):  `npx tsc --noEmit` — PASS (exit 0).  `npm test` — PASS, 712 files passed / 1 skipped, 7791 tests passed / 51 skipped (exit 0).  `npm run build` — PASS (exit 0).  Overall build status: green.

## Follow-ups

- Auto-merge (squash) lands PR #3181 once the required checks pass and the remaining Codex threads (PLAN.md handoff record and the Decisions & Trade-offs section) are resolved by this round.  No further code action expected.
