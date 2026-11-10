# 2026-10-18 OPS-818: bootstrap Infisical identity from the Keychain, not the flat key file

## Summary

Owner ruling (Jay, 2026-10-18):  nothing may read the retired flat bootstrap key file.  The ruling overrides this repo's "Strict Infisical, no `.env` files (owner, 2026-09-18)" rule, which had kept that file as the owner-side bootstrap identity store.  The bootstrap Infisical machine-identity credentials move to the macOS login Keychain ("keychain is good").  Linear OPS-818.

PR #4870 (merged) already migrated the other readers (`scripts/massive-hoard.ts`, `scripts/cascade-audit.ts`, `scripts/ios-fleet/ship-testflight.sh`, `.claude/skills/deploy-verify/SKILL.md`).  This PR covers the bootstrap resolver and the dev loader, which were the last readers.  The Keychain deviation from the 2026-09-18 rule is owner-directed and is recorded here and in `AGENTS.md` as the ratification.

Resolution order in `scripts/infisical-bootstrap-env.mjs` is now `process.env`, then `.env.local` runner controls, then (macOS only) the login Keychain.  Keychain layout:  generic passwords, service `socratic-trade-bootstrap`, account = env var name.  Lookups use `/usr/bin/security find-generic-password -s socratic-trade-bootstrap -a NAME -w` through a list-argv `spawnSync` (no shell), stdout captured, stderr discarded, and a missing or unreadable item treated as absent.  Only the six alias names the old global layer allowed are ever requested (`INFIISICAL_ST_*`, `INFISICAL_ST_*`, `INFISICAL_CT_SHARED_*`).  Alias, precedence and half-pair logic is unchanged;  the half-pair error names the Keychain service and the `security add-generic-password` command, never a value.  `SOCRATIC_BOOTSTRAP_KEYCHAIN=off` skips the Keychain.

## Files changed

| File | Change |
|---|---|
| `scripts/infisical-bootstrap-env.mjs` | Flat-file layer removed (secure open, shell-ish parser, 1 MiB cap, default file constant);  Keychain layer added as above |
| `src/lib/db-api-keys.ts` | Dev-only loader that pulled the whole file into `process.env` deleted;  dev reads `process.env` only |
| `scripts/predev-check.mjs` | Checks for the Keychain items (presence only, no `-w`) and prints the add command |
| `test/infisical-bootstrap.test.ts` | File-parser tests replaced by injected-Keychain tests (env wins, Keychain fallback, empty Keychain, off-macOS and `off` never query, partial pair names service and account but no value, a flat file under HOME is ignored, the `security` call shape);  `isolatedProcessEnv` sets `SOCRATIC_BOOTSTRAP_KEYCHAIN=off` so no test touches the real Keychain |
| `docs/secrets.md`, `.env.example`, `scripts/cloud-setup.sh`, `test/no-env-loader-or-dotenv-yaml.test.ts` | Comments and docs updated to the Keychain |
| `AGENTS.md` | The binding strict-Infisical rule gains an owner 2026-10-18 update line;  the original 2026-09-18 text is kept |
| `STATUS.md` | OPS-818 entry added beside the #4870 entry |

Decisions and trade-offs:
- `.env.local` stays as the middle layer:  it is not the retired file, the integration tests and runner depend on it, and removing it was not part of the ruling.
- The Keychain was seeded on the owner's Mac by a one-off in-memory script (values never printed).  Items created:  `INFISICAL_ST_CLIENT_ID`, `INFISICAL_ST_CLIENT_SECRET`;  both read back equal.  The old file held no `INFIISICAL_ST_*` or `INFISICAL_CT_SHARED_*` values, so no items exist for those.
- The seeding script passed each value on `security`'s argv for a moment (visible to same-user `ps`).  Accepted on this single-user Mac.  The documented add command omits the value after `-w` so `security` prompts instead.
- The old file itself was not deleted or edited.

## Verification

The lane has no access to the private `@jaywedgeworth22/congress-trading-shared` package, so `tsc` and most of `npm test` cannot run here;  CI `verify-hosted` is the gate for those.

- `npm run lint` -> pass, 0 errors (warnings pre-existing)
- `npx tsc --noEmit` -> not clean locally:  36 errors, all from the missing private package or its fallout, none in a changed file
- `npx vitest run test/infisical-bootstrap.test.ts test/no-env-loader-or-dotenv-yaml.test.ts` -> pass, 45 tests (rerun after merging `origin/main`)
- `npm run build` -> not run locally;  the hosted `verify-hosted` job on this PR is the source of truth for the build
- Live check on the Mac with `INFISICAL_*` unset:  the resolver took the app identity from the Keychain, and `node scripts/infisical-run.mjs -- node -e ...` logged in and exported the app secrets, with zero non-empty bootstrap variables in the child.

## Follow-ups

- The owner may delete the retired flat key file once nothing else on the Mac reads it.
- Add Keychain items for the `INFISICAL_CT_SHARED_*` pair if a runner ever needs it.
