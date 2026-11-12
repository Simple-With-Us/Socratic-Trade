# ST-4621: Litestream L1 trim/heal safety tests

## Context & Objective

The L1 suffix-heal and boundary-trim scripts delete Backblaze B2 backup objects and had no offline tests.  A bad plan can drop the newest L1 files or a level needed for point-in-time restore.  This change makes planning importable, pins the delete set with a fake B2 API, and closes the unsafe cases those tests show.  Nothing here calls production B2, R2, Sentry, or the Hetzner host.

## Changes Made

Planning functions load without authorizing or listing.  Suffix-heal keeps only the contiguous L1 suffix from the tip, including when the live count is under `--keep-l1`, and it lists only the levels it deletes from (L1, L2, L3) with `b2_list_file_versions`, so a hide marker cannot unhide an older upload.  The never-deleted L0 and L9 levels are listed with `b2_list_file_names` (current names only) and are only counted.  Both calls need the B2 key's `listFiles` capability.  A delete error stops the run.  An unfinished B2 large-file start is not a live object, so it cannot bridge a TXID gap or fill a keep slot.  Name guards refuse L0, L9, traversal, and prefix lookalikes.  Boundary-trim returns exit 3 on a zero-byte previous snapshot and collapses same-max twins before the gap test.  Boundary-trim counts every delete batch it hands to rclone.  If the post-delete listing fails, it logs `APPLIED-UNVERIFIED app=... attempted=N issued_ok=M batch_errors=E survived=unverified` and still exits 1, so an applied-but-unverified run cannot read as a no-op.  Only the `issued_ok` names came from clean batches; the rest may or may not have been hidden.  The fleet shell dry-runs unless `LITESTREAM_L1_TRIM_APPLY=1`.  The systemd unit sets that variable so the nightly timer still applies after Jay installs it.

- `scripts/litestream-l1-suffix-heal.py`
- `scripts/litestream-l1-boundary-trim.py`
- `scripts/ops/litestream-l1-boundary-trim-fleet.sh`
- `scripts/ops/litestream-l1-boundary-trim.service`
- `scripts/ops/litestream-l1-boundary-trim-fleet.selftest.sh`
- `scripts/tests/test_litestream_l1_safety.py`
- `scripts/test-litestream-l1-safety.sh`
- `docs/litestream.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

CLI flags and defaults are unchanged.  Heal still rejects `--keep-l1` below 8, and it now does that before credentials or the network.  The pure planner still defines keep 0, keep 1, and keep above the file count so tests can pin those edges.  Boundary-trim still hides with rclone and does not pass `--b2-hard-delete`.  Defect 0 (size heuristic) and defect 1 (no lock) stay open on purpose.  There is no new CI workflow.  ST-4624 wires ops checks into CI.  The repo copy is no longer byte-identical to the installed `<install-path>/litestream-l1-boundary-trim`.  `<install-path>` is the directory on the dedicated fleet host that `scripts/ops/install-litestream-l1-trim.sh` installs into (the installer is written for that one host) (its `DST_PY` and `DST_FLEET` settings).  `<install-path>/litestream-l1-boundary-trim` is the installed copy of `scripts/litestream-l1-boundary-trim.py`, and `<install-path>/litestream-l1-boundary-trim-fleet` is the installed `scripts/ops/litestream-l1-boundary-trim-fleet.sh`.  To find it on the host, run `command -v litestream-l1-boundary-trim`, or `systemctl cat litestream-l1-boundary-trim.service` and read `ExecStart` (the fleet wrapper, in the same directory).  The wrapper's default for `LITESTREAM_L1_TRIM_BIN` names the same file, and the fleet selftest reads the installer's `DST_PY` and the wrapper's default and fails if they differ (`installer_dst_matches_wrapper_default`, with a drifted-copy control).  It also fails if the installer's `DST_FLEET` differs from the service unit's `ExecStart` (`installer_fleet_matches_unit_execstart`, with drifted-installer and drifted-unit controls).  `docs/litestream.md` uses the same definition.  Do not resync the repo from the host.

## Verification State

```bash
bash scripts/test-litestream-l1-safety.sh
python3 -m py_compile scripts/litestream-l1-suffix-heal.py scripts/litestream-l1-boundary-trim.py
bash -n scripts/ops/litestream-l1-boundary-trim-fleet.sh
bash -n scripts/ops/litestream-l1-boundary-trim-fleet.selftest.sh
```

The safety command is the one documented command.  It runs the unittest discovery and the fleet-shell selftest.  Both passed on this branch: 24 unittest cases and 18 selftest checks.  `npm run lint` exited 0 (warnings only, none from this diff).  `npx tsc --noEmit` exited 0.  `npm test` passed 10245 tests, with 42 skipped.  `npm run build` exited 0.  Node on this cloud VM is 22.  `.nvmrc` is 26.  CI `verify` runs Node 26.

## Next Steps & Blockers

Open a ready PR against `main`.  Do not merge and do not enable auto-merge.  Do not SSH and do not install the unit.  Jay installs the repo copies on the dedicated fleet host when the host behavior should change.  Until that install, production keeps the previous scripts.

## Zero-Code Findings

No Sentry issue id is attached to this work.  The unsafe cases were in the repo scripts, confirmed by running the old planner shape against a three-file gap before the rewrite.
