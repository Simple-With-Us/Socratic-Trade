# PR #4998 — Kody Review Follow-ups (MiniMax M3.1 Flash)

**Date:** 2026-11-07  
**Seat:** CURSOR  
**Refs:** PR #4998, ST-4574

## Context & Objective

Complete technically valid Kody/Sentry review threads on PR #4998 without rebasing Claude's branch.  Merge `origin/main` (ST-4589 retired catalog) into a stacked follow-up branch and apply minimal fixes plus regression tests.

## Changes Made

- Merged `origin/main` into `cursor/pr-4998-review-fixes-21a3` (conflicts in catalog, tests, manager doc — took `main`'s retired-row layout).
- `src/lib/model-rotation-pin.ts`: alias-aware catalog lookup for pin force/weight ids (fixes `minimax-m3` `malformed_pin`).
- `test/model-rotation-pin.test.ts`, `test/openrouter-model-availability.test.ts`, `test/llm-provider.test.ts`: new cases.
- `docs/rollouts/2026-10-21-minimax-m3-1-flash.md`: account ids removed, route/predecessor/OpenRouter accuracy, ST-4589 reconciliation.

## Decisions & Trade-offs

Did not re-alias `minimax-m3` onto the M3.1 row — `main` already fixed the OpenRouter availability false positive via `RETIRED_LLM_MODEL_CATALOG`.  Did not add a separate Code CLI native slug column; fleet evidence supports `MiniMax-M3.1-Flash` on the broker path.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/model-rotation-pin.test.ts test/openrouter-model-availability.test.ts test/llm-provider.test.ts test/llm-model-catalog.test.ts
npm run lint
npm test
npm run build
```

(Paste exit codes in commit message / CI.)

## Next Steps & Blockers

- Land stacked PR on `claude/salvage-minimax-m3-1-flash`, then merge #4998 when `verify` is green.
- Resolve GitHub review threads after push.
