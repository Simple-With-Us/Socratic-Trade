# 2026-07-09 — Delete dead preview-server infra files

## Summary

Removed the four now-dead preview-server infrastructure files (previews were retired
2026-07-08, owner decision) and updated the docs/comments that referenced them:

Deleted:
- `.github/workflows/sync-previews.yml` — self-hosted CI that ran on every push to `main` and
  called `sync-preview-lanes.sh`.
- `scripts/sync-preview-lanes.sh` — the preview-lane sync (called only by the workflow + watchdog).
- `scripts/sync-watchdog.sh` — PM2 polling fallback that also just called `sync-preview-lanes.sh`.
- `scripts/setup-agent-previews.sh` — provisioned the per-agent PM2 `next dev` preview lanes.

## Why

Previews are fully retired (no per-agent PM2 lanes, no `*.jays.services` preview hostnames — see
`docs/rollouts/2026-07-08-previews-retired.md`), so all four files were dead code. The only reason
`setup-agent-previews.sh` couldn't be deleted earlier was that it also installed the pre-push hook
(`git config core.hooksPath scripts/githooks`). That job is now owned by **`scripts/land.sh`**, which
self-heals `core.hooksPath` per-worktree on every run (land.sh §1b) — so the script's last live
purpose was already redundant.

## Files

- Deleted: the 4 files above.
- Updated (reference cleanup, no behavior change):
  - `README.md` — replaced the PM2-preview bootstrap section with a "previews retired → `npm run dev`" note.
  - `AGENTS.md` — pre-push hook is now documented as installed by `land.sh`; noted the 4 scripts were deleted.
  - `docs/deployment.md` — "Preview lane sync" section marked RETIRED.
  - `scripts/githooks/pre-push`, `scripts/land.sh` — comments now point to `land.sh` as the hook installer.

Intentionally left intact: historical `docs/rollouts/*preview*.md`, `docs/EFFORT-LOG.md`, `STATUS.md`,
`PLAN.md`, `docs/reviews/*` mentions — those are the chronological paper trail, not live wiring.

## Verification

- `git grep` for `setup-agent-previews|sync-preview-lanes|sync-watchdog|sync-previews.yml` across
  live (non-historical) files → clean after the comment fixes. No `package.json` script, other
  workflow, or `cloud-setup.sh` referenced any of them.
- `land.sh` gate (tsc / test / build) as the merge gate.

## Follow-ups

- On the deployment Mac, any lingering `pm2` process named `trading-sync-watchdog` (or the old
  per-agent preview lanes) can be `pm2 delete`d — the previews-retired rollout already covers that;
  this PR only removes the source files.
