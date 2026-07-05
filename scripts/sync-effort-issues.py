#!/usr/bin/env python3
"""
sync-effort-issues.py — one-way mirror of this repo's committed effort board
(`docs/EFFORT-LOG.md`) into GitHub Issues.

Boards remain the single source of truth. This script is READ-ONLY with
respect to the board: it parses `docs/EFFORT-LOG.md` at HEAD and reconciles
GitHub Issues to match it. Agents never write issues directly — only this
script (run by `.github/workflows/effort-issues-sync.yml`) does, so the
mirror can't drift from manual edits made outside the board.

Why the committed mirror and not the machine-local live board
(`/Users/jay/apps/<APP>-EFFORT-LOG.md`): this script runs in GitHub Actions,
which has no access to the operator's Mac filesystem. The committed mirror
updates at every landing (see AGENTS.md's Pre-Commit / Handoff Protocol),
which is the right cadence for owner-visibility notifications — an owner
watching GitHub Issues sees state as of the last merge, not machine-local
edits that haven't landed yet.

Parsing model
--------------
The board is markdown with a small number of top-level (`##`) sections whose
headings vary slightly across repos and over time (e.g. "Planned / Reserved
Before Implementation" vs "Planned / Reserved", with or without emoji). We
classify each section heading by keyword rather than exact match:

  - "planned" / "reserved"        -> bucket "planned"
  - "in progress"                 -> bucket "in-progress"
  - "completed"                   -> bucket "completed"
  - "deployed"                    -> bucket "deployed"
  - anything else (Deployed intro text, "Changelog", etc. that isn't one of
    the four state buckets) is ignored for issue purposes.

Within a recognized section, a top-level bullet (`- ` or `* ` at column 0,
optionally prefixed with an emoji) starts a new item. Any following lines
that are indented continuation text (not a new top-level bullet) are folded
into the same item's body. A bare "(none)" / "(n/a ...)" / "(seeded empty
...)" placeholder bullet is skipped — it documents an empty section, not a
real item.

Item identity
-------------
Each item gets a stable key derived from a SHA1 hash of its *normalized*
first line (bullet marker stripped, markdown emphasis markers stripped,
whitespace collapsed, lowercased). This key is embedded in the issue body as
an HTML comment marker:

    <!-- effort-key: <sha1 hex> -->

On every run we list existing open+closed issues, extract this marker from
each issue body, and match by key. This means an item's identity survives
the item moving between sections (e.g. Planned -> In Progress -> Completed)
as long as its first line doesn't change wording — which is the normal
lifecycle (state transitions in this codebase's protocol correct rows in
place rather than rewriting them). If the first line DOES change wording,
the old key becomes orphaned (see "Orphans" below) and a new issue is
created; this is an accepted tradeoff of a stateless, board-is-truth design.

Reconciliation
--------------
  - planned, in-progress   -> issue OPEN, label state:planned / state:in-progress
  - completed, deployed    -> issue CLOSED, label state:completed / state:deployed
  - Every mirrored issue always carries the `effort-board` label plus exactly
    one `state:*` label (old state:* labels are removed when the state
    changes).
  - Title = first ~80 chars of the item's first line (bold markers and the
    bullet stripped), truncated on a word boundary with "...".
  - Body = the item's full text (all folded lines) + a fixed footer that
    says this is a read-only mirror, plus a link to the board file at the
    commit that produced it.
  - Idempotent: if title/body/labels/state already match, no API call is
    made beyond the initial list. Existing issues are only updated when
    something actually changed.
  - Never deletes issues. An item that disappears from the board (row
    removed/merged into another) leaves its mirrored issue in place,
    untouched, with whatever state it last had — a human can close it
    manually if desired. This script does not guess intent for vanished
    rows.
  - Hand-made issues without the `effort-key` marker are ignored entirely
    (never edited, never closed, never relabeled).

Auth
----
Uses the GitHub Actions-provided `GITHUB_TOKEN` (env var, `issues: write`
permission) via the plain REST API (`api.github.com`), stdlib
`urllib.request` only — no GraphQL, no third-party dependencies. Repo is
read from `GITHUB_REPOSITORY` (e.g. "owner/repo"), which Actions sets
automatically; this makes the script identical across all three repos it
runs in.

Rate limiting
-------------
Bulk creation (e.g. ~100 issues the first time a repo's board is mirrored) can
trip GitHub's *secondary* rate limit: the API 403s with "secondary rate limit
... temporarily blocked from content creation". Three mitigations:

  - Every successful issue creation is followed by a small throttle sleep
    (CREATE_THROTTLE_SECONDS), and every successful update by a lighter one
    (UPDATE_THROTTLE_SECONDS), to stay under the content-creation rate.
  - On a rate-limit response (403/429 with a rate-limit/abuse message or a
    Retry-After header), the request is retried: we sleep Retry-After when the
    server sent one (honored as-is, never shortened), else exponential backoff.
    All retry sleeps draw from a single bounded per-run budget
    (RATE_LIMIT_RETRY_BUDGET_SECONDS). This covers every API call, including
    the initial issue listing.
  - If that budget runs out, the run stops early and exits 0 with an explicit
    "partial sync — resume on next run" summary instead of failing. The sync
    is idempotent and board-driven, so the next scheduled/triggered run picks
    up exactly where this one stopped; a red workflow run for an expected
    partial pass would be noise.

Local testing: export GITHUB_TOKEN and GITHUB_REPOSITORY yourself, then run
`python3 scripts/sync-effort-issues.py [--dry-run]`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

BOARD_PATH = "docs/EFFORT-LOG.md"
API_BASE = "https://api.github.com"

# Pause after every successful issue creation — bulk creation without pacing
# trips GitHub's secondary ("content creation") rate limit.
CREATE_THROTTLE_SECONDS = 2.5
# Lighter pause after every successful issue update: GitHub's guidance is >=1s
# between mutating requests, and a body-churn run can PATCH hundreds of issues.
UPDATE_THROTTLE_SECONDS = 1.0
# Total per-run budget for rate-limit retry sleeps. When it is exhausted the
# run ends as a PARTIAL sync (exit 0) and the next run resumes idempotently.
RATE_LIMIT_RETRY_BUDGET_SECONDS = 300.0
# Backoff for rate-limited requests when the server sends no Retry-After.
RATE_LIMIT_BACKOFF_BASE_SECONDS = 15.0
RATE_LIMIT_BACKOFF_MAX_SECONDS = 120.0

MIRROR_LABEL = "effort-board"
STATE_LABELS = {
    "planned": "state:planned",
    "in-progress": "state:in-progress",
    "completed": "state:completed",
    "deployed": "state:deployed",
}
OPEN_BUCKETS = {"planned", "in-progress"}
CLOSED_BUCKETS = {"completed", "deployed"}

LABEL_DEFS = {
    MIRROR_LABEL: ("5319e7", "Mirrored from the repo's effort board (docs/EFFORT-LOG.md) — read-only, do not edit here"),
    "state:planned": ("c5def5", "Effort board state: Planned / Reserved"),
    "state:in-progress": ("fbca04", "Effort board state: In Progress"),
    "state:completed": ("0e8a16", "Effort board state: Completed (merged to main)"),
    "state:deployed": ("0e8a16", "Effort board state: Deployed (released to production)"),
}

MARKER_RE = re.compile(r"<!--\s*effort-key:\s*([0-9a-f]{40})\s*-->")

# A top-level bullet: "- " or "* " at column 0, optionally preceded by a
# single leading emoji/space (we don't special-case emoji explicitly —
# stripping is handled by NORMALIZE below; the bullet regex itself only
# needs to recognize the literal markdown bullet markers).
BULLET_RE = re.compile(r"^[-*]\s+(.*)$")

# Section heading classification keywords, checked in this order.
SECTION_KEYWORDS = [
    ("deployed", "deployed"),
    ("completed", "completed"),
    ("in progress", "in-progress"),
    ("planned", "planned"),
    ("reserved", "planned"),
]

PLACEHOLDER_RE = re.compile(
    r"^\(?\s*(none|n/?a\b.*|seeded empty.*|add rows here.*|record the.*|see rollout notes.*)\s*\)?\.?$",
    re.IGNORECASE,
)


@dataclass
class BoardItem:
    bucket: str  # planned | in-progress | completed | deployed
    first_line: str
    body_lines: list[str] = field(default_factory=list)

    @property
    def full_text(self) -> str:
        return "\n".join([self.first_line, *self.body_lines]).strip()

    @property
    def normalized_key_text(self) -> str:
        # Strip bullet leftovers, markdown emphasis, collapse whitespace, lowercase.
        text = self.first_line
        text = re.sub(r"[*_`]", "", text)
        text = re.sub(r"\s+", " ", text).strip().lower()
        return text

    @property
    def key(self) -> str:
        return hashlib.sha1(self.normalized_key_text.encode("utf-8")).hexdigest()

    @property
    def title(self) -> str:
        text = re.sub(r"[*_`]", "", self.first_line).strip()
        text = re.sub(r"\s+", " ", text)
        max_len = 80
        if len(text) <= max_len:
            return text
        truncated = text[:max_len].rsplit(" ", 1)[0]
        return truncated + "..."


def classify_heading(heading_text: str) -> str | None:
    lowered = heading_text.strip().lower()
    for keyword, bucket in SECTION_KEYWORDS:
        if keyword in lowered:
            return bucket
    return None


def parse_board(text: str) -> list[BoardItem]:
    items: list[BoardItem] = []
    current_bucket: str | None = None
    current_item: BoardItem | None = None

    for raw_line in text.splitlines():
        heading_match = re.match(r"^##\s+(.*)$", raw_line)
        if heading_match:
            # New top-level section: flush any in-flight item, reclassify.
            if current_item is not None:
                items.append(current_item)
                current_item = None
            current_bucket = classify_heading(heading_match.group(1))
            continue

        if current_bucket is None:
            continue

        bullet_match = BULLET_RE.match(raw_line)
        if bullet_match:
            # New top-level bullet: flush previous item first.
            if current_item is not None:
                items.append(current_item)
                current_item = None
            content = bullet_match.group(1).strip()
            if PLACEHOLDER_RE.match(content):
                continue  # "(none)" etc. — not a real item.
            current_item = BoardItem(bucket=current_bucket, first_line=content)
            continue

        if current_item is not None:
            stripped = raw_line.strip()
            if stripped == "":
                # Blank line: tolerate as a soft continuation break, but a
                # subsequent non-bullet indented line still folds in below.
                continue
            if raw_line.startswith((" ", "\t")):
                current_item.body_lines.append(stripped)
            # Non-indented, non-bullet, non-blank lines under a bucket
            # (stray prose) are ignored rather than folded in, to avoid
            # accidentally slurping unrelated paragraphs.

    if current_item is not None:
        items.append(current_item)

    return items


def http_request(
    method: str, url: str, token: str, body: dict | None = None
) -> tuple[int, dict | list, dict[str, str]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {}), dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"message": raw.decode("utf-8", errors="replace")}
        return e.code, parsed, dict(e.headers or {})


class RateLimitBudgetExhausted(Exception):
    """Raised when the per-run rate-limit retry budget can't cover the next wait."""


