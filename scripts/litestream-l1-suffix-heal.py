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
  - deletes every version of a doomed key, uploads before hide markers
  - stops on the first delete error instead of continuing

Default is --dry-run.  Pass --apply to delete.

Credentials (never printed): B2_KEY_ID + B2_APPLICATION_KEY, or
BACKBLAZE_MASTER_KEY_ID + BACKBLAZE_MASTER_APPLICATION_KEY.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import posixpath
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
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        die(f"b2_authorize_account HTTP {err.code}")
    except urllib.error.URLError:
        die("b2_authorize_account unreachable")
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
    except urllib.error.URLError:
        die(f"{method} unreachable")


def bucket_id_for(post: Any, account_id: str, name: str) -> str:
    data = post("b2_list_buckets", {"accountId": account_id})
    match = None
    for bucket in data.get("buckets") or []:
        if bucket.get("bucketName") == name:
            match = bucket
            break
    if match is None:
        die(f"bucket {name} not found")
    bid = str(match.get("bucketId") or "")
    if len(bid) < 8:
        die("bucket id missing")
    return bid


# Visible LTX under the replica. Deletes are a stricter subset (no L0, no L9).
VISIBLE_RE = re.compile(
    "^" + re.escape(REPLICA_PREFIX) + r"(0000|0001|0002|0003|0009)/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$",
    re.IGNORECASE,
)
# Exact L1/L2/L3 object. L0, L9, lookalike prefixes, and ".." never match.
DELETABLE_RE = re.compile(
    "^" + re.escape(REPLICA_PREFIX) + r"(0001|0002|0003)/[0-9a-f]{16}-[0-9a-f]{16}\.ltx$",
    re.IGNORECASE,
)


def visible_ltx(name: str) -> bool:
    if not isinstance(name, str) or not name:
        return False
    if ".." in name or "\\" in name or "//" in name or name.startswith("/"):
        return False
    if posixpath.normpath(name) != name:
        return False
    return VISIBLE_RE.match(name) is not None


def deletion_refusal(name: str) -> str | None:
    """Reason to refuse deleting this key, or None when the key is in scope."""
    if not isinstance(name, str) or not name:
        return "refusing delete of empty name"
    if ".." in name or "\\" in name or "//" in name or name.startswith("/"):
        return "refusing delete of unsafe name"
    if not name.startswith(REPLICA_PREFIX):
        return "refusing delete outside replica prefix"
    if "/0000/" in name or "/0009/" in name:
        return "refusing delete of L0/L9"
    normalized = posixpath.normpath(name)
    if normalized != name or not normalized.startswith(REPLICA_PREFIX):
        return "refusing delete of unsafe name"
    if DELETABLE_RE.match(name) is None:
        return "refusing delete outside L1/L2/L3 ltx names"
    return None


def parse_range(name: str) -> tuple[int, int] | None:
    match = LTX_RE.search(name)
    if not match:
        return None
    return int(match.group(1), 16), int(match.group(2), 16)


def hole_and_twin_counts(files: list[dict[str, Any]]) -> tuple[int, int]:
    """Holes after collapsing same-max twins. A twin is not a hole."""
    by_max: dict[int, list[int]] = {}
    for row in files:
        parsed = parse_range(row["fileName"])
        if parsed:
            by_max.setdefault(parsed[1], []).append(parsed[0])
    links: list[tuple[int, int]] = []
    twins = 0
    prev_max = None
    for mx in sorted(by_max):
        mins = by_max[mx]
        distinct = set(mins)
        if len(distinct) > 1:
            twins += len(distinct) - 1
        if prev_max is None:
            chosen = min(mins)
        else:
            continuing = [lo for lo in mins if lo == prev_max + 1]
            chosen = min(continuing) if continuing else min(mins)
        links.append((chosen, mx))
        prev_max = mx
    holes = 0
    for index in range(1, len(links)):
        if links[index][0] != links[index - 1][1] + 1:
            holes += 1
    return holes, twins


def hole_count(files: list[dict[str, Any]]) -> int:
    holes, _twins = hole_and_twin_counts(files)
    return holes


