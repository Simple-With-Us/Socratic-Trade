# 2026-06-27 - cursor-cloud-dev-env

## Summary

- Set up and verified the development environment on a fresh Cursor Cloud VM.
- Added a durable AGENTS.md note: open the dev server via `http://localhost:3000`
  (not `127.0.0.1`) to avoid Next 16's cross-origin HMR block.
- No application code changed (only `STATUS.md`, `AGENTS.md`, and this note).

## Why

- A new Cursor Cloud agent VM needs dependencies installed and the standard
  tsc/test/build/dev flow validated before any work.
- Browsing `http://127.0.0.1:3000` triggers Next 16's "Blocked cross-origin
  request to Next.js dev resource /_next/webpack-hmr" message, breaking HMR.
  Using `localhost` avoids it with no `allowedDevOrigins` code change, so the
  fix belongs in docs, not source.

## Files

- `STATUS.md`
- `AGENTS.md`
- `docs/rollouts/2026-06-27-cursor-cloud-dev-env.md`

## Verification

- `npm install` — 811 packages, clean.
- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — 150 files, 1444 tests passing.
- `npm run build` — clean (exit 0).
- `npm run dev` — Ready on port 3000.
- `GET http://127.0.0.1:3000/api/ready` — `{"ok":true,...,"broker":"test"}`.
- `GET http://127.0.0.1:3000/api/scan` — 501 live S&P 500 quotes
  (`source: nasdaq-delayed-screener+yahoo-finance+finra+congress`), no keys.
- Browser (via `http://localhost:3000`): dashboard renders in Test mode
  (~$10k simulated portfolio) and Market Scan tab populates with live data.

## Follow-ups

- None. LLM-driven proposal generation still requires `OPENAI_API_KEY`
  (unchanged); all non-LLM features run keyless in Test mode.

## Blockers

- None.
