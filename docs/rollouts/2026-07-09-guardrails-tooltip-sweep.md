# 2026-07-09 - Guardrails tooltip sweep

## Summary

Added native `title` affordances to the remaining bare Guardrails controls in
the Universe and Autonomy sections. PR #1184 merged to `main` as `8b468260`.
It is not production-deployed yet; MONET confirmed it rides the next natural release.

## Why

The settings affordance row is mostly complete on current `main`, but the audit
still found bare controls in Guardrails. This is the smallest safe Codex-owned
slice and avoids MONET-owned model-picker/provider files.

## Files

- `app/console/guardrails/page.tsx`
- `docs/reviews/2026-07-03-console-parity-open-items.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-09-guardrails-tooltip-sweep.md`

## Verification

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
git diff --check
```

Results:

- `npm ci`: installed fresh worktree dependencies; existing npm audit/install-script warnings only.
- `npm run lint`: passed with the existing warning backlog and 0 errors.
- `npx tsc --noEmit`: passed.
- `npm test`: passed, 303 files / 3118 tests.
- `npm run build`: passed with the existing Sentry Edge-runtime warning.
- `git diff --check`: passed.

## Follow-ups

- Do not touch model-picker/provider controls from this lane; MONET owns the
  single-adversary/model-provider work.
- A true universal tooltip proof across every console metric/table/control is
  still a broader audit task.
