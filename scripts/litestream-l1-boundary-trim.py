#!/usr/bin/env python3
"""Trim Litestream L1 objects already superseded by the newest snapshot (B2, fleet).

Litestream 0.5's level-2 compaction folds the WHOLE remaining L1 chain into one
output object.  When L2 stalls (endpoint flake, a capped download, a killed
multipart), L1 keeps growing, so the next L2 attempt is an even larger upload --
a loop that never converges and re-burns the SHARED Backblaze daily download cap
on every retry.  Deleting L1 objects whose maxTXID is at or below the newest L9
snapshot's maxTXID is safe by construction: a full snapshot already contains
those transactions, so restore is snapshot + the remaining L1/L0 chain.

Run right AFTER the nightly snapshot lands (~00:00Z), so the next level-2
compaction has only minutes of L1 to fold in.

Deletes and listings are Backblaze Class A/C -- free, and NOT subject to the
Class B download cap, so this works even while downloads are capped.

Default is a dry run.  Pass --apply to delete.

  --app {socratic,congress,usage-monitor}   which replica (default socratic)
  --max-snapshot-age-hours N                refuse a staler snapshot (default 48)
  --apply                                   actually delete

Exit codes: 0 ok/no-op, 1 delete failures, 2 no usable snapshot,
3 snapshot failed a safety guard, 4 would leave a restore hole,
5 kept chain has internal gaps (L2 will stay wedged -- needs a human),
6 nothing superseded although L1 is large (boundary did not advance).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

APPS = {
    "socratic": ("jays-socratic-trade-eu", "trading-live/app.db"),
    "congress": ("jays-congress-trade-eu", "congress-trade/db.sqlite"),
    "usage-monitor": ("jays-usage-monitor-eu", "api-usage-monitor/prod.db"),
}
LTX_RE = re.compile(r"^([0-9a-f]{16})-([0-9a-f]{16})\.ltx$")
MIN_SNAPSHOT_BYTES = 100 * 1024 * 1024
# A healthy nightly snapshot never collapses; a large shrink means truncation.
MIN_SNAPSHOT_RATIO = 0.5
# Above this L1 count, "nothing superseded" means the boundary did not advance.
LARGE_L1 = 200
# Objects per batched delete call.
DELETE_CHUNK = 500


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print("[l1-boundary-trim] %s %s" % (stamp, msg), flush=True)


def rclone(args: list[str]) -> str:
    proc = subprocess.run(["rclone", *args], capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        raise RuntimeError("rclone %s failed rc=%d" % (args[0], proc.returncode))
    return proc.stdout


def listing(bucket: str, prefix: str, level: str) -> list[tuple[str, int, str]]:
    """(name, size, modtime) for one level, via lsl (Class C)."""
    out = rclone(["lsl", "b2:%s/%s/%s/" % (bucket, prefix, level)])
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        rows.append((parts[3].strip(), int(parts[0]), "%s %s" % (parts[1], parts[2])))
    return rows


def txids(name: str) -> tuple[int, int] | None:
    match = LTX_RE.match(name)
    return (int(match.group(1), 16), int(match.group(2), 16)) if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", choices=sorted(APPS), default="socratic")
    parser.add_argument("--max-snapshot-age-hours", type=float, default=48.0)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    bucket, prefix = APPS[args.app]
    log("mode=%s app=%s bucket=%s prefix=%s max_snapshot_age=%.1fh"
        % ("APPLY" if args.apply else "DRY-RUN", args.app, bucket, prefix,
           args.max_snapshot_age_hours))

    snaps = [(n, s, t, txids(n)) for (n, s, t) in listing(bucket, prefix, "0009")]
    snaps = [row for row in snaps if row[3] is not None]
    if not snaps:
        log("ABORT: no parseable L9 snapshot")
        return 2
    snaps.sort(key=lambda row: row[3][1])
    name, size, modtime, (_smin, boundary) = snaps[-1]
    log("newest snapshot %s size=%d modtime=%s boundary=%x" % (name, size, modtime, boundary))

    if size < MIN_SNAPSHOT_BYTES:
        log("ABORT: newest snapshot is only %d bytes (< %d)" % (size, MIN_SNAPSHOT_BYTES))
        return 3
    if len(snaps) >= 2:
        prev_size = snaps[-2][1]
        if prev_size > 0 and size < prev_size * MIN_SNAPSHOT_RATIO:
            log("ABORT: newest snapshot %d bytes is < %.0f%% of the previous %d bytes "
                "(possible truncation)" % (size, MIN_SNAPSHOT_RATIO * 100, prev_size))
            return 3
        log("previous snapshot %d bytes - size ratio %.2f ok" % (prev_size, size / prev_size))
    try:
        snap_time = datetime.strptime(modtime.split(".")[0], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc)
    except ValueError:
        log("ABORT: could not parse snapshot modtime %r" % modtime)
        return 3
    age_h = (datetime.now(timezone.utc) - snap_time).total_seconds() / 3600
    if age_h > args.max_snapshot_age_hours:
        log("ABORT: newest snapshot is %.1fh old (> %.1fh) - the nightly snapshot is late "
            "or failing; trimming to a stale boundary would be a near no-op"
            % (age_h, args.max_snapshot_age_hours))
        return 3
    log("snapshot age %.1fh - ok" % age_h)

    l1 = listing(bucket, prefix, "0001")
    doomed, kept = [], []
    for nm, sz, _t in l1:
        rng = txids(nm)
        if rng is None:
            log("WARN: unparseable L1 name skipped: %s" % nm)
            continue
        (doomed if rng[1] <= boundary else kept).append((nm, sz, rng))

    log("L1 total=%d superseded=%d (%.0f MB) keep=%d (%.0f MB)"
        % (len(l1), len(doomed), sum(r[1] for r in doomed) / 1e6,
           len(kept), sum(r[1] for r in kept) / 1e6))

    if kept:
        kept.sort(key=lambda r: r[2])
        first_min = kept[0][2][0]
        if first_min > boundary + 1:
            log("ABORT: deleting would leave a restore hole -- snapshot ends %x but the "
                "kept chain starts %x" % (boundary, first_min))
            return 4
        log("first kept %s (chain reaches the snapshot)" % kept[0][0])
        # Walk the whole retained set: an internal gap keeps L2 wedged even after a trim.
        gaps = []
        for prev, cur in zip(kept, kept[1:]):
            (_pmin, pmax), (cmin, cmax) = prev[2], cur[2]
            if cmax == pmax and cmin != _pmin:
                continue  # twin (same max, different min) -- not a gap
            if cmin != pmax + 1:
                gaps.append("%x->%x" % (pmax, cmin))
        if gaps:
            log("KEPT CHAIN HAS %d INTERNAL GAP(S): %s" % (len(gaps), ", ".join(gaps[:6])))
            log("ABORT: level-2 compaction will stay wedged on non-contiguous input; "
                "a human must reconcile these before trimming helps")
            return 5

    if not doomed:
        if len(l1) > LARGE_L1:
            log("ABORT: nothing superseded although L1 holds %d objects -- the snapshot "
                "boundary did not advance past the backlog" % len(l1))
            return 6
        log("nothing superseded - no-op")
        return 0
    if not args.apply:
        log("DRY RUN - rerun with --apply to delete %d objects" % len(doomed))
        return 0

    # Delete in batches via --files-from.  One --include delete per object re-lists the
    # whole prefix every time (O(n^2)); on Congress.Trade's 2400-object L1 that measured
    # ~12s per delete.  A batched --files-from run lists once per chunk instead.
    target = "b2:%s/%s/0001/" % (bucket, prefix)
    sent = errors = 0
    for start in range(0, len(doomed), DELETE_CHUNK):
        chunk = doomed[start:start + DELETE_CHUNK]
        handle, listfile = tempfile.mkstemp(prefix="l1-trim-", suffix=".txt")
        try:
            with os.fdopen(handle, "w") as fh:
                fh.write("".join(nm + "\n" for nm, _sz, _rng in chunk))
            try:
                # NOT --b2-hard-delete: the host's scoped fleet-backup-writer key may
                # hide versions but gets "Unknown 401 (401 unauthorized)" on
                # b2_delete_file_version, so a hard delete silently deletes nothing
                # (measured 2026-09-01: ~800 no-op "deletes" against Congress.Trade).
                # A hide is enough to unwedge compaction -- litestream stops seeing the
                # object immediately -- and the bucket's own lifecycle rule
                # (daysFromHidingToDeleting=1) frees the bytes about a day later.
                # Hard deletes need the B2 master key; run the trim from an operator
                # workstation if you need the space back the same hour.
                rclone(["delete", target, "--files-from", listfile,
                        "--transfers", "16", "--checkers", "16"])
            except Exception:
                errors += 1
            sent += len(chunk)
            log("progress %d/%d" % (sent, len(doomed)))
        finally:
            try:
                os.unlink(listfile)
            except OSError:
                pass

    # Trust the bucket, not the exit codes: re-list and count what actually survived.
    remaining = {nm for nm, _s, _t in listing(bucket, prefix, "0001")}
    survivors = [nm for nm, _sz, _rng in doomed if nm in remaining]
    deleted = len(doomed) - len(survivors)
    log("APPLIED app=%s deleted=%d survived=%d batch_errors=%d"
        % (args.app, deleted, len(survivors), errors))
    if survivors:
        log("first survivors: %s" % ", ".join(survivors[:5]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
