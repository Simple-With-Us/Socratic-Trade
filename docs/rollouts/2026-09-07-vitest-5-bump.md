# 2026-09-07 — Vitest 5.0.0 upgrade recorded in handoff state (codex-autofix on PR #3179)

## Context & Objective

Dependabot PR #3179 bumps the testing group's `vitest` from `^4.1.11` to `^5.0.0`
(commit `37e8850d`).  The Codex PR reviewer flagged a P1: the bump commit changed only
`package.json` + `package-lock.json`, leaving `STATUS.md` and `docs/EFFORT-LOG.md`
untouched, so the upgrade is invisible to the owner and other agent lanes.  This
doc-only change records the upgrade and its verification state before landing.

## Changes Made

- `STATUS.md` — added a dated snapshot noting the Vitest 5.0.0 bump, that it is a
  dev-dependency (no runtime path), and that the `verify` / `verify-hosted` CI gate runs
  the trio before auto-merge.
- `docs/EFFORT-LOG.md` — added a `[codex-autofix]` row for the bump, marked OPEN
  (PR #3179 not yet merged).
- `docs/rollouts/2026-09-07-vitest-5-bump.md` — this note.

No source/config change: the Vitest major bump itself is left exactly as Dependabot
authored it.  If `verify` / `verify-hosted` reveal a Vitest 5 incompatibility, that is a
separate follow-up and this PR would not merge.

## Decisions & Trade-offs

- The repo's prior dependabot bumps (e.g. #3074, Vitest 4.1.11) merged without handoff
  doc updates.  The Codex finding asks this one to be recorded; recording it is harmless
  and consistent with the repo handoff protocol, so no pushback.
- Used `[codex-autofix]` as the ledger tag to match the lane that produced the commit.
- STATUS.md / EFFORT-LOG are docs-only, so no Docker build or deploy is triggered by the
  doc changes; the Vitest bump itself is the deploy-relevant change (dev-dep only).

## Verification State

```bash
npx tsc --noEmit   # clean (docs-only change)
npm test           # vitest suite — must pass on the PR's verify / verify-hosted gate
npm run build      # Next.js build — must pass on the PR's verify / verify-hosted gate
```

Local trio result at the time of this commit: PASS for the doc-only delta; the PR's CI
gate re-runs the full suite against the merged PR head.

## Next Steps & Blockers

- Wait for `verify` / `verify-hosted` on PR #3179 to go green; the repo auto-merges via
  `gh pr merge --squash --auto`.
- Resolve the Codex P1 thread once this commit lands on the PR branch (the doc-only fix
  makes the thread OUTDATED at squash time; the autofix lane resolves it explicitly).

## Zero-Code Findings

None — this lane made no product-code changes.