def list_file_versions(post: Any, bucket_id: str, prefix: str) -> list[dict[str, Any]]:
    """Every B2 version under prefix. Pagination must send both cursors."""
    out: list[dict[str, Any]] = []
    start_name = None
    start_id = None
    seen: set[tuple[str, str]] = set()
    pages = 0
    while True:
        pages += 1
        if pages > 10000:
            die("b2_list_file_versions pagination did not finish")
        payload: dict[str, Any] = {
            "bucketId": bucket_id,
            "prefix": prefix,
            "maxFileCount": 10000,
        }
        if start_name is not None:
            payload["startFileName"] = start_name
            payload["startFileId"] = start_id
        try:
            data = post("b2_list_file_versions", payload)
        except SystemExit:
            raise
        except Exception as err:
            die(f"b2_list_file_versions failed ({type(err).__name__})")
        if not isinstance(data, dict):
            die("b2_list_file_versions returned a non-object")
        for item in data.get("files") or []:
            name = str(item.get("fileName") or "")
            if not name.startswith(prefix):
                continue
            out.append(item)
        nxt_name = data.get("nextFileName")
        nxt_id = data.get("nextFileId")
        if not nxt_name and not nxt_id:
            break
        if not nxt_name or not nxt_id:
            die("b2_list_file_versions pagination cursor incomplete")
        cursor = (str(nxt_name), str(nxt_id))
        if cursor in seen or cursor == (start_name, start_id):
            die("b2_list_file_versions pagination cursor repeated")
        seen.add(cursor)
        start_name, start_id = cursor
    return out


def list_file_names(post: Any, bucket_id: str, prefix: str) -> list[dict[str, Any]]:
    """Current (live) B2 objects under prefix: one row per name, no history.

    For count-only levels (L0, L9).  Listing every retained version there
    would load each superseded upload and hide marker just to print a count.
    """
    out: list[dict[str, Any]] = []
    start_name = None
    seen: set[str] = set()
    pages = 0
    while True:
        pages += 1
        if pages > 10000:
            die("b2_list_file_names pagination did not finish")
        payload: dict[str, Any] = {
            "bucketId": bucket_id,
            "prefix": prefix,
            "maxFileCount": 10000,
        }
        if start_name is not None:
            payload["startFileName"] = start_name
        try:
            data = post("b2_list_file_names", payload)
        except SystemExit:
            raise
        except Exception as err:
            die(f"b2_list_file_names failed ({type(err).__name__})")
        if not isinstance(data, dict):
            die("b2_list_file_names returned a non-object")
        for item in data.get("files") or []:
            name = str(item.get("fileName") or "")
            if not name.startswith(prefix):
                continue
            out.append(item)
        nxt_name = data.get("nextFileName")
        if not nxt_name:
            break
        cursor = str(nxt_name)
        if cursor in seen or cursor == start_name:
            die("b2_list_file_names pagination cursor repeated")
        seen.add(cursor)
        start_name = cursor
    return out


def _stamp(row: dict[str, Any]) -> tuple[int, str]:
    return (int(row.get("uploadTimestamp") or 0), str(row.get("fileId") or ""))


