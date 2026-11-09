# 2026-06-27 - configure-eslint

## Summary

- Configured ESLint for the repo and wired `npm run lint` into the required
  `verify` CI gate. Previously `next lint` was unconfigured (interactive setup
  prompt) and excluded from verification.
- Added `eslint.config.mjs` (flat config) extending `eslint-config-next`'s
  `core-web-vitals` + `typescript` presets — the same rule set the legacy
  `next lint` default enabled.
- Changed the `lint` npm script from `next lint` to `eslint .` (Next 16
  deprecated `next lint` in favor of the ESLint CLI).
- Pinned `eslint` to `^9` (was `^10.5.0`).
- Added `- run: npm run lint` to the `verify` job in `.github/workflows/ci.yml`.

## Why

- The repo is edited by several AI tools; a linter mechanically enforces
  consistency and catches React/Next-specific issues (`react-hooks/*`,
  `@next/next/*`, `jsx-a11y/*`) that `tsc` does not.
- **ESLint 9, not 10:** `eslint-config-next@16.2.9` bundles
  `eslint-plugin-react@7.37.5`, which calls `context.getFilename()` — an API
  removed in ESLint 10. Under ESLint 10, lint aborts with
  `TypeError: ... getFilename is not a function`. The repo's prior `eslint@^10`
  pin was never exercised because lint was never configured. ESLint 9 is the
  compatible version for `eslint-config-next@16`.
- **Green-but-meaningful baseline:** a first lint run reported 118 errors / 100
  warnings. Rather than mass-editing app code, the heavy/opinionated backlog
  rules are pinned to "warn" in `eslint.config.mjs`:
  - `@typescript-eslint/no-explicit-any` (94, mostly tests)
  - `react-hooks/set-state-in-effect` (20)
  - `react/no-unescaped-entities` (2), `react/display-name` (1),
    `@next/next/no-html-link-for-pages` (1)
  ESLint exits non-zero only on errors, so this makes the gate green (0 errors)
  while every other error-level rule from the presets (rules-of-hooks, critical
  `@next/next` rules, import errors, syntax errors) still blocks NEW regressions.

## Files

- `eslint.config.mjs` (new)
- `package.json` (`lint` script → `eslint .`; `eslint` devDep → `^9`)
- `package-lock.json` (eslint 9 resolution)
- `.github/workflows/ci.yml` (add `npm run lint` to `verify`)
- `AGENTS.md` (verification section + Cursor Cloud section)
- `STATUS.md`
- `docs/rollouts/2026-06-27-configure-eslint.md`

## Verification

Full CI sequence run locally and all green:

- `npm ci` — clean, lockfile in sync.
- `npm run lint` — 0 errors, 218 warnings (exit 0).
- `npx tsc --noEmit` — clean.
- `npm test` — 150 files, 1444 tests passing.
- `npm run build` — clean.

## Follow-ups

- Burn down the warning backlog and promote the pinned rules back to "error":
  start with the small-count ones (`react/no-unescaped-entities`,
  `react/display-name`, `@next/next/no-html-link-for-pages`), then chip away at
  `@typescript-eslint/no-explicit-any` (mostly test fixtures) and
  `react-hooks/set-state-in-effect`.
- Optional: add `typescript-eslint` type-aware rules and/or Prettier
  (`eslint-config-prettier`) later if deeper checks/formatting are desired.
- Revisit the `eslint@^10` upgrade once `eslint-config-next` / its bundled
  `eslint-plugin-react` support ESLint 10.

## Blockers

- None.
