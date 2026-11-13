# 2026-10-18 OPS-818: stop reading the flat global-api-keys file

**Summary.**  Per the owner ruling on OPS-818 (nothing may read the flat `global-api-keys` file under `~/.secrets/`), the non-identity readers now take env first, then `fleet-secrets get NAME` (Infisical Fleet-OPS).  `scripts/massive-hoard.ts` fails fast with a clear error when neither source yields a key.

**Files changed.**

| File | Old read | New source |
|---|---|---|
| `scripts/ios-fleet/ship-testflight.sh` (`load_sentry_auth`) | grep of the flat file for `SENTRY_AUTH_TOKEN` | env, else `fleet-secrets get SENTRY_AUTH_TOKEN` when the CLI is installed; failure means absent |
| `scripts/massive-hoard.ts` | regex over the flat `.env` copy for `MASSIVE_API_KEY_ALT` | env `MASSIVE_API_KEY`, else `fleet-secrets get MASSIVE_API_KEY_ALT`; throws if neither resolves |
| `scripts/cascade-audit.ts` | usage comment: `source` the `.env` copy | usage comment: `fleet-secrets run -- npx tsx ...` |
| `.claude/skills/deploy-verify/SKILL.md` | "read from the flat file, key `COOLIFY_API_TOKEN`" | `fleet-secrets get COOLIFY_SERVER_STATS` (read-only stats token; `COOLIFY_API_TOKEN` is not a Fleet-OPS name) |
| `scripts/ios-fleet.sha256` | pin | refreshed with `bash scripts/ios-fleet-pin.sh --update` |

**Deliberately not changed (repo rule).**  The bootstrap-identity readers keep the handoff path because `AGENTS.md` ("Strict Infisical, no `.env` files", binding) records the handoff paths as "the documented owner-side identity store":  `src/lib/db-api-keys.ts`, `scripts/infisical-bootstrap-env.mjs`, `scripts/predev-check.mjs`, `test/infisical-bootstrap.test.ts`, `docs/secrets.md`, `.env.example`, the `scripts/cloud-setup.sh` comments, and the `AGENTS.md` grep-trap rules.  Flagged for the owner on OPS-818.

**Verification.**
- `bash scripts/ios-fleet-pin.sh --check` -> pass
- `bash scripts/ios-fleet/test-ship-seq.sh` -> 50 pass, 0 fail
- `bash -n scripts/ios-fleet/ship-testflight.sh` -> pass
- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` -> not run locally (the lane has no `node_modules`);  the hosted `verify-hosted` job runs them on this PR.

The runtime copy of the ship script under `~/apps/ios-fleet/` will show advisory drift in `check-drift.sh` until it is reinstalled from this file.

**Follow-ups.**
- Reinstall the runtime copy so `check-drift.sh` stops reporting advisory drift.
- Owner decision on OPS-818: whether the bootstrap-identity readers listed above should also move off the flat file.