def _rate_limited(status: int, payload: dict | list, headers: dict[str, str]) -> bool:
    if status not in (403, 429):
        return False
    message = str(payload.get("message", "")).lower() if isinstance(payload, dict) else ""
    return (
        "rate limit" in message
        or "abuse" in message
        or "temporarily blocked" in message
        or _retry_after_seconds(headers) is not None
    )


def _retry_after_seconds(headers: dict[str, str]) -> float | None:
    for name, value in headers.items():
        if name.lower() == "retry-after":
            try:
                return max(0.0, float(value))
            except ValueError:
                return None
    return None


class GitHubClient:
    def __init__(self, repo: str, token: str, dry_run: bool = False):
        self.repo = repo
        self.token = token
        self.dry_run = dry_run
        self.retry_budget_remaining = RATE_LIMIT_RETRY_BUDGET_SECONDS

    def _request(self, method: str, url: str, body: dict | None = None) -> tuple[int, dict | list]:
        """http_request + secondary-rate-limit retries against a bounded per-run budget."""
        attempt = 0
        while True:
            status, payload, headers = http_request(method, url, self.token, body)
            if not _rate_limited(status, payload, headers):
                return status, payload
            attempt += 1
            wait = _retry_after_seconds(headers)
            if wait is None:
                # Cap only our own guess — a server-sent Retry-After is honored
                # as-is (retrying sooner would just re-trip the limit and burn
                # budget; if it exceeds the remaining budget we go partial now).
                wait = min(
                    RATE_LIMIT_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)),
                    RATE_LIMIT_BACKOFF_MAX_SECONDS,
                )
            if wait > self.retry_budget_remaining:
                raise RateLimitBudgetExhausted(
                    f"rate limited on {method} {url} and the next wait ({wait:.0f}s) exceeds the "
                    f"remaining retry budget ({self.retry_budget_remaining:.0f}s of "
                    f"{RATE_LIMIT_RETRY_BUDGET_SECONDS:.0f}s)"
                )
            self.retry_budget_remaining -= wait
            print(
                f"rate limited ({status}) on {method} {url} — sleeping {wait:.0f}s "
                f"(retry budget left: {self.retry_budget_remaining:.0f}s)"
            )
            time.sleep(wait)

    def _get_all_pages(self, path: str, params: str = "") -> list[dict]:
        results: list[dict] = []
        page = 1
        while True:
            sep = "&" if params else ""
            url = f"{API_BASE}/repos/{self.repo}/{path}?per_page=100&page={page}{sep}{params}"
            status, payload = self._request("GET", url)
            if status >= 300:
                raise RuntimeError(f"GET {path} failed: {status} {payload}")
            if not payload:
                break
            results.extend(payload)
            if len(payload) < 100:
                break
            page += 1
        return results

    def list_labels(self) -> set[str]:
        labels = self._get_all_pages("labels")
        return {l["name"] for l in labels}

    def create_label(self, name: str, color: str, description: str) -> None:
        if self.dry_run:
            print(f"[dry-run] would create label {name!r}")
            return
        status, payload = self._request(
            "POST",
            f"{API_BASE}/repos/{self.repo}/labels",
            {"name": name, "color": color, "description": description},
        )
        if status >= 300 and status != 422:  # 422 = already exists (race), fine.
            raise RuntimeError(f"create label {name} failed: {status} {payload}")

    def list_all_issues(self) -> list[dict]:
        # state=all to see both open and closed mirrored issues.
        return self._get_all_pages("issues", params="state=all")

    def create_issue(self, title: str, body: str, labels: list[str], assignee: str | None) -> dict:
        if self.dry_run:
            print(f"[dry-run] would create issue: {title!r} labels={labels}")
            return {"number": -1, "title": title, "body": body, "labels": [{"name": l} for l in labels], "state": "open"}
        payload: dict = {"title": title, "body": body, "labels": labels}
        if assignee:
            payload["assignees"] = [assignee]
        status, resp = self._request("POST", f"{API_BASE}/repos/{self.repo}/issues", payload)
        if status >= 300:
            raise RuntimeError(f"create issue failed: {status} {resp}")
        # Pace content creation so a bulk run (fresh repo, ~100 issues) stays
        # under GitHub's secondary rate limit instead of tripping it.
        time.sleep(CREATE_THROTTLE_SECONDS)
        return resp

    def update_issue(self, number: int, fields: dict) -> None:
        if self.dry_run:
            print(f"[dry-run] would update issue #{number}: {fields}")
            return
        status, resp = self._request("PATCH", f"{API_BASE}/repos/{self.repo}/issues/{number}", fields)
        if status >= 300:
            raise RuntimeError(f"update issue #{number} failed: {status} {resp}")
        time.sleep(UPDATE_THROTTLE_SECONDS)