def _current_version(group: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Newest finished upload or hide. An unfinished large-file start is not a file."""
    meaningful = [
        row for row in group
        if str(row.get("action") or "upload") in {"upload", "hide"}
    ]
    if not meaningful:
        return None
    return max(meaningful, key=_stamp)


def live_rows(versions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One visible upload per name. A newer hide marker means the name is not live."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in versions:
        name = str(row.get("fileName") or "")
        grouped.setdefault(name, []).append(row)
    live: list[dict[str, Any]] = []
    for name, group in grouped.items():
        if not visible_ltx(name) or parse_range(name) is None:
            continue
        newest = _current_version(group)
        if newest is None or str(newest.get("action") or "upload") == "hide":
            continue
        live.append(
            {
                "fileName": name,
                "fileId": newest.get("fileId"),
                "contentLength": int(newest.get("contentLength") or 0),
                "uploadTimestamp": int(newest.get("uploadTimestamp") or 0),
            }
        )
    live.sort(key=lambda row: (parse_range(row["fileName"]), row["fileName"]))
    return live


def _tx_key(row: dict[str, Any]) -> tuple[Any, ...]:
    parsed = parse_range(str(row.get("fileName") or "")) or (0, 0)
    return (parsed[1], parsed[0], str(row.get("fileName") or ""))


def plan_l1(files: list[dict[str, Any]], keep: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Keep the newest contiguous L1 suffix, up to `keep` live objects.

    The CLI rejects keep < 8 before anything is deleted. This function still
    defines the edges: 0 keeps nothing, 1 keeps only the newest live object,
    and a keep larger than the chain keeps the contiguous suffix only. A gap
    drops everything before that gap even when the file count is below keep.
    Same-max twins stay in the chain (they are not a hole).
    """
    if keep < 0:
        die("--keep-l1 must be >= 0")
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in files:
        name = str(row.get("fileName") or "")
        if deletion_refusal(name) or parse_range(name) is None:
            continue
        grouped.setdefault(name, []).append(row)
    prepared = []
    for name, group in grouped.items():
        newest = _current_version(group)
        if newest is None or str(newest.get("action") or "upload") == "hide":
            continue
        prepared.append(newest)
    prepared.sort(key=_tx_key)
    if keep == 0 or not prepared:
        return prepared, []

    by_max: dict[int, list[dict[str, Any]]] = {}
    for row in prepared:
        parsed = parse_range(str(row["fileName"]))
        assert parsed is not None
        by_max.setdefault(parsed[1], []).append(row)
    maxes = sorted(by_max)
    suffix_maxes = [maxes[-1]]
    index = len(maxes) - 1
    while index > 0 and len(suffix_maxes) < len(maxes):
        newer = maxes[index]
        older = maxes[index - 1]
        continues = False
        for row in by_max[newer]:
            parsed = parse_range(str(row["fileName"]))
            if parsed and parsed[0] == older + 1:
                continues = True
                break
        if not continues:
            break
        suffix_maxes.append(older)
        index -= 1
    allowed = set(suffix_maxes)
    suffix = []
    for row in prepared:
        parsed = parse_range(str(row["fileName"]))
        if parsed is not None and parsed[1] in allowed:
            suffix.append(row)
    if len(suffix) > keep:
        suffix = suffix[-keep:]
    suffix_names = {str(row["fileName"]) for row in suffix}
    delete = [row for row in prepared if str(row["fileName"]) not in suffix_names]
    return delete, suffix


def planned_deletes(
    raw_by_level: dict[str, list[dict[str, Any]]], keep: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Versions to delete, and the live L1 rows to keep.

    Kept names are not deleted, including their older versions. Doomed names
    lose every version, with uploads ordered before hide markers so a stopped
    run cannot unhide an object.
    """
    l1_live = live_rows(raw_by_level.get(LEVEL_L1) or [])
    _l1_delete, l1_keep = plan_l1(l1_live, keep)
    keep_names = {str(row["fileName"]) for row in l1_keep}
    doomed_names: set[str] = set()
    for level in LEVELS_DELETE_ALL + (LEVEL_L1,):
        for row in raw_by_level.get(level) or []:
            name = str(row.get("fileName") or "")
            if name in keep_names or deletion_refusal(name) or parse_range(name) is None:
                continue
            doomed_names.add(name)
    rows: list[dict[str, Any]] = []
    for level in (LEVEL_L1,) + LEVELS_DELETE_ALL:
        for row in raw_by_level.get(level) or []:
            name = str(row.get("fileName") or "")
            if name not in doomed_names:
                continue
            rows.append(row)
    rows.sort(
        key=lambda row: (
            str(row.get("fileName") or ""),
            1 if str(row.get("action") or "upload") == "hide" else 0,
            int(row.get("uploadTimestamp") or 0),
            str(row.get("fileId") or ""),
        )
    )
    return rows, l1_keep


def delete_one(post: Any, row: dict[str, Any]) -> None:
    name = str(row.get("fileName") or "")
    file_id = row.get("fileId")
    if not file_id:
        die("missing fileId")
    reason = deletion_refusal(name)
    if reason:
        die(reason + ": " + name.rsplit("/", 1)[-1])
    post("b2_delete_file_version", {"fileName": name, "fileId": file_id})


def _offline_auth(kid: str, sec: str) -> dict[str, Any]:
    del kid, sec
    return {
        "apiUrl": "https://api.backblazeb2.test",
        "authorizationToken": "offline",
        "accountId": "offline-account",
        "s3ApiUrl": "https://" + LIVE_ENDPOINT_HINT,
    }


def execute(argv: list[str] | None = None, *, post: Any = None, authorize: Any = None) -> None:
    parser = argparse.ArgumentParser(description="Keep a short L1 suffix so L2/L3 can rebuild.")
    parser.add_argument("--apply", action="store_true", help="actually delete (default is dry-run)")
    parser.add_argument("--keep-l1", type=int, default=KEEP_L1_DEFAULT)
    args = parser.parse_args(argv)
    if args.keep_l1 < 8:
        die("--keep-l1 must be >= 8")

    print("endpoint_hint", LIVE_ENDPOINT_HINT)
    print("bucket", LIVE_BUCKET)
    print("replica_prefix", REPLICA_PREFIX)
    print("mode", "APPLY" if args.apply else "DRY-RUN")

    kid, sec = load_keys()
    try:
        if authorize is not None:
            auth = authorize(kid, sec)
        elif post is None:
            auth = b2_authorize(kid, sec)
        else:
            auth = _offline_auth(kid, sec)
    except SystemExit:
        raise
    except Exception:
        die("b2 authorization failed")
    if post is None:
        def post(method: str, payload: dict[str, Any], _auth: dict[str, Any] = auth) -> dict[str, Any]:
            return b2_post(_auth["apiUrl"], _auth["authorizationToken"], method, payload)

    print("auth_ok True s3ApiUrl_host", str(auth.get("s3ApiUrl") or "").split("/")[2])
    bucket_id = bucket_id_for(post, str(auth.get("accountId") or ""), LIVE_BUCKET)
    print("bucket_id_len", len(bucket_id))

    raw: dict[str, list[dict[str, Any]]] = {}
    # Every version only where the run deletes (L1/L2/L3).  L0 and L9 are
    # never deleted and only counted, so list their current names.
    for level in (LEVEL_L1,) + LEVELS_DELETE_ALL:
        raw[level] = list_file_versions(post, bucket_id, f"{REPLICA_PREFIX}{level}/")
    for level in FORBIDDEN_LEVELS:
        raw[level] = list_file_names(post, bucket_id, f"{REPLICA_PREFIX}{level}/")
    l1 = live_rows(raw[LEVEL_L1])
    l2 = live_rows(raw["0002"])
    l3 = live_rows(raw["0003"])
    l0 = live_rows(raw["0000"])
    l9 = live_rows(raw["0009"])
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

    delete_rows, l1_keep = planned_deletes(raw, args.keep_l1)
    keep_ids = {str(row.get("fileId")) for row in l1_keep if row.get("fileId")}
    for row in delete_rows:
        if str(row.get("fileId") or "") in keep_ids:
            die("refusing delete of a kept L1 version")
        if not row.get("fileId"):
            die("missing fileId")
        reason = deletion_refusal(str(row.get("fileName") or ""))
        if reason:
            die(reason)
    keep_bytes = sum(int(row.get("contentLength") or 0) for row in l1_keep)
    delete_bytes = sum(int(row.get("contentLength") or 0) for row in delete_rows)
    doomed_l1 = {str(row["fileName"]) for row in l1 if str(row["fileName"]) not in {str(k["fileName"]) for k in l1_keep}}
    print("keep_l1", len(l1_keep), "keep_bytes", keep_bytes)
    print(
        "delete_l1", len(doomed_l1),
        "delete_l2", len({str(row.get("fileName")) for row in delete_rows if "/0002/" in str(row.get("fileName"))}),
        "delete_l3", len({str(row.get("fileName")) for row in delete_rows if "/0003/" in str(row.get("fileName"))}),
        "delete_total", len(delete_rows),
        "delete_bytes", delete_bytes,
    )
    if l1_keep:
        print("keep_first", l1_keep[0]["fileName"].rsplit("/", 1)[-1])
        print("keep_last", l1_keep[-1]["fileName"].rsplit("/", 1)[-1])

    if not args.apply:
        print("dry-run complete; rerun with --apply to delete")
        return

    deleted = 0
    for row in delete_rows:
        try:
            delete_one(post, row)
        except SystemExit:
            print("apply_stopped", "deleted", deleted, "remaining", len(delete_rows) - deleted)
            raise
        except Exception as err:
            print("delete_failed", type(err).__name__, str(row.get("fileName") or "").rsplit("/", 1)[-1])
            print("apply_stopped", "deleted", deleted, "remaining", len(delete_rows) - deleted)
            raise SystemExit(1)
        deleted += 1
        if deleted % 200 == 0:
            print("deleted", deleted, "/", len(delete_rows))
    print("apply_done deleted", deleted, "failed", 0)


def main(argv: list[str] | None = None) -> None:
    execute(argv)


if __name__ == "__main__":
    main()
