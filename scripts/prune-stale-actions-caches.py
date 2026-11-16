#!/usr/bin/env python3
"""Compute which GitHub Actions cache entries are stale (superseded by a newer entry
with the same key prefix on the same ref) and should be deleted.

Reads a JSON array of cache entries (the shape of `gh cache list --json
id,key,ref,createdAt`) from stdin and prints one cache id per line to stdout --
every entry EXCEPT the newest one in each (key-prefix, ref) group.

The "key prefix" strips a trailing content-hash segment (16+ hex chars, e.g. the
lockfile/source hash suffix on ci.yml's `Linux-nextjs-<hash>-<hash>` cache key) so
that every historical build of the same cache lineage on the same ref collapses
into one group, keeping only its most recent entry.

Used by .github/workflows/cleanup-caches.yml's scheduled prune job. See that
workflow's header comment for the cache-hygiene incident this addresses.
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict

_HASH_SUFFIX = re.compile(r"-[0-9a-f]{16,}$")


def prune_ids(entries: list[dict]) -> list[str]:
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for entry in entries:
        prefix = _HASH_SUFFIX.sub("", entry["key"])
        groups[(prefix, entry["ref"])].append(entry)

    to_delete: list[str] = []
    for items in groups.values():
        items.sort(key=lambda e: e["createdAt"], reverse=True)
        to_delete.extend(str(e["id"]) for e in items[1:])  # keep newest, drop the rest
    return to_delete


def main() -> None:
    entries = json.load(sys.stdin)
    for cache_id in prune_ids(entries):
        print(cache_id)


if __name__ == "__main__":
    main()
