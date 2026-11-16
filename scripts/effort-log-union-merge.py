#!/usr/bin/env python3
"""
effort-log-union-merge.py — safely reconcile the machine-local live effort
board (`/Users/jay/apps/<APP>-EFFORT-LOG.md`) against the repo-tracked mirror
(`docs/EFFORT-LOG.md`), WITHOUT ever dropping a row that exists only on the
live board.

Why this exists
----------------
Per `docs/EFFORT-LOG-PROTOCOL.md`, the live board is updated FIRST and is the
real-time source of truth; the repo mirror is updated at every commit/push and
lags the live board between landings. Any process that reconciles the two by
taking the mirror's content "wholesale" (a pattern already used ad hoc when
resolving `docs/EFFORT-LOG.md`'s `merge=union` git-attribute conflicts, see
`docs/rollouts/2026-07-09-vitest-tmpdb-cleanup.md`) silently deletes any row
an agent added to the live board that hasn't been mirrored into a commit yet
— observed 2026-07-09: a pickup claim row added 17:35 was gone from the live
board by 18:22 (see the "Live-board union-merge clobber" fleet coordination
note). This script is the safe version of that reconciliation.

Algorithm (deliberately asymmetric — mirror is the base, live is protected)
-----------------------------------------------------------------------------
1. Parse both files into board items (same section/bullet parsing model as
   `scripts/sync-effort-issues.py`): a top-level `- `/`* ` bullet starts an
   item, indented/blank continuation lines fold into it, a `## ` heading
   starts a new section classified into one of the four canonical buckets
   (deployed / completed / in-progress / planned) by keyword, or ignored
   (e.g. "Changelog", intro prose) if it matches none.
2. Each item's identity is a SHA1 hash of its normalized first line (bullet
   markers and markdown emphasis stripped, whitespace collapsed, lowercased)
   — identical scheme to `scripts/sync-effort-issues.py`'s `effort-key`, so a
   row's identity is stable across the two tools and across a state
   transition that doesn't reword the first line.
3. The output starts as the MIRROR's content verbatim (it is already a
   well-formed, protocol-maintained document — this mirrors how agents
   already resolve board conflicts by taking one side wholesale, see the
   rollout note above, except now it's mechanical and doesn't drop rows).
4. Every item whose key exists on the LIVE board but NOT anywhere in the
   MIRROR (i.e. a live-only, not-yet-mirrored row — exactly the case that
   was previously silently deleted) is appended verbatim to the END of its
   matching bucket section in the output. If that bucket has no existing
   section in the mirror (rare), a new section is appended at the end of the
   document.  Items whose key already exists in the mirror always take the
   MIRROR's text (the mirror is authoritative for anything it already
   tracks) — this is the "only rows present in a mirror may be updated from
   the mirror" half of the rule.
5. HARD INVARIANT, enforced before any write: every item key present on the
   input LIVE board must be present in the computed output. If this ever
   fails (a bug in this script, or a live-board item with an unparseable
   heading context) the script aborts with a non-zero exit and writes
   nothing, rather than risk silently dropping a row the way the bug being
   fixed did.

This script only ever WRITES the `--out` target (default: the live board
path). It never mutates `docs/EFFORT-LOG.md` — the mirror is only ever read.
That keeps this tool's blast radius to exactly the file the historical bug
corrupted.

Usage
-----
    python3 scripts/effort-log-union-merge.py \
        --live /Users/jay/apps/TRADING-EFFORT-LOG.md \
        --mirror docs/EFFORT-LOG.md \
        --dry-run

    python3 scripts/effort-log-union-merge.py \
        --live /Users/jay/apps/TRADING-EFFORT-LOG.md \
        --mirror docs/EFFORT-LOG.md \
        --apply

`--dry-run` (default) reports which live-only rows would be recovered and
which bucket they'd land in, and writes nothing. `--apply` performs the
write (to `--out`, default same path as `--live`) and re-verifies the
invariant against the file it just wrote. `--out PATH` lets tests point the
write at a scratch copy instead of the real live board.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field

BULLET_RE = re.compile(r"^[-*]\s+(.*)$")
# Matches level-2 AND deeper (###, ####, ...) ATX headings. Capturing the hash
# run lets parse_board distinguish a top-level section (`## `) from a nested
# subsection (`### `): a `##` heading resets the bucket context outright, while
# a deeper heading classifies by its OWN keyword if it has one (e.g.
# "### Action - clear recommendation (Planned)") and otherwise INHERITS the
# enclosing `##` section's bucket. Only matching `##` (the previous behavior)
# made rows under a keyword-bearing `###` whose parent `##` was unclassified
# invisible to both the recovery pass and the invariant — a silent-drop hole,
# exactly the class of loss this tool exists to prevent.
HEADING_RE = re.compile(r"^(#{2,})\s+(.*)$")
PLACEHOLDER_RE = re.compile(
    r"^\(?\s*(none|n/?a\b.*|seeded empty.*|add rows here.*)\s*\)?\.?$",
    re.IGNORECASE,
)
# Broad imperative prefixes ("record the ...", "see rollout notes ...") only
# count as empty-section scaffolding when PARENTHESIZED — those template notes
# are always wrapped, e.g. "(record the effort here before starting)". A bare
# "Record the P&L reconciliation ..." / "See rollout notes for the X migration"
# is a REAL effort row; matching it unparenthesized (as the old combined pattern
# did, with optional parens) silently dropped it — the exact silent-drop class
# this tool exists to prevent. Requiring the wrapping parens closes that hole
# while still skipping genuine scaffolding.
PLACEHOLDER_PARENS_RE = re.compile(
    r"^\(\s*(record the.*|see rollout notes.*)\s*\)\.?$",
    re.IGNORECASE,
)

# Keyword -> canonical bucket, checked in order (first match wins). Mirrors
# scripts/sync-effort-issues.py's classify_heading exactly so the two tools
# never disagree about which bucket a section belongs to.
SECTION_KEYWORDS = [
    ("deployed", "deployed"),
    ("completed", "completed"),
    ("in progress", "in-progress"),
    ("planned", "planned"),
    ("reserved", "planned"),
]

BUCKET_TITLES = {
    "deployed": "Deployed",
    "completed": "Completed",
    "in-progress": "In Progress",
    "planned": "Planned / Reserved",
}


def classify_heading(heading_text: str) -> str | None:
    lowered = heading_text.strip().lower()
    for keyword, bucket in SECTION_KEYWORDS:
        if keyword in lowered:
            return bucket
    return None


def normalized_key_text(first_line: str) -> str:
    text = re.sub(r"[*_`]", "", first_line)
    text = re.sub(r"\s+", " ", text).strip().lower()
    return text


def item_key(first_line: str) -> str:
    return hashlib.sha1(normalized_key_text(first_line).encode("utf-8")).hexdigest()


@dataclass
class Item:
    key: str
    bucket: str
    first_line: str
    # Raw source lines for this item, bullet through its last continuation
    # line, WITHOUT trailing blank lines. Reproduced verbatim on output.
    raw_lines: list[str] = field(default_factory=list)


@dataclass
class ParsedBoard:
    lines: list[str]  # original file, split on "\n", no line terminators
    # key -> ALL occurrences in document order (not just the first). Two
    # distinct rows can legitimately normalize to the same key (e.g. two
    # agents independently wording a claim row identically) — collapsing to
    # "first occurrence wins" would make a genuine second row invisible to
    # both the recovery pass and the invariant check, silently dropping it
    # exactly like the original union-merge-clobber bug this tool exists to
    # prevent. See recover_missing_items / verify_invariant for how the list
    # is used: occurrences are compared by COUNT, not mere presence.
    items: dict[str, list[Item]]
    # For each bucket, the line index (into `lines`) one-past-the-end of the
    # LAST section in the document classified into that bucket, i.e. where a
    # new item should be inserted to land at the end of that bucket's most
    # recent occurrence. None if the bucket never appears.
    bucket_insert_at: dict[str, int]
    # Same as `bucket_insert_at`, but restricted to CANONICAL bucket sections —
    # those established by a directly-classified level-<=2 (`## `) heading, or
    # inherited from such a level-2 ancestor. Recovered top-level rows must land
    # in the canonical `## Planned / Reserved`-style section, NOT in a nested
    # keyword-bearing subsection (e.g. `### Action ... (Planned)` sitting under
    # an unclassified `## ...` parent) that merely happens to classify into the
    # same bucket -- otherwise a global Planned row is recovered under an
    # unrelated UI-backlog subsection, corrupting the board's state
    # organization while the count invariant still passes. recover_missing_items
    # prefers this map and falls back to `bucket_insert_at` only for buckets
    # that exist SOLELY as nested subsections (no canonical section at all).
    canonical_bucket_insert_at: dict[str, int]


def parse_board(text: str) -> ParsedBoard:
    lines = text.split("\n")
    items: dict[str, list[Item]] = {}
    bucket_insert_at: dict[str, int] = {}
    canonical_bucket_insert_at: dict[str, int] = {}

    current_bucket: str | None = None
    # Whether `current_bucket` was established by a CANONICAL section: a heading
    # directly classified at level <= 2, or one that inherited its bucket from
    # such a level-2 ancestor. Nested keyword-bearing subsections (level >= 3
    # under an unclassified parent) are NOT canonical -- see the
    # canonical_bucket_insert_at docstring on ParsedBoard.
    current_bucket_canonical = False
    # Effective bucket of each currently-open heading level. A subsection that
    # carries no bucket keyword of its own inherits the NEAREST CLASSIFIED
    # ANCESTOR at any shallower level -- not merely the last level-2 heading.
    # Example: `### Action ... (Planned)` under an UNCLASSIFIED `## ...` parent,
    # then a `#### Notes` child row: the `####` must inherit `planned` from its
    # `###` ancestor, NOT reset to the unclassified `##`'s None and silently
    # drop its rows (the exact silent-drop class this tool exists to prevent).
    # A new heading at level L invalidates every strictly-deeper open level.
    heading_bucket_by_level: dict[int, str | None] = {}
    # Parallel to heading_bucket_by_level: whether each open level's bucket
    # context is canonical (see current_bucket_canonical above). Follows the
    # SAME inheritance chain as the bucket, so an unclassified `###` under a
    # canonical `## Planned` counts as canonical, while an unclassified `####`
    # under a nested `### ... (Planned)` (itself under an unclassified `##`)
    # does not.
    heading_canonical_by_level: dict[int, bool] = {}
    current_item: Item | None = None
    current_item_start: int | None = None

    def flush_item(end_idx: int) -> None:
        nonlocal current_item, current_item_start
        if current_item is None:
            return
        block = lines[current_item_start:end_idx]
        # Trim trailing blank lines from the captured block; separators are
        # re-inserted on output rather than preserved per-item.
        while block and block[-1].strip() == "":
            block.pop()
        current_item.raw_lines = block
        # Every occurrence is recorded, in document order — see the ParsedBoard
        # docstring for why duplicates must not collapse to "first wins".
        items.setdefault(current_item.key, []).append(current_item)
        current_item = None
        current_item_start = None

    for idx, raw_line in enumerate(lines):
        heading_match = HEADING_RE.match(raw_line)
        if heading_match:
            flush_item(idx)
            level = len(heading_match.group(1))
            classified = classify_heading(heading_match.group(2))
            # A heading closes every strictly-deeper open level (their context
            # no longer applies once we've dedented back to `level`).
            for open_level in [lvl for lvl in heading_bucket_by_level if lvl >= level]:
                del heading_bucket_by_level[open_level]
                heading_canonical_by_level.pop(open_level, None)
            if classified is not None:
                # Keyword-bearing heading classifies itself outright. It is a
                # CANONICAL bucket section only if it sits at the top level
                # (`## `); a keyword-bearing `###`/deeper is a nested subsection.
                effective = classified
                effective_canonical = level <= 2
            else:
                # Unclassified heading inherits the nearest classified ancestor
                # (deepest remaining shallower level with a non-None bucket) --
                # including that ancestor's canonical-ness. A top-level `##` has
                # no shallower ancestor, so it resets to None -- preserving the
                # prior "unclassified `##` resets outright".
                effective: str | None = None
                effective_canonical = False
                for lvl in sorted(heading_bucket_by_level, reverse=True):
                    if heading_bucket_by_level[lvl] is not None:
                        effective = heading_bucket_by_level[lvl]
                        # Do NOT inherit the parent's canonical-ness — a subsection
                        # (level > 2) is never a canonical insertion point even if it
                        # inherits the same bucket value. Only directly classified
                        # level-2 headings establish a canonical section. Without this,
                        # every line inside an unclassified ###/#### subsection under a
                        # canonical ## section overwrites canonical_bucket_insert_at,
                        # and recovered top-level rows land under that subsection
                        # instead of the active bucket section. (PR #1354 review round
                        # 5 — the canonical-insertion-out-of-nested-sections fix.)
                        effective_canonical = False
                        break
            heading_bucket_by_level[level] = effective
            heading_canonical_by_level[level] = effective_canonical
            current_bucket = effective
            current_bucket_canonical = effective_canonical
            continue

        if current_bucket is None:
            continue

        # Every non-heading line seen while inside a classified section is a
        # candidate insertion point for "end of this bucket's last section"
        # — updated on every line so it always lands just before the next
        # heading (or EOF) once the loop finishes this section.
        bucket_insert_at[current_bucket] = idx + 1
        # Track the canonical insertion point separately so a later nested
        # keyword-bearing subsection can't hijack where recovered top-level
        # rows land (the line-251 corruption this guards against).
        if current_bucket_canonical:
            canonical_bucket_insert_at[current_bucket] = idx + 1

        bullet_match = BULLET_RE.match(raw_line)
        if bullet_match:
            flush_item(idx)
            content = bullet_match.group(1).strip()
            if PLACEHOLDER_RE.match(content) or PLACEHOLDER_PARENS_RE.match(content):
                continue
            current_item = Item(key=item_key(content), bucket=current_bucket, first_line=content)
            current_item_start = idx
            continue

        # Continuation line: folds into the in-flight item implicitly via
        # flush_item's slice; nothing to do here beyond having updated
        # bucket_insert_at above.

    flush_item(len(lines))

    return ParsedBoard(
        lines=lines,
        items=items,
        bucket_insert_at=bucket_insert_at,
        canonical_bucket_insert_at=canonical_bucket_insert_at,
    )


def recover_missing_items(mirror: ParsedBoard, live: ParsedBoard) -> tuple[list[str], list[tuple[str, str]]]:
    """Return (output_lines, recovered) where `recovered` is a list of
    (bucket, first_line) for every live-only item occurrence that got appended.

    Missing-ness is computed by COUNT per key, not mere presence: if a key
    has 2 occurrences on the live board and only 1 already in the mirror,
    exactly 1 is missing (the mirror-side occurrences are assumed, in
    document order, to correspond to the earliest live-side occurrences —
    the best available pairing without deeper content matching). Plain set
    membership would treat the key as "present" once ANY occurrence is
    mirrored and silently drop a genuine second row."""
    missing: list[Item] = []
    for key, live_occurrences in live.items.items():
        already_mirrored = len(mirror.items.get(key, []))
        if len(live_occurrences) > already_mirrored:
            missing.extend(live_occurrences[already_mirrored:])

    if not missing:
        return list(mirror.lines), []

    # Group missing items by bucket, preserving their original relative
    # order from the live board.
    by_bucket: dict[str, list[Item]] = {}
    for item in missing:
        by_bucket.setdefault(item.bucket, []).append(item)

    # Insert from the bottom of the document upward so earlier insertions
    # don't invalidate later insertion-point line indices.
    out_lines = list(mirror.lines)
    recovered: list[tuple[str, str]] = []

    insertions = []  # (insert_at, block_lines)
    trailer_sections: list[Item] = []  # buckets with no existing section in mirror

    for bucket, bucket_items in by_bucket.items():
        # Prefer the canonical (`## `-level) section for this bucket so a
        # recovered top-level row lands in the global bucket section rather
        # than a nested keyword-bearing subsection that merely classifies the
        # same way. Fall back to any insertion point only when the bucket
        # exists SOLELY as a nested subsection (no canonical section at all) --
        # that preserves the nested-recovery behavior for genuinely
        # subsection-only buckets.
        insert_at = mirror.canonical_bucket_insert_at.get(bucket)
        if insert_at is None:
            insert_at = mirror.bucket_insert_at.get(bucket)
        block: list[str] = []
        for item in bucket_items:
            block.append("")
            block.extend(item.raw_lines)
            recovered.append((bucket, item.first_line))
        # Preserve the document's blank-line-before-heading convention: if
        # what currently follows the insertion point is a non-blank line
        # (i.e. we're inserting directly above the next `## ` heading, with
        # no blank line in between), add one so the recovered block doesn't
        # fuse onto the following section header.
        if insert_at is not None and insert_at < len(mirror.lines) and mirror.lines[insert_at].strip() != "":
            block.append("")
        if insert_at is None:
            trailer_sections.append((bucket, block))
        else:
            insertions.append((insert_at, block))

    # Apply mid-document insertions in descending line-index order.
    for insert_at, block in sorted(insertions, key=lambda p: p[0], reverse=True):
        out_lines[insert_at:insert_at] = block

    # Append any buckets absent from the mirror entirely as new sections at
    # the end of the document.
    for bucket, block in trailer_sections:
        if out_lines and out_lines[-1].strip() != "":
            out_lines.append("")
        out_lines.append(f"## {BUCKET_TITLES.get(bucket, bucket)} (recovered by union-merge safety net)")
        out_lines.extend(block)

    return out_lines, recovered


def verify_invariant(live: ParsedBoard, output_text: str) -> list[tuple[str, int, int]]:
    """Return (key, live_count, output_count) for every key whose occurrence
    COUNT in `output_text` is less than the live board's — empty list ==
    invariant holds. Comparing counts (not just "key present at all") is
    what catches a duplicate live row being over-collapsed to a single
    recovered copy."""
    output_items = parse_board(output_text).items
    problems: list[tuple[str, int, int]] = []
    for key, live_occurrences in live.items.items():
        output_count = len(output_items.get(key, []))
        if output_count < len(live_occurrences):
            problems.append((key, len(live_occurrences), output_count))
    return problems


def write_atomic(path: str, text: str) -> None:
    """Write `text` to `path` without ever leaving a truncated/partial file on disk. Writes to a
    sibling temp file in the SAME directory (so the final rename stays on one filesystem), fsyncs
    it, then atomically replaces the target via os.replace. A crash, disk-full, or interruption
    mid-write leaves either the old complete file or the new complete file — never a half-written
    one, which a plain open(path, "w") would risk (it truncates the target before any new bytes
    are written)."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".effort-log-union-merge-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def describe_invariant_problems(problems: list[tuple[str, int, int]], live: ParsedBoard) -> str:
    lines = []
    for key, live_count, output_count in problems:
        missing_count = live_count - output_count
        first_line = live.items[key][0].first_line
        lines.append(f"  key={key} missing={missing_count} (live has {live_count}, output has "
                      f"{output_count})  first_line={first_line!r}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--live", required=True, help="Path to the live board (read; recovery source).")
    parser.add_argument("--mirror", required=True, help="Path to the repo mirror docs/EFFORT-LOG.md (read-only base).")
    parser.add_argument("--out", default=None, help="Where to write the merged result. Defaults to --live.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True, help="Report only; write nothing (default).")
    mode.add_argument("--apply", action="store_true", help="Write the merged result to --out.")
    args = parser.parse_args()

    apply = args.apply
    out_path = args.out or args.live

    # Hold an exclusive advisory lock on the live board for the ENTIRE read-merge-write critical
    # section (released when live_fd closes, including on early return). This serializes
    # concurrent invocations of this script against each other (the realistic "concurrent edit"
    # actor per the fleet-coordination investigation this tool followed up on -- no other code
    # currently writes the live board programmatically). flock is advisory, so it can't stop a
    # text editor's raw save; the fingerprint recheck right before the write (below) is the
    # second, non-cooperative-safe line of defense for that case.
    live_fd = os.open(args.live, os.O_RDONLY)
    try:
        fcntl.flock(live_fd, fcntl.LOCK_EX)
        with os.fdopen(os.dup(live_fd), "r", encoding="utf-8") as f:
            live_text = f.read()
        live_stat = os.fstat(live_fd)
        live_fingerprint = (live_stat.st_mtime_ns, live_stat.st_size)

        with open(args.mirror, "r", encoding="utf-8") as f:
            mirror_text = f.read()

        live = parse_board(live_text)
        mirror = parse_board(mirror_text)

        out_lines, recovered = recover_missing_items(mirror, live)
        output_text = "\n".join(out_lines)
        if not output_text.endswith("\n"):
            output_text += "\n"

        still_missing = verify_invariant(live, output_text)

        live_item_count = sum(len(v) for v in live.items.values())
        mirror_item_count = sum(len(v) for v in mirror.items.values())
        print(f"[union-merge] live items: {live_item_count}  mirror items: {mirror_item_count}")
        if recovered:
            print(f"[union-merge] {len(recovered)} live-only row(s) would be recovered into the output:")
            for bucket, first_line in recovered:
                preview = first_line if len(first_line) <= 100 else first_line[:97] + "..."
                print(f"  [{bucket}] {preview}")
        else:
            print("[union-merge] no live-only rows found -- mirror already a superset; output == mirror content.")

        if still_missing:
            print(f"[union-merge] INVARIANT VIOLATION: {len(still_missing)} live-only key(s) still missing from "
                  "computed output -- refusing to write.", file=sys.stderr)
            print(describe_invariant_problems(still_missing, live), file=sys.stderr)
            return 2

        if not apply:
            print(f"[union-merge] dry-run: would write {len(output_text.splitlines())} lines to {out_path} "
                  "(pass --apply to write).")
            return 0

        # Belt-and-suspenders: re-check the live board's mtime/size haven't changed since we read
        # it, even though we're still holding the flock above. The lock only binds OTHER callers
        # of this script; a manual editor save or any tool that doesn't flock would go undetected
        # by the lock alone but IS caught here, because the merge above was computed from a
        # snapshot that would now be stale.
        current_stat = os.stat(args.live)
        if (current_stat.st_mtime_ns, current_stat.st_size) != live_fingerprint:
            print(f"[union-merge] CONCURRENT EDIT DETECTED: {args.live} changed on disk since this "
                  "run read it -- refusing to write a merge computed against a stale snapshot. "
                  "Re-run.", file=sys.stderr)
            return 4

        write_atomic(out_path, output_text)

        # Re-verify against what actually landed on disk, not just the in-memory string, as a
        # final defense against any write-path surprise.
        with open(out_path, "r", encoding="utf-8") as f:
            written_text = f.read()
        post_write_missing = verify_invariant(live, written_text)
        if post_write_missing:
            print(f"[union-merge] POST-WRITE INVARIANT VIOLATION on {out_path} -- {len(post_write_missing)} "
                  "live-only key(s) missing after write. This should be impossible; investigate immediately.",
                  file=sys.stderr)
            return 3

        print(f"[union-merge] wrote {out_path} ({len(output_text.splitlines())} lines); "
              f"invariant verified post-write ({len(recovered)} row(s) recovered).")
        return 0
    finally:
        os.close(live_fd)  # releases the flock


if __name__ == "__main__":
    raise SystemExit(main())
