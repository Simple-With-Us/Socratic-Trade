# 2026-06-16 - github-publish-and-dev-ui-recovery

## Summary

- Pushed the current project state to GitHub on `codex/upload-current-state`.
- Opened draft PR #2 against `main`.
- Recovered the local dashboard UI after the running Next dev server served
  stale `.next` assets and returned `404` for the CSS bundle.
- Updated project docs so other tools can start from `AGENTS.md`, `STATUS.md`,
  `PLAN.md`, `docs/HANDOFF.md`, and this rollout trail.

## Why

- The user wants the project state available in the cloud repo and documented
  well enough for Codex, Claude Code, Antigravity/Gemini, Cursor, and humans to
  resume work without relying on chat history.
- The dashboard appeared visually broken because the HTML loaded while
  `/_next/static/css/app/layout.css` was missing from the stale dev-server
  artifact set.

## Files

- `.gitignore`
- `AGENTS.md`
- `README.md`
- `PLAN.md`
- `STATUS.md`
- `docs/rollouts/2026-06-16-github-publish-and-dev-ui-recovery.md`

## Verification

- `npx tsc --noEmit`
- `npm test`
- `npm run build`
- Browser checked `http://127.0.0.1:3000` after restarting the dev server.
- CSS bundle check: `/_next/static/css/app/layout.css` returned `200` after restart.

## Follow-ups

- Keep `.git_diff.txt` local only; it is a temporary patch artifact and is now
  ignored.
- Before merging PR #2, review whether `test/scratch.ts` should remain as a
  committed manual smoke script or move to a documented npm script.
- Keep Live short/cover disabled until broker support, persistence, and
  accounting behavior are proven end to end.
