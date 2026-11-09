# 2026-06-16 - documentation-handoff-standard

## Summary

- Added a repo-wide handoff documentation standard for cross-platform LLM work.
- Added a `STATUS.md` snapshot file for current-state handoff.
- Added `docs/HANDOFF.md` and a rollout note template under `docs/rollouts/`.
- Updated `AGENTS.md` to require status and rollout-note hygiene.

## Why

- The repo already had strong durable instructions and design docs, but it did
  not yet have a small, explicit structure for current status plus
  chronological implementation notes.
- This closes the gap between durable rules, design intent, and day-to-day
  implementation handoff across Codex, Claude, Cursor, Gemini, or a human.

## Files

- `AGENTS.md`
- `STATUS.md`
- `docs/HANDOFF.md`
- `docs/rollouts/_template.md`
- `docs/rollouts/2026-06-16-documentation-handoff-standard.md`

## Verification

- First `npx tsc --noEmit` failed with missing `.next/types/...` files
  referenced by `tsconfig.json`:
  - `.next/types/app/api/dashboard/route.ts`
  - `.next/types/app/layout.ts`
  - `.next/types/app/page.ts`
  - `.next/types/cache-life.d.ts`
  - `.next/types/routes.d.ts`
- `npm test` passed: 78 tests across 10 files.
- `npm run build` passed and regenerated `.next/`.
- Second `npx tsc --noEmit` passed after the build regenerated `.next`.

## Follow-ups

- Start using `docs/rollouts/` for future non-trivial implementation work.
- Update `STATUS.md` whenever the active focus or highest-risk issues change.
- If this repo expects `npx tsc --noEmit` to be runnable before a build, decide
  whether `tsconfig.json` should keep depending on generated `.next/types`
  entries in clean or partially cleaned worktrees.
