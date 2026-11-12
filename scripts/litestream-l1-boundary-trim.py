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

Default is a dry run.  Pass --apply to delete.  A delete batch error stops
the run; later chunks are not sent.

  --app {socratic,congress,usage-monitor}   which replica (default socratic)
  --max-snapshot-age-hours N                refuse a staler snapshot (default 48)
  --apply                                   actually delete

Exit codes: 0 ok/no-op, 1 delete failures or a failed listing (rclone error,
timeout, missing binary, malformed lsl line; a failed post-delete listing
also logs an APPLIED-UNVERIFIED line with the attempted count), 2 no usable snapshot,
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


def validate_replica(bucket: str, prefix: str) -> None:
    """Refuse lookalike buckets and any prefix that is not a fleet replica."""
    if not isinstance(bucket, str) or not isinstance(prefix, str):
        raise RuntimeError("refusing replica")
    if (not bucket) or ("/" in bucket) or (".." in bucket) or ("\\" in bucket):
        raise RuntimeError("refusing bucket")
    if (not prefix) or (".." in prefix) or ("\\" in prefix) or prefix.startswith("/") or prefix.endswith("/"):
        raise RuntimeError("refusing prefix")
    if (bucket, prefix) not in APPS.values():
        raise RuntimeError("refusing replica outside the fleet table")


def remote_level(bucket: str, prefix: str, level: str) -> str:
    validate_replica(bucket, prefix)
    if level not in ("0001", "0009"):
        raise RuntimeError("refusing level")
    return "b2:%s/%s/%s/" % (bucket, prefix, level)


def listing(bucket: str, prefix: str, level: str, runner=None) -> list[tuple[str, int, str]]:
    """(name, size, modtime) for one level, via lsl (Class C)."""
    run = runner or rclone
    out = run(["lsl", remote_level(bucket, prefix, level)])
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


