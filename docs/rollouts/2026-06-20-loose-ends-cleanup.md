# 2026-06-20 — Loose-ends sweep across all agents/worktrees

## Summary
A full audit of unfinished/uncommitted work across every worktree, branch, stash,
and open PR (local + GitHub), followed by cleanup. Net result: the repo's "loose
work" collapsed to a single non-redundant artifact (3 CI workflow files); two
in-progress agent work items were verified redundant and preserved/parked rather
than merged.

Actions taken:
- **Worktree repair.** The four `~/apps/trading-*` worktrees had stale `.git`
  pointers (still referencing the pre-move Documents checkout path) and could
  not run git. Fixed with `git worktree repair` from the main
  checkout; all four resolve again.
- **`main` verified green:** `npx tsc --noEmit` clean, `npm test` 307 passing (40
  files), `npm run build` green.
- **agent/codex WIP preserved, not merged.** The uncommitted tax-treatment +
  hourly-notional-cap WIP (`src/lib/{types,db,defaults,policy,strategy,tax}.ts`)
  was committed onto `agent/codex` as `99942b0`. A verified 3-agent parity/salvage
  audit (reading actual `main` source) found all six features already shipped on
  `main` (R1/R3 by `agent/claude`), equivalent or more complete — DO NOT MERGE.
  See `docs/rollouts/2026-06-20-codex-tax-notional-wip-superseded.md`.
- **agent/antigravity-local: discard as redundant.** A 2-agent parity/salvage
  audit found all 7 themes (broker-UI split, $/% toggles, composite-universe
  schema, ops/observability foundation, dashboard refactor, telemetry redaction)
  already on `main` and strictly more evolved (main even adds
  `src/lib/index-universes.ts`, the branch's own TODO). The branch is 49 commits
  behind and carries junk (`codex_work.patch`, `scripts/refactor/`). Left in place
  as a harmless local-only record (not force-deleted); safe to
  `git branch -D agent/antigravity-local` anytime.
- **CI workflows preserved.** The only thing absent from `main` across all agent
  branches/stashes was 3 GitHub Actions workflows (`ci/e2e/security`). They are
  blocked from `.github/workflows/` because the active token lacks the `workflow`
  scope. Extracted from the `agent/codex` ops stash to `ci-pending/` (tracked,
  pushable) with install instructions.
- **PR + branch cleanup.** Closed duplicate Cursor draft PR #9 (kept #8). #8
  (Cursor Cloud docs) was then integrated and closed by the concurrent
  integration seat working `main` in real time (`main` cherry-pick `55213d2` +
  hygiene commit `92b05e9`), so its `## Cursor Cloud specific instructions`
  section landed in `AGENTS.md` without my involvement. Separately I deleted
  fully-merged local branches (`ui-redesign`, `ui-optimization-pass`,
  `web-sources`, `phase-10`) and merged/closed remote branches
  (`codex/upload-current-state`, `codex/phase-7-…`,
  `cursor/setup-dev-environment-73ae`); dropped the duplicate `temp-check` stash.
- **Dependabot:** 5 open major bumps (#3 next 16, #4 @types/node 26, #5 zod 4,
  #6 lucide-react 1.x, #7 eslint 10) left OPEN intentionally — each needs its own
  tested upgrade, not a blind merge.

## Why
The user asked for a sweep of unfinished/uncommitted work across all agents. The
recurring pattern: each agent's in-progress branch re-implemented features that had
already been integrated to `main` through the multi-agent flow, so the safe move
was to verify-then-preserve/park rather than merge stale duplicates over hardened
code. The CI workflows are the one genuine gap, and it is an auth-scope blocker, not
a code gap.

## Files
- `ci-pending/{ci,e2e,security}.yml` + `ci-pending/README.md` (new — this commit)
- `docs/rollouts/2026-06-20-loose-ends-cleanup.md` (this note)
- (Cursor Cloud `AGENTS.md` section + the #8 close were handled by the concurrent
  integration seat in `55213d2`/`92b05e9`, not part of this commit. STATUS.md was
  left untouched to avoid colliding with that seat's live edits — this rollout note
  carries the handoff detail.)
- (on `agent/codex`) `99942b0` + `docs/rollouts/2026-06-20-codex-tax-notional-wip-superseded.md`

## Verification
- `npx tsc --noEmit` clean · `npm test` 307 passing · `npm run build` green (on `main`).
- Worktree repair confirmed: all four `~/apps/trading-*` resolve via plain `git -C`.
- Parity/salvage audits run as background workflows; verdicts cited above.
- This commit is docs/CI-config only — no source or test behavior changed.

## Follow-ups
- **Install CI**: re-scope token (`gh auth refresh -h github.com -s workflow`),
  then `git mv ci-pending/*.yml .github/workflows/`. Confirm `ci.yml`'s Node 24 pin.
- **Dependabot majors (#3–#7)**: dedicated, individually-tested upgrade pass.
- **agent/antigravity-local**: delete when convenient (verified redundant).
- **Optional micro-hardening** (noted on `agent/codex`): guard the hourly cap with
  `maxHourlyNotional > 0` only if the settings UI can persist a literal `0`.