def build_body(item: BoardItem, repo: str, ref: str) -> str:
    link = f"https://github.com/{repo}/blob/{ref}/{BOARD_PATH}"
    lines = [
        item.full_text,
        "",
        "---",
        "",
        "**MIRROR — read-only.** Edit the effort board (`docs/EFFORT-LOG.md` / the live "
        "board), not this issue. This issue is reconciled automatically from the board and "
        "manual edits here will be overwritten or ignored.",
        "",
        f"Source: [{BOARD_PATH}]({link})",
        "",
        f"<!-- effort-key: {item.key} -->",
    ]
    return "\n".join(lines)


def desired_labels(bucket: str) -> list[str]:
    return sorted({MIRROR_LABEL, STATE_LABELS[bucket]})


def issue_marker_key(issue: dict) -> str | None:
    body = issue.get("body") or ""
    m = MARKER_RE.search(body)
    return m.group(1) if m else None


def issue_label_names(issue: dict) -> set[str]:
    return {l["name"] for l in issue.get("labels", [])}


def reconcile(items: list[BoardItem], client: GitHubClient, repo: str, ref: str, assignee: str | None) -> dict:
    stats = {"created": 0, "updated": 0, "unchanged": 0, "reopened": 0, "closed": 0, "partial": None}

    by_key: dict[str, dict] = {}
    seen_keys: set[str] = set()
    try:
        # The initial issue listing is inside the partial handling too: budget
        # exhaustion while paging GET /issues must also end as a partial sync,
        # not an exception that turns the workflow red.
        for issue in client.list_all_issues():
            key = issue_marker_key(issue)
            if key:
                by_key[key] = issue
        _reconcile_items(items, client, repo, ref, assignee, by_key, seen_keys, stats)
    except RateLimitBudgetExhausted as e:
        stats["partial"] = str(e)
        # Skip the orphan report: items not yet processed this run would look
        # like orphans and produce a misleading note.
        return stats

    orphaned = [k for k in by_key if k not in seen_keys]
    if orphaned:
        print(f"note: {len(orphaned)} previously-mirrored issue(s) no longer match a board row "
              f"(row removed/reworded) — left untouched: "
              f"{', '.join('#' + str(by_key[k]['number']) for k in orphaned)}")

    return stats


