# 2026-07-09 - Home evidence symbol drawer parity

## Summary

Closed the remaining console-side universal ticker drawer gap found by the
read-only audit of `origin/main`: Home evidence cards now render candidate
symbols as `SymbolButton`s and pass through the current `MarketQuote` to the
existing shared drawer. PR #1181 merged to `main` as `70c0698e`; production
deploy is still pending after that merge.

## Why

The effort board's universal ticker drawer row still named evidence cards as an
uncovered surface. The rest of the listed console surfaces already used the
shared `SymbolButton` path, so the safe Codex slice was one file:
`app/console/page.tsx`.

## Files

- `app/console/page.tsx`
- `docs/reviews/2026-07-03-console-parity-open-items.md`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-09-home-evidence-symbol-drawer.md`

## Verification

```bash
npm run lint
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run build
git -c core.fsmonitor=false diff --check
```

Results:

- Initial `npm run lint` failed before code verification because the fresh
  worktree did not yet have `node_modules` (`eslint: command not found`).
- `npm ci` installed worktree dependencies.
- `npm run lint`: passed with the existing warning backlog and 0 errors.
- `npx tsc --noEmit`: passed.
- `npm test`: passed, 303 files / 3118 tests.
- `npm run build`: passed with the existing Sentry Edge-runtime warning.
- `git -c core.fsmonitor=false diff --check`: passed. Plain `git diff --check`
  first hit a local fsmonitor daemon already-running error, so the check was
  rerun with fsmonitor disabled.

## Follow-ups

- Do not touch `app/console/settings/models.tsx` or model-picker/catalog files
  from this lane; MONET owns the model-provider/single-adversary work.
- Legacy dashboard/admin ticker affordance checks are separate from the console
  parity row closed here.
