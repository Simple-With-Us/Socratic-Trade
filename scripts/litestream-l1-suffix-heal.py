#!/usr/bin/env python3
"""Unwedge Litestream L2/L3 on Backblaze B2 by keeping a short contiguous L1 suffix.

Litestream 0.5.12 Compact walks from the last L2 max TXID and, after a multi-day
gap, tries to upload ONE L2 file covering every pending L1 object.  That upload
fails (connection reset / LTX header EOF).  L0 and L1 keep advancing.

This tool:
  - lists ONLY bucket jays-socratic-trade-eu (live B2 replica)
  - keeps the newest KEEP_L1 contiguous L1 objects
  - deletes older L1 plus ALL L2 and L3 (so Compact rebuilds small files)
  - never touches L0, L9, cold-snapshots, or any other bucket

Default is --dry-run.  Pass --apply to delete.

Credentials (never printed): B2_KEY_ID + B2_APPLICATION_KEY, or
BACKBLAZE_MASTER_KEY_ID + BACKBLAZE_MASTER_APPLICATION_KEY.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from typing import Any

LIVE_BUCKET = "jays-socratic-trade-eu"
LIVE_ENDPOINT_HINT = "s3.eu-central-003.backblazeb2.com"
REPLICA_PREFIX = "trading-live/app.db/"
LTX_RE = re.compile(r"([0-9a-f]{16})-([0-9a-f]{16})\.ltx$", re.I)
KEEP_L1_DEFAULT = 48
LEVELS_DELETE_ALL = ("0002", "0003")
LEVEL_L1 = "0001"
FORBIDDEN_LEVELS = ("0000", "0009")


def die(msg: str, code: int = 2) -> None:
    print("litestream-l1-suffix-heal: ERROR:", msg, file=sys.stderr)
    raise SystemExit(code)


def load_keys() -> tuple[str, str]:
    kid = (
        os.environ.get("B2_KEY_ID")
        or os.environ.get("BACKBLAZE_MASTER_KEY_ID")
        or ""
    ).strip()
    sec = (
        os.environ.get("B2_APPLICATION_KEY")
        or os.environ.get("BACKBLAZE_MASTER_APPLICATION_KEY")
        or ""
    ).strip()
    if not kid or not sec:
        die("set B2_KEY_ID and B2_APPLICATION_KEY (values never printed)")
    return kid, sec


def b2_authorize(kid: str, sec: str) -> dict[str, Any]:
    token = base64.b64encode(f"{kid}:{sec}".encode()).decode()
    req = urllib.request.Request(
        "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
        headers={"Authorization": f"Basic {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    s3 = str(data.get("s3ApiUrl") or "")
    if LIVE_ENDPOINT_HINT not in s3:
        die(f"s3ApiUrl is not the live EU B2 cluster (got host without {LIVE_ENDPOINT_HINT})")
    return data


def b2_post(api_url: str, auth_token: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{api_url}/b2api/v2/{method}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": auth_token, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        die(f"{method} HTTP {err.code}")


def bucket_id_for(auth: dict[str, Any], name: str) -> str:
    data = b2_post(
        auth["apiUrl"],
        auth["authorizationToken"],
        "b2_list_buckets",
        {"accountId": auth["accountId"]},
    )
    for bucket in data.get("buckets") or []:
        if bucket.get("bucketName") == name:
            bid = str(bucket.get("bucketId") or "")
            if len(bid) < 8:
                die("bucket id missing")
            return bid
    die(f"bucket {name} not found")


def list_level(auth: dict[str, Any], bucket_id: str, level: str) -> list[dict[str, Any]]:
    prefix = f"{REPLICA_PREFIX}{level}/"
    out: list[dict[str, Any]] = []
    start = None
    while True:
        payload: dict[str, Any] = {
            "bucketId": bucket_id,
            "prefix": prefix,
            "maxFileCount": 10000,
        }
        if start:
            payload["startFileName"] = start
        data = b2_post(
            auth["apiUrl"],
            auth["authorizationToken"],
            "b2_list_file_names",
            payload,
        )
        for item in data.get("files") or []:
            name = str(item.get("fileName") or "")
            if not name.startswith(prefix):
                continue
            out.append(
                {
                    "fileName": name,
                    "fileId": item.get("fileId"),
                    "contentLength": int(item.get("contentLength") or 0),
                }
            )
        nxt = data.get("nextFileName")
        if not nxt:
            break
        start = nxt
    out.sort(key=lambda row: row["fileName"])
    return out


def parse_range(name: str) -> tuple[int, int] | None:
    match = LTX_RE.search(name)
    if not match:
        return None
    return int(match.group(1), 16), int(match.group(2), 16)


def hole_and_twin_counts(files: list[dict[str, Any]]) -> tuple[int, int]:
    """Holes = next.min != prev.max+1; twins = same max, different min (not holes)."""
    ranges: list[tuple[int, int]] = []
    for row in files:
        parsed = parse_range(row["fileName"])
        if parsed:
            ranges.append(parsed)
    holes = 0
    twins = 0
    for i in range(1, len(ranges)):
        prev_min, prev_max = ranges[i - 1]
        cur_min, cur_max = ranges[i]
        if cur_max == prev_max and cur_min != prev_min:
            twins += 1
            continue
        if cur_min != prev_max + 1:
            holes += 1
    return holes, twins


def hole_count(files: list[dict[str, Any]]) -> int:
    holes, _twins = hole_and_twin_counts(files)
    return holes


def plan_l1(files: list[dict[str, Any]], keep: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Keep the newest contiguous L1 suffix (up to keep files), delete the older prefix.

    When L1 is already contiguous (live 2026-08 measured 0 holes), this is just the
    last N objects.  If holes exist, walk back from the tip only while contiguous so
    Compact does not try a mega L2 across a gap.
    """
    if keep < 8:
        die("--keep-l1 must be >= 8")
    if len(files) <= keep:
        return [], files

    # Walk backward from tip while LTX ranges stay contiguous (twins allowed).
    suffix_start = len(files) - 1
    while suffix_start > 0 and (len(files) - suffix_start) < keep:
        cur = parse_range(files[suffix_start]["fileName"])
        prev = parse_range(files[suffix_start - 1]["fileName"])
        if not cur or not prev:
            break
        cur_min, cur_max = cur
        prev_min, prev_max = prev
        if cur_max == prev_max and cur_min != prev_min:
            suffix_start -= 1
            continue
        if cur_min == prev_max + 1:
            suffix_start -= 1
            continue
        break

    # Prefer up to `keep` files ending at tip; if the contiguous run is shorter, keep it all.
    keep_start = max(suffix_start, len(files) - keep)
    return files[:keep_start], files[keep_start:]


