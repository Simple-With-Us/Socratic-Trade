# 2026-07-18 — EFFORT-LOG board flip: #1727 → Deployed (MONET)

## Summary

Board-hygiene follow-up to PR #1727 (editable connected-account name + legacy-app
retirement, merged to `main` as `b0063a7`). Moves the effort's `docs/EFFORT-LOG.md`
row out of `## In Progress` and into `## Deployed`, records the production
deploy-verification, and corrects an earlier chronology overstatement about #1737.
Docs-only; no code changes.

## Why

- After #1727 merged, its board row still read "IMPLEMENTATION COMPLETE / gate
  running / PR pending" under `## In Progress`, so other agents scanning the live
  coordination board saw a finished+deployed lane advertised as active work.
- The fleet-wide auto-deploy stall (which had wedged production for several hours)
  recovered on 2026-07-18: prod redeployed ~13:32Z from a `main` state that already
  included `b0063a7` (which landed ~01:45Z, ~12h earlier), so #1727 is live —
  `/api/health` reports db ok, scheduler ticking, litestream replicating.
- Chronology correction (Codex-flagged): the 13:32Z build PRE-dates #1737's 14:14Z
  merge, so it does NOT include #1737 or later work. The row now asserts only that
  #1727 is live, not #1737.
- Reporting-quirk note: production's reported release sha `e3ea2e3d` is a Coolify
  build-sha emitted by the new self-hosted CI runner (#1739), not a `main` commit —
  not a main/prod mismatch.

## Files

- `docs/EFFORT-LOG.md` — row relocated `## In Progress` → `## Deployed`; "Board-mover"
  hand-off note dropped; chronology corrected; duplicate re-added by a `main` merge
  removed (single Deployed row).
- `docs/rollouts/2026-07-18-effort-log-1727-deploy-flip.md` — this note.
- `STATUS.md` — snapshot entry recording #1727 deployed + board corrected.

The #1727 implementation itself is documented in
`docs/rollouts/2026-07-18-account-rename-and-legacy-retirement.md`; this note covers
only the board-state + deploy-verification follow-up.

## Verification

```bash
git log --format='%ae %ce' origin/main..HEAD
curl -fsS https://socratictrade.com/api/health
```

- `git log --format='%ae %ce' origin/main..HEAD` confirmed every commit on the
  branch used the required noreply author/committer
  (`12656028+jaywedgeworth22@users.noreply.github.com`).
- `curl -fsS https://socratictrade.com/api/health` was the production-health
  command used at deploy-verify time (`db`, `scheduler`, and `litestream` all
  healthy in the recorded release note); the build post-dates `b0063a7`.
- Docs-only diff — the `verify` CI gate runs on the docs fast path.

## Follow-ups

- None for #1727 (shipped + live). Add-account auto-fetch of the Alpaca/Tradier
  account number remains a separately-flagged follow-up (noted in the #1727 rollout).
