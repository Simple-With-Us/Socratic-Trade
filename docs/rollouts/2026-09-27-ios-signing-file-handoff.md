# iOS signing file handoff — 2026-09-27

## Context and objective

Keep the multiline ASC private key out of Actions step environments while preserving the existing signing import flow.  This source repair is tracked in issue #3861, PR #3863, board `2a08205f`.

## Changes made

- `.github/workflows/ios-ship.yml`: reads the key separately and passes it through stdin to the staging helper; exports only `ASC_KEY_PATH` for subsequent steps.
- `scripts/ios-stage-asc-key.sh`: creates a unique mode-700 temporary directory and mode-600 key file, rejecting empty input before publishing the path.
- `scripts/ios-appstore-gm-prepare.sh`: accepts the staged file while retaining the local legacy input, disables tracing and sets a restrictive umask.
- `scripts/test-ios-stage-asc-key.sh` and `.github/workflows/ci.yml`: run synthetic multiline fixtures through the actual workflow block with a fake Infisical CLI.
- `STATUS.md`, `docs/EFFORT-LOG.md` and this rollout: record the current hold and next steps.

## Decisions and trade-offs

No new dependency is required.  A unique staging path avoids following a pre-existing compatibility symlink.  The hosted runner owns temporary-file cleanup.  Local legacy callers remain supported, but CI no longer propagates raw PEM through GITHUB_ENV.

## Verification state

```sh
bash scripts/test-ios-stage-asc-key.sh
bash -n scripts/ios-stage-asc-key.sh scripts/test-ios-stage-asc-key.sh scripts/ios-appstore-gm-prepare.sh
git diff --check
```

All listed local checks passed.  Synthetic tests verify permissions, absent PEM in stdout/stderr/GITHUB_ENV, empty-input rejection and independent repeated handoffs.  Hosted CI validates the app; no local full build was started under shared-Mac load.

## Next steps and blockers

The `ios-ship` workflow remains manually disabled pending credential recovery.  Finish PR checks and land the source, then complete the separate owner credential decision and signing validation before explicitly re-enabling it.  No native bundle changes, TestFlight dispatch, credential revocation or log deletion occurred in this repair.

## Zero-code findings

This unit includes code changes.  Private credential bindings and recovery decisions are maintained outside public source.