def delete_one(auth: dict[str, Any], row: dict[str, Any]) -> None:
    name = row["fileName"]
    file_id = row["fileId"]
    if not file_id:
        die(f"missing fileId for {name}")
    if not name.startswith(REPLICA_PREFIX):
        die(f"refusing delete outside replica prefix: {name}")
    if "/0000/" in name or "/0009/" in name:
        die(f"refusing delete of L0/L9: {name}")
    b2_post(
        auth["apiUrl"],
        auth["authorizationToken"],
        "b2_delete_file_version",
        {"fileName": name, "fileId": file_id},
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Keep a short L1 suffix so L2/L3 can rebuild.")
    parser.add_argument("--apply", action="store_true", help="actually delete (default is dry-run)")
    parser.add_argument("--keep-l1", type=int, default=KEEP_L1_DEFAULT)
    args = parser.parse_args()

    print("endpoint_hint", LIVE_ENDPOINT_HINT)
    print("bucket", LIVE_BUCKET)
    print("replica_prefix", REPLICA_PREFIX)
    print("mode", "APPLY" if args.apply else "DRY-RUN")

    kid, sec = load_keys()
    auth = b2_authorize(kid, sec)
    print("auth_ok True s3ApiUrl_host", str(auth.get("s3ApiUrl") or "").split("/")[2])
    bucket_id = bucket_id_for(auth, LIVE_BUCKET)
    print("bucket_id_len", len(bucket_id))

    l1 = list_level(auth, bucket_id, LEVEL_L1)
    l2 = list_level(auth, bucket_id, "0002")
    l3 = list_level(auth, bucket_id, "0003")
    l0 = list_level(auth, bucket_id, "0000")
    l9 = list_level(auth, bucket_id, "0009")
    print("counts L0", len(l0), "L1", len(l1), "L2", len(l2), "L3", len(l3), "L9", len(l9))
    l1_holes, l1_twins = hole_and_twin_counts(l1)
    l2_holes, l2_twins = hole_and_twin_counts(l2)
    print("L1 holes", l1_holes, "twins", l1_twins, "L2 holes", l2_holes, "twins", l2_twins)
    if l1:
        print("L1 first", l1[0]["fileName"].rsplit("/", 1)[-1], "bytes", l1[0]["contentLength"])
        print("L1 last ", l1[-1]["fileName"].rsplit("/", 1)[-1], "bytes", l1[-1]["contentLength"])
    if l2:
        print("L2 last ", l2[-1]["fileName"].rsplit("/", 1)[-1], "bytes", l2[-1]["contentLength"])
    if l1 and l2:
        l1_tip = parse_range(l1[-1]["fileName"])
        l2_tip = parse_range(l2[-1]["fileName"])
        if l1_tip and l2_tip:
            print("catch_up_span_txids", l1_tip[1] - l2_tip[1])
    if l9:
        print("L9 last ", l9[-1]["fileName"].rsplit("/", 1)[-1], "bytes", l9[-1]["contentLength"])

    l1_delete, l1_keep = plan_l1(l1, args.keep_l1)
    delete_rows = l1_delete + l2 + l3
    keep_bytes = sum(row["contentLength"] for row in l1_keep)
    delete_bytes = sum(row["contentLength"] for row in delete_rows)
    print("keep_l1", len(l1_keep), "keep_bytes", keep_bytes)
    print("delete_l1", len(l1_delete), "delete_l2", len(l2), "delete_l3", len(l3), "delete_total", len(delete_rows), "delete_bytes", delete_bytes)
    if l1_keep:
        print("keep_first", l1_keep[0]["fileName"].rsplit("/", 1)[-1])
        print("keep_last", l1_keep[-1]["fileName"].rsplit("/", 1)[-1])

    if not args.apply:
        print("dry-run complete; rerun with --apply to delete")
        return

    deleted = 0
    failed = 0
    for row in delete_rows:
        try:
            delete_one(auth, row)
            deleted += 1
            if deleted % 200 == 0:
                print("deleted", deleted, "/", len(delete_rows))
        except SystemExit:
            raise
        except Exception as err:
            failed += 1
            print("delete_failed", type(err).__name__, row["fileName"].rsplit("/", 1)[-1])
    print("apply_done deleted", deleted, "failed", failed)
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