def _reconcile_items(
    items: list[BoardItem],
    client: GitHubClient,
    repo: str,
    ref: str,
    assignee: str | None,
    by_key: dict[str, dict],
    seen_keys: set[str],
    stats: dict,
) -> None:
    for item in items:
        key = item.key
        if key in seen_keys:
            # The board itself has two top-level bullets with the same
            # normalized first line (a genuine duplicate row, not a parser
            # artifact). Reconcile against whichever issue the first
            # occurrence created/matched instead of creating a second
            # identical issue — otherwise duplicate rows would multiply
            # mirrored issues by re-running.
            print(f"note: duplicate board item (same key {key[:8]}) — skipping extra occurrence: {item.title}")
            continue
        seen_keys.add(key)
        title = item.title
        body = build_body(item, repo, ref)
        labels = desired_labels(item.bucket)
        desired_state = "open" if item.bucket in OPEN_BUCKETS else "closed"

        existing = by_key.get(key)
        if existing is None:
            created = client.create_issue(title, body, labels, assignee)
            print(f"created issue #{created.get('number')} [{item.bucket}]: {title}")
            stats["created"] += 1
            if desired_state == "closed" and created.get("number", -1) != -1:
                client.update_issue(created["number"], {"state": "closed"})
            continue

        number = existing["number"]
        fields: dict = {}
        if existing.get("title") != title:
            fields["title"] = title
        if (existing.get("body") or "") != body:
            fields["body"] = body
        current_labels = issue_label_names(existing)
        target_labels = set(labels)
        # Preserve any non-effort-board/non-state labels a human may have added.
        preserved = {l for l in current_labels if l != MIRROR_LABEL and not l.startswith("state:")}
        if current_labels & {MIRROR_LABEL} | {l for l in current_labels if l.startswith("state:")} != target_labels:
            fields["labels"] = sorted(target_labels | preserved)
        if existing.get("state") != desired_state:
            fields["state"] = desired_state
            if desired_state == "open":
                stats["reopened"] += 1
            else:
                stats["closed"] += 1

        if fields:
            client.update_issue(number, fields)
            print(f"updated issue #{number} [{item.bucket}]: {title} ({', '.join(fields.keys())})")
            stats["updated"] += 1
        else:
            stats["unchanged"] += 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Print actions without calling the write API.")
    parser.add_argument("--board", default=BOARD_PATH, help="Path to the effort board markdown file.")
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token:
        print("error: GITHUB_TOKEN is not set", file=sys.stderr)
        return 1
    if not repo:
        print("error: GITHUB_REPOSITORY is not set", file=sys.stderr)
        return 1

    ref = os.environ.get("GITHUB_SHA", "main")
    assignee = os.environ.get("EFFORT_ISSUES_ASSIGNEE", "jaywedgeworth22")

    try:
        with open(args.board, encoding="utf-8") as f:
            board_text = f.read()
    except FileNotFoundError:
        print(f"error: board file not found at {args.board}", file=sys.stderr)
        return 1

    items = parse_board(board_text)
    print(f"parsed {len(items)} board item(s) from {args.board}")

    client = GitHubClient(repo, token, dry_run=args.dry_run)

    try:
        existing_labels = client.list_labels()
        for name, (color, description) in LABEL_DEFS.items():
            if name not in existing_labels:
                print(f"creating missing label: {name}")
                client.create_label(name, color, description)
    except RateLimitBudgetExhausted as e:
        print(f"PARTIAL SYNC — rate-limit retry budget exhausted during label setup: {e}")
        print("The sync is idempotent and board-driven; the next run resumes where this one "
              "stopped. Exiting 0 — an expected partial pass is not a failure.")
        return 0

    stats = reconcile(items, client, repo, ref, assignee)
    summary = (
        f"created={stats['created']} updated={stats['updated']} "
        f"unchanged={stats['unchanged']} reopened={stats['reopened']} closed={stats['closed']}"
    )
    if stats["partial"]:
        print(f"PARTIAL SYNC — rate-limit retry budget exhausted: {stats['partial']}")
        print(f"partial progress this run: {summary}")
        print("The sync is idempotent and board-driven; the next run resumes where this one "
              "stopped. Exiting 0 — an expected partial pass is not a failure.")
        return 0

    print(f"done: {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
