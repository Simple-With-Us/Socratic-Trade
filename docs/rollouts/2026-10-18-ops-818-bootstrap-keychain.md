# 2026-10-18 OPS-818: bootstrap Infisical identity from the Keychain, not the flat key file

## Context & Objective

Owner ruling (Jay, 2026-10-18): nothing may read `~/.secrets/global-api-keys`.  It explicitly overrides this repo's "Strict Infisical, no `.env` files (owner, 2026-09-18)" rule, which had kept that file as the owner-side bootstrap identity store.  The bootstrap Infisical machine-identity credentials move to the macOS login Keychain ("keychain is good").  Linear OPS-818.  PR #4870 (open at the time of writing) migrates the other readers (`massive-hoard.ts`, `cascade-audit.ts`, `ship-testflight.sh`, the deploy-verify skill).  Until it merges, those four still reference the flat file on `main`;  this PR deliberately does not touch them.  This note covers the bootstrap resolver and the dev loader.  The Keychain deviation from the 2026-09-18 rule is owner-directed ("keychain is good", Jay, 2026-10-18) and is recorded here and in AGENTS.md as the ratification.

## Changes Made

- `scripts/infisical-bootstrap-env.mjs`: the flat-file layer is gone (secure open, shell-ish parser, 1 MiB cap, `DEFAULT_GLOBAL_API_KEYS_FILE`).  Resolution order is `process.env`, then `.env.local` runner controls, then (macOS only) the login Keychain.  Keychain layout: generic passwords, service `socratic-trade-bootstrap`, account = env var name.  Lookups are `/usr/bin/security find-generic-password -s socratic-trade-bootstrap -a NAME -w` through a list-argv `spawnSync` (no shell), stdout captured, stderr discarded, a missing or unreadable item treated as absent.  Only the six alias names the old global layer allowed are ever requested (`INFIISICAL_ST_*`, `INFISICAL_ST_*`, `INFISICAL_CT_SHARED_*`).  Alias, precedence and half-pair logic is unchanged;  the half-pair error now names the Keychain service and the `security add-generic-password` command, never a value.  `SOCRATIC_BOOTSTRAP_KEYCHAIN=off` skips the Keychain.
- `src/lib/db-api-keys.ts`: the dev-only loader that pulled the whole file into `process.env` is deleted.  Dev reads `process.env` only.
- `scripts/predev-check.mjs`: checks for the Keychain items (presence only, no `-w`) and prints the add command.
- `test/infisical-bootstrap.test.ts`: file-parser tests replaced by injected-Keychain tests (env wins, Keychain fallback, empty Keychain, off-macOS and `off` never query, partial pair names service and account and no value, a flat file under HOME is ignored, the `security` call shape).  `isolatedProcessEnv` now sets `SOCRATIC_BOOTSTRAP_KEYCHAIN=off` so no test touches the real Keychain.
- Docs and rule: `docs/secrets.md`, `.env.example`, `scripts/cloud-setup.sh` comments, `test/no-env-loader-or-dotenv-yaml.test.ts` comment, and AGENTS.md (the binding strict-Infisical rule gains an owner 2026-10-18 update line, the original 2026-09-18 text is kept;  the "owner supplies keys via the handoff" line no longer implies scripts read it).
- Keychain seeded on the owner's Mac from the flat file by a one-off in-memory script (values never printed).  Items created: `INFISICAL_ST_CLIENT_ID`, `INFISICAL_ST_CLIENT_SECRET`;  both read back equal.  The file held no `INFIISICAL_ST_*` or `INFISICAL_CT_SHARED_*` values, so no items exist for those.

## Decisions & Trade-offs

- `.env.local` stays as the middle layer: it is not the retired file, the integration tests and runner depend on it, and removing it was not part of the ruling.
- The seeding script passed each value on `security`'s argv for a moment (visible to same-user `ps`).  Accepted on this single-user Mac.  The documented add command omits the value after `-w` so `security` prompts instead.
- The flat file itself was not deleted or edited.

## Verification State

Local lane (no access to the private `@jaywedgeworth22/congress-trading-shared` package, so `tsc` and most of `npm test` cannot run here;  CI `verify-hosted` is the gate for those):

```
npm run lint                  # pass, 0 errors (warnings pre-existing)
npx tsc --noEmit              # not clean locally: 36 errors, all from the missing private package or its fallout, none in a changed file
npx vitest run test/infisical-bootstrap.test.ts test/no-env-loader-or-dotenv-yaml.test.ts   # pass, 45 tests
npm run build                 # not run locally, left to CI
```

Live check on the Mac with `INFISICAL_*` unset: the resolver took the app identity from the Keychain, and `node scripts/infisical-run.mjs -- node -e ...` logged in and exported the app secrets, with zero non-empty bootstrap variables in the child.

## Next Steps & Blockers

- Land PR #4870 so the four remaining flat-file references (`scripts/massive-hoard.ts`, `scripts/cascade-audit.ts`, `scripts/ios-fleet/ship-testflight.sh`, `.claude/skills/deploy-verify/SKILL.md`) go away.
- The owner may delete the flat file once nothing else reads it.
