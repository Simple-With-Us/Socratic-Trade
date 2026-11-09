# OPS-1052 — ensure-tf-ready rc 5/6 labels (ST)

## Context & Objective

Fleet issue OPS-1052: vendored `ship-testflight.sh` mislabeled `ensure-tf-ready` exit codes 5 and 6 as the generic export-compliance warning. ST needed the BotFleet message/annotation branches without re-vendoring the whole ios-fleet tree.

## Changes Made

- `ensure_tf_ready()` in `scripts/ios-fleet/ship-testflight.sh` now handles rc=5 (no reachable external tester) and rc=6 (installability unreadable) before the existing rc=3/4/2 paths.
- Added `scripts/ios-fleet/ship-tf-ready-labels.test.mjs` (static + mocked-runtime contract).
- Wired the test into `.github/workflows/ci.yml` verify ship-gate step.
- Refreshed `scripts/ios-fleet.sha256` for `ship-testflight.sh`.

**Ordering (OPS-1052 item 2):** `ios-ship.yml` does not yet define "Sync standing TestFlight testers"; no post-sync `ensure-tf-ready` or step-summary change in this PR. The new test asserts that contract only when that step exists.

## Decisions & Trade-offs

- Did not change `asc-api.mjs` (no rc=5/6 emission on ST pin yet); shell labeling is forward-compatible.
- Did not add standing-tester sync (owner limits: no ASC writes / invites).

## Verification State

```bash
node --test scripts/ios-fleet/ship-tf-ready-labels.test.mjs
bash scripts/ios-fleet-pin.sh --check
bash -n scripts/ios-fleet/ship-testflight.sh
```

actionlint: not available on the cloud seat (skipped).

## Next Steps & Blockers

- When ST gains the standing-tester sync workflow step, add a post-sync `ensure-tf-ready` pass and write the second verdict to `$GITHUB_STEP_SUMMARY`.
- Vendoring asc-api external-installability (rc 5/6) is a separate pin refresh.

## Zero-Code Findings

N/A.
