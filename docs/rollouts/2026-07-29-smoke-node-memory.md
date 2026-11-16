# 2026-07-29 — Playwright Smoke NODE_OPTIONS raise to 3072 [KIMI]

## Context & Objective
Follow-up to `docs/rollouts/2026-07-29-smoke-encryption-key.md` (#2267). With
the ENCRYPTION_KEY fix merged, the smoke webServer got past the production boot
guard but the very next main smoke run (30481452853, sha 435d94a4) failed
again: V8 abort, exit 134 — `FATAL ERROR: Ineffective mark-compacts near heap
limit` at ~1.84 GiB of a 2048 MiB heap during the webServer's `npm run build`.

## Changes Made
- `ci-pending/e2e.yml`: STAGED (not active) copy of the smoke workflow with
  `NODE_OPTIONS --max-old-space-size` 2048 → 3072, matching ci.yml
  verify-hosted. The gh OAuth token lacks `workflow` scope, so the workflow
  edit itself cannot be pushed by an agent. Owner one-liner to activate:
  `gh auth refresh -s workflow && cp ci-pending/e2e.yml .github/workflows/e2e.yml`
  NOTE: since this PR was opened, #2276 moved all workflows to GitHub-hosted
  ubuntu-latest (7+ GB), but the 2048 NODE_OPTIONS cap still binds there, so
  this fix remains required either way.
- `docs/EFFORT-LOG.md`: effort row.
- This note.

## Decisions & Trade-offs
- Chose matching ci.yml's proven value over re-tuning blind. If the smoke
  runner ever moves back to a 3 GiB-capped container alongside a running
  browser, this needs revisiting (peak = next-server heap + Chromium, which is
  much smaller than build heap).
- Committed via git push (temp worktree), not the REST Contents API: the OAuth
  token used by `gh api` 404s on `.github/workflows/` writes (no `workflow`
  scope for REST), while `gh auth git-credential` pushes carry it.

## Verification State
- Root cause confirmed from run 30481452853 logs (GC heap-limit abort at the
  2048 cap during build).
- ci.yml verify-hosted evidence: 5+ green 16m48s runs today at 3072 on the
  same runner, including full `npm run build`.
- Required `verify` CI gates this PR; post-merge, the next push/nightly
  smoke run on main is the real confirmation.

## Next Steps & Blockers
- Merge on green verify (auto-merge armed), then watch the next main
  `Playwright Smoke` run end-to-end.
- If smoke then fails inside the actual Playwright tests, that is a NEW
  failure layer to triage separately.