def safe_l1_basename(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return txids(name) is not None


class BoundaryPlan:
    def __init__(self, code: int, doomed: list[str], kept: list[str]) -> None:
        self.code = code
        self.doomed = doomed
        self.kept = kept


def _records(rows):
    parsed = []
    for row in rows:
        if isinstance(row, dict):
            parsed.append({
                "name": str(row.get("name") or ""),
                "size": int(row.get("size") or 0),
                "modtime": str(row.get("modtime") or ""),
                "hidden": bool(row.get("hidden")),
            })
        else:
            hidden = bool(row[3]) if len(row) > 3 else False
            parsed.append({
                "name": str(row[0]),
                "size": int(row[1]),
                "modtime": str(row[2]),
                "hidden": hidden,
            })
    return parsed


def _collapse_links(kept: list[dict]) -> list[dict]:
    """One link per max TXID. A same-max twin must not look like a gap."""
    by_max = {}
    for rec in kept:
        by_max.setdefault(rec["rng"][1], []).append(rec)
    links = []
    prev_max = None
    for mx in sorted(by_max):
        group = by_max[mx]
        if prev_max is None:
            pool = group
        else:
            cont = [rec for rec in group if rec["rng"][0] == prev_max + 1]
            pool = cont or group
        chosen = min(pool, key=lambda rec: (rec["rng"][0], rec["name"]))
        links.append(chosen)
        prev_max = chosen["rng"][1]
    return links


def plan_boundary(snap_rows, l1_rows, *, now: datetime, max_age_hours: float) -> BoundaryPlan:
    """Decide which L1 basenames are safe to hide. Non-zero code means delete nothing."""
    snaps = []
    for rec in _records(snap_rows):
        if rec["hidden"] or not safe_l1_basename(rec["name"]):
            continue
        rng = txids(rec["name"])
        if rng is None:
            continue
        rec["rng"] = rng
        snaps.append(rec)
    if not snaps:
        log("ABORT: no parseable L9 snapshot")
        return BoundaryPlan(2, [], [])
    snaps.sort(key=lambda rec: (rec["rng"][1], rec["size"], rec["name"]))
    newest = snaps[-1]
    name = newest["name"]
    size = newest["size"]
    boundary = newest["rng"][1]
    log("newest snapshot %s size=%d modtime=%s boundary=%x" % (name, size, newest["modtime"], boundary))
    if size < MIN_SNAPSHOT_BYTES:
        log("ABORT: newest snapshot is only %d bytes (< %d)" % (size, MIN_SNAPSHOT_BYTES))
        return BoundaryPlan(3, [], [])
    if len(snaps) >= 2:
        prev_size = snaps[-2]["size"]
        if prev_size <= 0:
            log("ABORT: previous snapshot is %d bytes" % prev_size)
            return BoundaryPlan(3, [], [])
        if size < prev_size * MIN_SNAPSHOT_RATIO:
            log("ABORT: newest snapshot %d bytes is < %.0f%% of the previous %d bytes "
                "(possible truncation)" % (size, MIN_SNAPSHOT_RATIO * 100, prev_size))
            return BoundaryPlan(3, [], [])
        log("previous snapshot %d bytes - size ratio %.2f ok" % (prev_size, float(size) / float(prev_size)))
    try:
        snap_time = datetime.strptime(newest["modtime"].split(".")[0], "%Y-%m-%d %H:%M:%S").replace(
            tzinfo=timezone.utc)
    except ValueError:
        log("ABORT: could not parse snapshot modtime")
        return BoundaryPlan(3, [], [])
    age_h = (now - snap_time).total_seconds() / 3600
    if age_h > max_age_hours:
        log("ABORT: newest snapshot is %.1fh old (> %.1fh) - the nightly snapshot is late "
            "or failing; trimming to a stale boundary would be a near no-op"
            % (age_h, max_age_hours))
        return BoundaryPlan(3, [], [])
    log("snapshot age %.1fh - ok" % age_h)

    by_name = {}
    listed = 0
    for rec in _records(l1_rows):
        if rec["hidden"]:
            continue
        listed += 1
        if not safe_l1_basename(rec["name"]):
            log("WARN: unparseable L1 name skipped")
            continue
        rng = txids(rec["name"])
        if rng is None:
            log("WARN: unparseable L1 name skipped")
            continue
        rec["rng"] = rng
        prev = by_name.get(rec["name"])
        if prev is None or rec["size"] >= prev["size"]:
            by_name[rec["name"]] = rec

    doomed = []
    kept = []
    for rec in by_name.values():
        if rec["rng"][1] <= boundary:
            doomed.append(rec)
        else:
            kept.append(rec)
    doomed.sort(key=lambda rec: (rec["rng"][1], rec["name"]))
    kept.sort(key=lambda rec: (rec["rng"][0], rec["rng"][1], rec["name"]))
    log("L1 total=%d superseded=%d (%.0f MB) keep=%d (%.0f MB)"
        % (listed, len(doomed), sum(rec["size"] for rec in doomed) / 1e6,
           len(kept), sum(rec["size"] for rec in kept) / 1e6))

    kept_names = [rec["name"] for rec in kept]
    if kept:
        links = _collapse_links(kept)
        first_min = links[0]["rng"][0]
        if first_min > boundary + 1:
            log("ABORT: deleting would leave a restore hole -- snapshot ends %x but the "
                "kept chain starts %x" % (boundary, first_min))
            return BoundaryPlan(4, [], kept_names)
        log("first kept %s (chain reaches the snapshot)" % links[0]["name"])
        gaps = []
        for prev, cur in zip(links, links[1:]):
            pmax = prev["rng"][1]
            cmin = cur["rng"][0]
            if cmin != pmax + 1:
                gaps.append("%x->%x" % (pmax, cmin))
        if gaps:
            log("KEPT CHAIN HAS %d INTERNAL GAP(S): %s" % (len(gaps), ", ".join(gaps[:6])))
            log("ABORT: level-2 compaction will stay wedged on non-contiguous input; "
                "a human must reconcile these before trimming helps")
            return BoundaryPlan(5, [], kept_names)

    if not doomed:
        if listed > LARGE_L1:
            log("ABORT: nothing superseded although L1 holds %d objects -- the snapshot "
                "boundary did not advance past the backlog" % listed)
            return BoundaryPlan(6, [], kept_names)
        log("nothing superseded - no-op")
        return BoundaryPlan(0, [], kept_names)
    return BoundaryPlan(0, [rec["name"] for rec in doomed], kept_names)


def execute(argv=None, *, rclone_fn=None, now=None, chunk=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", choices=sorted(APPS), default="socratic")
    parser.add_argument("--max-snapshot-age-hours", type=float, default=48.0)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    runner = rclone_fn or rclone
    clock = now or datetime.now(timezone.utc)
    bucket, prefix = APPS[args.app]
    validate_replica(bucket, prefix)
    log("mode=%s app=%s bucket=%s prefix=%s max_snapshot_age=%.1fh"
        % ("APPLY" if args.apply else "DRY-RUN", args.app, bucket, prefix,
           args.max_snapshot_age_hours))
    # A listing failure is exit 1 (documented), never exit 2: 2 means "no
    # usable snapshot" and would send the operator to the wrong cause.
    # Exception, not RuntimeError: rclone() raises TimeoutExpired on a hang,
    # FileNotFoundError without the binary, and listing() ValueError on a
    # malformed lsl line.
    try:
        snap_rows = listing(bucket, prefix, "0009", runner)
    except Exception as exc:
        log("ABORT: snapshot listing failed (%s)" % type(exc).__name__)
        return 1
    try:
        l1_rows = listing(bucket, prefix, "0001", runner)
    except Exception as exc:
        log("ABORT: L1 listing failed (%s)" % type(exc).__name__)
        return 1
    plan = plan_boundary(
        snap_rows, l1_rows, now=clock, max_age_hours=args.max_snapshot_age_hours)
    if plan.code != 0:
        return plan.code
    if not plan.doomed:
        return 0
    for name in plan.doomed:
        if not safe_l1_basename(name):
            log("ABORT: refusing unsafe L1 name")
            return 3
    if not args.apply:
        log("DRY RUN - rerun with --apply to delete %d objects" % len(plan.doomed))
        return 0

    # NOT --b2-hard-delete: the host's scoped fleet-backup-writer key may
    # hide versions but gets "Unknown 401 (401 unauthorized)" on
    # b2_delete_file_version, so a hard delete silently deletes nothing
    # (measured 2026-09-01: ~800 no-op "deletes" against Congress.Trade).
    # A hide is enough to unwedge compaction -- litestream stops seeing the
    # object immediately -- and the bucket's own lifecycle rule
    # (daysFromHidingToDeleting=1) frees the bytes about a day later.
    # Hard deletes need the B2 master key; run the trim from an operator
    # workstation if you need the space back the same hour.
    target = remote_level(bucket, prefix, "0001")
    step = DELETE_CHUNK if not chunk else int(chunk)
    if step < 1:
        step = DELETE_CHUNK
    sent = errors = attempted = 0
    for start in range(0, len(plan.doomed), step):
        names = plan.doomed[start:start + step]
        handle, listfile = tempfile.mkstemp(prefix="l1-trim-", suffix=".txt")
        try:
            with os.fdopen(handle, "w") as fh:
                fh.write("".join(item + "\n" for item in names))
            # A failed batch still counts as attempted: rclone may have
            # hidden some of its objects before it errored.
            attempted += len(names)
            try:
                runner(["delete", target, "--files-from", listfile,
                        "--transfers", "16", "--checkers", "16"])
            except Exception:
                errors += 1
                log("ABORT: delete batch failed; stopping")
                break
            sent += len(names)
            log("progress %d/%d" % (sent, len(plan.doomed)))
        finally:
            try:
                os.unlink(listfile)
            except OSError:
                pass
    try:
        remaining = {nm for nm, _size, _when in listing(bucket, prefix, "0001", runner)}
    except Exception as exc:
        # The deletes already ran and are not reverted, so say how many were
        # sent: without this line an applied-but-unverified run reads as a
        # no-op.  Still exit 1 (a failed listing), never 0.
        log("ABORT: post-delete listing failed (%s); delete state is unverified"
            % type(exc).__name__)
        log("APPLIED-UNVERIFIED app=%s attempted=%d issued_ok=%d batch_errors=%d "
            "survived=unverified" % (args.app, attempted, sent, errors))
        return 1
    survivors = [nm for nm in plan.doomed if nm in remaining]
    deleted = len(plan.doomed) - len(survivors)
    log("APPLIED app=%s deleted=%d survived=%d batch_errors=%d"
        % (args.app, deleted, len(survivors), errors))
    if survivors:
        log("first survivors: %s" % ", ".join(survivors[:5]))
    if errors or survivors:
        return 1
    return 0


def main(argv=None) -> int:
    return execute(argv)


if __name__ == "__main__":
    sys.exit(main())
