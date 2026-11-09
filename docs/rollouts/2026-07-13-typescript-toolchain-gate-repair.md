# TypeScript toolchain and production-build gate repair

## Summary

An independent audit of deployed PR #1531 found two different TypeScript compilers behind nominally
green gates. The standalone `tsc` binary ran TypeScript 7.0.2, while a postinstall rewrite plus
process-wide module-resolution hooks redirected compiler-API consumers to TypeScript 5.5.4. The Next
configuration also set `ignoreBuildErrors: true`, and the hosted production build logged `Skipping
validation of types`.

This lane restores a single TypeScript 6.0.3 dependency graph, removes every compiler alias and
mutation, restores Next's default production-build type check, and blocks automated TypeScript minor
or major updates outside 6.0.x until Next and typescript-eslint explicitly expand support. The
runtime/type contract is aligned on Node 24: hosted CI stays on setup-node 24, self-hosted CI selects
and hard-checks the Homebrew Node 24 runtime before install, `scripts/land.sh` rejects any other
major before mutating git state, and `@types/node` stays on major 24. Production health for the
already-deployed TypeScript 7 release is not disputed; this repair addresses the overstated
type-gate claim.

## Why

The installed typescript-eslint 8.63.0 packages declare TypeScript support through `<6.1.0`.
TypeScript is therefore constrained to `~6.0.3`, not a caret range that could silently admit 6.1.
TypeScript 6.0.3 is the newest already-proven line in that support window. One compiler is
also necessary for the CLI, Next plugin, ESLint parser, editor, and test tooling to agree on program
semantics. A separate green `tsc` step does not make a build-time bypass truthful when the two steps
execute different compiler majors.

The first hostile review found that the implementation itself worked under an explicit Node 24
PATH, but the dormant self-hosted CI route inherited the service's Node 26 PATH and could satisfy
the required check without a hosted rerun. It also found Node 26 declarations, string-only policy
tests, and a stale ESLint 10 comment. The remediation makes the self route fail closed on any
non-24 runtime, aligns declarations, parses the lockfile and Dependabot YAML structurally, scans
active scripts/configuration for compiler mutations, and corrects the comment to ESLint 9.

## Files

- `.github/dependabot.yml`
- `.github/workflows/ci.yml`
- `eslint-preload.cjs` (removed)
- `eslint.config.mjs`
- `next.config.mjs`
- `package.json`
- `package-lock.json`
- `scripts/land.sh`
- `test/toolchain-policy.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-13-typescript-toolchain-gate-repair.md`
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board)

## Verification

All commands used Node 24 through an explicit PATH.

### Prior full-gate and build proof

- Initial `npm ci --no-audit --no-fund` — pass; no TypeScript peer-dependency warnings.
- `node_modules/.bin/tsc --version` — `Version 6.0.3`.
- `node -p "require('typescript').version"` — `6.0.3`.
- `npm ls typescript --all` — pass; every consumer dedupes to TypeScript 6.0.3.
- `npm run lint` — pass, 0 errors / 458 inherited warnings.
- `npx tsc --noEmit` — pass.
- `npm test` — pass, 363 files / 4,041 tests. Runtime was 723.91 seconds under parallel agent load;
  process/worker CPU activity was checked while quiet output was buffered, so this was slow rather than hung.
- Initial `npm run build` — pass. An independent hostile-review build repeated the production build
  before remediation and also logged `Running TypeScript` then `Finished TypeScript`, rather than
  `Skipping validation of types`.

### Hostile-review remediation checks

- `npm ci --no-audit --no-fund` — pass, 768 packages; the lockfile hash stayed unchanged. Output
  contained inherited deprecation and allow-scripts notices, but no TypeScript peer warning.
- Runtime graph — Node `v24.18.0` / ABI 137, TypeScript `6.0.3`, and `@types/node` `24.13.3`;
  `npm ls typescript @types/node js-yaml --all` dedupes every compiler and Node-types consumer.
- Fresh lock regeneration in an isolated temp directory — byte-identical to the checked-in lock.
  The package-map delta against `HEAD` is limited to the root manifest, TypeScript 7 platform
  packages/removal of the TypeScript 5 alias/root TypeScript 6 replacement, Node types 26 to 24,
  and the corresponding `undici-types` 8 to 7 change. `js-yaml@4.2.0` was already locked and is now
  declared directly for the structural policy test; its installed version did not move.
- `npx vitest run test/toolchain-policy.test.ts` — 5/5 pass. The suite parses the lockfile and
  Dependabot YAML, asserts one installed compiler entry/version, verifies both CI lanes and landing
  guards, and scans active source/config/script surfaces for aliases, preloads, resolution hooks,
  compiler-file mutation, and the Next bypass.
- `npx eslint test/toolchain-policy.test.ts next.config.mjs` — pass with no output.
- `npx tsc --noEmit` — pass after the clean install with Node 24 declarations.
- `/bin/bash -n scripts/land.sh` — pass under macOS Bash 3.2.57; the added guard is ASCII-only.
- Runtime guard probes — Node 26.5.0 is rejected before worktree/git checks; Node 24.18.0 passes the
  runtime guard and then stops at the expected dirty-worktree guard.
- `.github/workflows/ci.yml` and `.github/dependabot.yml` parse as YAML objects through `js-yaml`.
  `actionlint` is unavailable on this host.
- `git diff --check` — pass after code and documentation updates.

The build still reports the pre-existing console Tailwind wildcard warning, the Sentry Edge-runtime
warning, and the middleware-to-proxy deprecation. The Tailwind warning is already owned and fixed in
the separate `codex/console-usage-tokens` lane; none is caused by this toolchain repair.

### Fresh re-review acceptance

Fresh independent re-review inspected the remediated diff and reran the structural policy suite.
It accepted the shared TypeScript/Node graph, both CI runtime guards, the Bash 3/ASCII-safe landing
guard, structured Dependabot association, lockfile cardinality enforcement, and removal of every
active alias/preload/mutation/type-bypass surface. `npm ls` again showed one TypeScript 6.0.3 and
one `@types/node` 24.13.3 graph; the 5 policy tests passed. No blocker remains before the final
ordered gate.

### Final ordered gate

With Node 24 first on `PATH`, the accepted snapshot passed:

- `npm run lint` — exit 0; 0 errors / 458 inherited warnings.
- `npx tsc --noEmit` — exit 0.
- `npm test` — 363 files / 4,043 tests passed in 531.27 seconds.
- `npm run build` — exit 0; Next explicitly logged `Running TypeScript` and `Finished TypeScript`
  before completing the production bundle.
- `git diff --check` — exit 0.

The inherited console Tailwind, Sentry Edge, and middleware deprecation warnings remain separately
owned; none failed the build or came from this lane.

## Follow-ups

- Reconcile new `origin/main` changes, commit, and open a ready PR.
- After merge/autodeploy, verify the exact release and confirm the production CI/build log retains
  the TypeScript phase.
