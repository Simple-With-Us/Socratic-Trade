# 2026-08-02 — npm EALLOWSCRIPTS: real root cause, and the allowScripts key fixed for npm 12 (MONET)

Branch `monet/deploy-webhook-docs` (second commit). One-line code change (`package.json`)
plus corrections to earlier wrong analysis.

## 1. Context & Objective

On 2026-08-01 `npm install`/`npm ci` failed in agent worktrees with
`git dep preparation failed ... EALLOWSCRIPTS: --allow-scripts is not allowed in
project-scoped installs`, leaving `node_modules` EMPTY. PR #2345 restored the
`allowScripts` entry and regenerated the lockfile, and installs went green. A dedicated
reproduction agent then established what was *actually* wrong — which contradicts the
explanation previously recorded in STATUS.md (including by this seat). This note is the
correction, with receipts, plus the one forward-looking fix the findings demanded.

## 2. Findings (all reproduced in isolated scratchpad cases; no worktree touched)

1. **The stale/missing `allowScripts` key was NOT the trigger.** A minimal project with
   NO `allowScripts` field at all installs the git dep fine under npm 11.16.0. A
   clean-shell `npm ci` with the repo's exact pre-#2345 files also PASSES.
2. **The real triggers** (upstream [npm/cli#9783](https://github.com/npm/cli/issues/9783),
   open, no fix through npm 12.0.2): an `allow-scripts=...` line in ANY `.npmrc` layer, or
   an inherited **`npm_config_allow_scripts` env var** — npm env-forwards it into its own
   git-dep preparation subprocess, which rejects it as a CLI flag. Both reproduce the
   failure byte-for-byte. This Mac had live `npx`-launched processes exporting
   `npm_config_allow_scripts=@wasp.sh/wasp-cli`; any shell descending from that lineage
   fails every install instantly. `npx npm@10` "worked" because npm 10 ignores the unknown
   config.
3. **Tag-form git keys never match.** npm's matcher compares an `allowScripts` git key's
   committish against the lockfile's resolved **40-char SHA** (`startsWith`), so
   `github:...#v2.4.1` can never cover the dep — it is dead weight. Today that is only a
   "not yet covered" warning; **npm 12 escalates uncovered install/prepare scripts to a
   hard block** ([announcement](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/)),
   which would silently block `congress-trading-shared`'s `prepare` (tsup build of
   `dist/`) and ship an empty, unusable package.
4. **The dep genuinely needs its script**: `prepare: npm run build` produces `dist/`
   (`main: ./dist/index.js`). The allow-list entry is load-bearing, not ceremony.
5. **#2345's lockfile regen fixed a second, silent bug**: the old lockfile pinned the
   v2.3.0 commit while `package.json` said v2.4.x — `npm ci` reported success while
   shipping the OLD shared package to CI and prod.

## 3. Changes Made

- `package.json`: `allowScripts` key for the shared dep changed from
  `"github:jaywedgeworth22/congress-trading-shared#v2.4.1"` to committish-free
  `"github:jaywedgeworth22/congress-trading-shared"` — the only form that actually
  matches a git dep, and survives future tag bumps without maintenance.
- `STATUS.md`: the earlier "stale tag reproduces the failure" explanation replaced with
  the real root cause and the operational check
  (`env | grep npm_config_allow_scripts`; never add `allow-scripts` to `.npmrc` even
  though npm's error message suggests it). Also retracted the non-existent
  `schedulerLease.owner` follow-up (the landed code already strips the pid for
  unauthenticated callers; the earlier observation was against the pre-deploy payload).

## 4. Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # node 24.18.1 / npm 11.16.0
npm ci --no-audit --no-fund      # exit 0, 575 top-level dirs (pre-change, clean shell)
npm install --no-audit --no-fund # exit 0 AFTER the key change; zero coverage warnings
                                 # mentioning congress-trading-shared (was 1 before)
```

Full case-by-case repro logs live in the session scratchpad (`npmrepro/case*`), including
the byte-identical failure reproductions via `.npmrc` and via the env var.

## 5. Next Steps & Blockers

- **Forward item (pre-npm-12):** the remaining "not yet covered" warnings are transitive
  `esbuild@0.18.x/0.25.x` copies (the allow list covers only `esbuild@0.23.1`). Under npm
  12's hard block those install scripts would be refused. Before any npm 12 adoption,
  either key esbuild by name or enumerate the actual resolved versions.
- **Ops note:** if EALLOWSCRIPTS returns fleet-wide, hunt the environment first — a
  contaminated `npx --allow-scripts=...` process lineage poisons every descendant shell.

## 6. Zero-Code Findings

The reproduction agent's structured report (10 isolated cases) is the evidence base;
upstream refs: npm/cli#9783 (env-forwarding bug, open), npm/cli#9488 (covered deps still
warn — explains residual warning noise), npm 11.16.0 release notes (allowScripts Phase 1).
