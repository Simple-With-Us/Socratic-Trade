# 2026-06-20 — Cursor Cloud dev environment setup

## Summary

Set up and verified the development environment for this repo inside the Cursor
Cloud agent VM. No application/source code changed — only documentation
(`AGENTS.md` cloud section, `STATUS.md`, this note) plus environment provisioning
(`npm install`, `.env.local` from `.env.example`).

## Why

A fresh Cloud VM needs dependencies installed and the run/test/build flow
validated so future agents can start services without rediscovering setup. The
existing "Hosting & dev servers" section in `AGENTS.md` describes the user's
local multi-worktree/PM2 host setup, which does not apply to the single
`/workspace` Cloud checkout; a Cloud-specific section was added to clarify this.

## Files

- `AGENTS.md` — added `## Cursor Cloud specific instructions` (also surfaces via
  the `CLAUDE.md` symlink).
- `STATUS.md` — added a dated env-setup entry.
- `docs/rollouts/2026-06-20-cursor-cloud-env-setup.md` — this note.

## Verification (commands actually run)

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` — 38 files, 283 tests passed.
- `npm run build` — Next.js production build succeeded.
- `npm run dev` — dev server up on `http://127.0.0.1:3000`; `/api/health` → 200,
  `/api/policy` and `/api/dashboard` → 200.
- Hello-world: loaded the dashboard in a browser (Test mode), opened Settings,
  added `NVDA` + `TSLA` to the Additional Watchlist, saw "Policy updated"
  toasts, and confirmed persistence in `data/app.db`.

## Notes / Follow-ups

- `next lint` is not configured (no committed eslint config; it prompts
  interactively), so it is not part of verification — use tsc/test/build.
- App runs with no secrets in Test mode; `OPENAI_API_KEY` is only needed for the
  LLM proposal loop. `DATABASE_URL` defaults to `file:./data/app.db`, so
  `.env.local` is optional.
