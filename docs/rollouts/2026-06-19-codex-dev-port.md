# 2026-06-19 - Codex dev port isolation

## Summary
Added a Codex-specific dev-server launcher that pins local Next dev to
`127.0.0.1:3001`. The launcher frees only port `3001`, starts `next dev` with
that explicit port, and restarts if Next initially falls back to a different
local port.

## Why
Multiple coding agents can work this repo at once, and their preview servers
collide when they all default to `localhost:3000`. Claude keeps port `3000`,
Codex now has a dedicated `npm run dev:codex` command for port `3001`, and the
shared `npm run dev` command remains unpinned for other workflows.

## Files
- `package.json` - add `dev:codex`.
- `scripts/codex-dev-server.mjs` - Codex-only port cleanup and Next dev launcher.
- `README.md` - document the Codex port and stale-dev-server recovery wording.
- `STATUS.md` - record the current handoff state.
- `docs/rollouts/2026-06-19-codex-dev-port.md` - this rollout note.

## Verification
- `node --check scripts/codex-dev-server.mjs` - passed.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 28 files / 210 tests.
- `npm run build` - passed.
- `npm run dev:codex` - started Next on `http://127.0.0.1:3001`.
- `curl -I http://127.0.0.1:3001/` - returned `HTTP/1.1 200 OK`.

## Follow-ups
- None.
