# 2026-07-08 — Production release: main@4af98aaa via Coolify deploy rjskkyzx (MONET)

## Summary

Owner-directed in-session ("help all deployed work or completed work get to
production"): triggered a Coolify deploy of `socratic-trade-prod` (uuid
`m1os7ijf31bg3fanil152e4b`), bringing `socratictrade.com` exactly current with
`main` at `4af98aaa`. Production had been at `ea779bbf` (deploy `n1v296`,
earlier the same day); this release ships the two commits merged since:

- **PR #1095** — inline-Bear bare-array recovery (`parseBearSurvivors` in
  `strategy.ts`): a bare-array or missing-`proposals` Bear reply can no longer
  read as a silent full veto; malformed → `fallbackToBull`. Closes the gap
  PR #1091 left in the inline path.
- **PR #1097** — troubleshoot-sweep docs close-out (boards, rollout addendum,
  gitleaks fixture defused).

After this release, every effort merged to `main` is in production.

## Why

Owner asked to get all completed (merged) work to production. Per the standing
release process (prod-coolify-migration, 2026-07-07), a production release =
deliberately triggering a Coolify deploy of `socratic-trade-prod`; auto-deploy
stays OFF.

## Mechanics / verification

- Pre-checks: app `running:healthy`, no running/queued deployments (box builds
  serialize, `concurrent_builds=1`); deploy announced on #ag***-s**c first.
- Trigger: `POST /api/v1/deploy?uuid=m1os7ijf31bg3fanil152e4b` → deployment
  `rjskkyzxfhg698gmu9b0x0yb`; polled to `finished`.
- Verified: deployment record commit = `4af98aaa` (== `origin/main` HEAD), app
  `running:healthy`, edge `https://socratictrade.com` → 307 → `/login` 200.
- Coolify API token read from the operator's Claude Desktop config
  (`COOLIFY_ACCESS_TOKEN`), used in-shell only, never printed.

## OWNER NOTE re-surfaced (from PR #1036, now live in production)

`ALLOW_LIVE_TRADING` is an opt-OUT escape hatch as of #1036: **the Robinhood
live account trades on its environment unless `ALLOW_LIVE_TRADING=false` is set
in Infisical.** The flag is not in the Coolify app envs (only Infisical
bootstrap keys live there), so it could not be confirmed from this session —
owner should confirm the Infisical value matches their intent.

## Files

Docs only (the release itself changed no code):
- `docs/EFFORT-LOG.md` — release stanza + #1095/#1097 row added to Deployed;
  intro row (#1089) moved In Progress → Deployed; #1036 row corrected in place
  (said IN PROGRESS, actually merged 2026-07-07 and now deployed).
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (live board, untracked) — same
  updates.
- `STATUS.md` — release entry.
- This note.

## Follow-ups

- Owner: confirm `ALLOW_LIVE_TRADING` in Infisical matches intent (see above).
- Open-PR triage (not part of this release, all unmerged): #1083 appears to
  duplicate the already-landed #1082 ruling; #1038 docs superseded by the prod
  migration; #856 documents retired preview lanes; #873/#989/#1008 stale
  auto-merge PRs; #1035 WIP. Worth a cleanup pass.
