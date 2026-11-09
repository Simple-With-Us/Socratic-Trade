# 2026-07-24 — Resolve open efforts + stale issue mirrors (CURSOR)

## Summary

Continued the open-effort / open-issue sweep with a working `GITHUB_MCP_TOKEN`:
drained ~79 stuck Sentry CI Report spam runs that were starving `socratic-ci`,
kept the four open product PRs (#1902/#1792/#1819/#1842) auto-merge-armed on
current heads, restored `check-pin` as a required ruleset check, and performed
large effort-board hygiene so `effort-issues-sync` can close hundreds of stale
`state:in-progress` GitHub Issue mirrors.

## Why

Owner asked to resolve as many in-progress effort-log rows and GitHub issues as
possible. Prior cloud sessions could not use the Issues API (`GITHUB_TOKEN` 401);
`GITHUB_MCP_TOKEN` unlocks Issues + rulesets. Most "In Progress" board rows were
already merged work still parked under the wrong section (including duplicate
`## In Progress` merges), so their mirrored issues stayed open forever.

## What changed

1. **CI queue drain:** cancelled queued `Sentry CI Report` spam on `main` plus
   duplicate older workflow runs for the four open PR branches (kept newest head).
2. **Ruleset restore:** `main-protection` required checks are now `verify` +
   `check-pin` (`strict` still false). Precondition met via #1771 (check-pin on
   every `pull_request`).
3. **Board hygiene:** moved ~200 already-merged/superseded rows out of In Progress
   into Completed (deduped across duplicate sections). Genuine WIP left:
   unstick claim, abandoned Usage-compliance Wave 2 (no open PR), infra-panel
   reliability (local/unpushed).
4. **Docs:** this rollout + STATUS/PLAN/EFFORT-LOG updates.

## Files

- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`
- `docs/rollouts/2026-07-24-resolve-open-efforts.md`

Ops (not in git): GitHub ruleset `main-protection` PUT; Actions run cancellations.

## Verification

- `gh pr list --state open` → only #1902/#1792/#1819/#1842 (MERGEABLE, auto-merge on)
- Ruleset required contexts → `verify`, `check-pin`
- Queued Actions dropped ~89 → ~15 after spam cancel
- Local: `python3 scripts/sync-effort-issues.py --dry-run` then live sync (closes
  mirrors for rows moved to Completed)
- Docs-only PR uses CI docs-only fast path for `verify`

## Follow-ups

- Babysit hosted `verify` on #1902/#1792/#1819/#1842 until auto-merge lands
- Usage-compliance Wave 2 / infra-panel reliability still need an owner call
  (land, abandon, or re-claim)
- RAG feature enablement remains Planned (re-embed proof first)
- Optional: restore `gitleaks` as required (left off; only verify+check-pin now)

## Update — merge receipts (same session)

- #1842 MERGED 2026-07-24T01:35:26Z
- #1792 MERGED 2026-07-24T01:36:50Z
- #1902 / #1819 / #2022: re-merged `origin/main` after dirty; #1819 real conflict resolved
  (`document_abstracts` v56 + earningscalls v57/v58); persistence-hardening 23/23 green
- Effort sync live: `created=117 updated=321 closed=86`; open `state:in-progress` issues = 3

## Update — merge=union repair

Squash-merge of #2022 onto `main` combined both In Progress histories because
`docs/EFFORT-LOG.md` uses `merge=union`. Follow-up PR
`cursor/effort-board-union-repair-14e5` collapses the board again before the
next effort-issues-sync run.

## Update — orphan closeout + union-repair PR

- Opened **#2143** (`cursor/effort-board-union-repair-14e5`) to restore a single clean
  In Progress section after #2022's `merge=union` clobber; auto-merge armed.
- Pinned the same clean `docs/EFFORT-LOG.md` onto product PR heads **#1902** and
  **#1819** so their merges cannot re-union stale In Progress rows.
- Enhanced `scripts/sync-effort-issues.py`: open orphan mirrors (effort-key no longer
  on the board) are now closed as `state:completed` instead of left forever-open.
  Dry-run against the repair board: ~118 open orphans would close; ~28 matched rows
  move to completed; genuine open `state:in-progress` should drop to the 3 board WIP
  rows once the live sync runs.
- Cancelled dirty-main `Effort Issues Sync` runs so they cannot reopen stale mirrors
  before #2143 lands.
- #2123 (cleanup-caches on ubuntu-latest) still in `verify-hosted` (npm test).

## Update — product PRs landed; issues at board-true WIP

- **MERGED:** #1902 (Busy retry + OpenRouter filter), #1819 (earningscalls), #2123
  (cleanup-caches on ubuntu-latest).
- Open `state:in-progress` issues: **3 → 2** after moving the completed unstick row
  out of In Progress (Usage-compliance Wave 2 + infra-panel reliability).
- Live sync with orphan-closeout: `created=0 updated=279 unchanged=178 closed=38`
  (plus earlier partial runs that closed the bulk of the ~149 stale IP mirrors).
- Still open: #2143 (board + orphan-closeout script), #2155 (admin RAM / cache follow-up;
  EFFORT-LOG pinned to clean content).
