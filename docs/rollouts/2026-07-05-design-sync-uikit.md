# 2026-07-05 — Design-sync: Socratic Trade UI Kit → claude.ai/design

## Summary
Synced the app's two primitive design systems to **claude.ai/design** so Claude's design
agent builds with the real components. 30 components uploaded (12 `ui` + 18 `console`),
each with an importable bundle, accurate `.d.ts` prop contract, per-component preview card
(realistic trading content), and a conventions header. Render check 30/30 clean.

Uploaded to **two** claude.ai accounts (owner has both; no team account, so cross-account
sharing isn't available):
- Primary (config-pinned): project `0a962679-49e6-4f41-9718-596be2392525`
- Second account: project `1da8546c-c496-479f-9f7f-4a37ba769f82` (recorded in NOTES only)

## Why
`/design-sync` skill. The app is not a component library, so this required a custom
converter setup (see Files). Components: `app/ui/primitives.tsx` (UI kit) and
`app/console/ui/primitives.tsx` (console kit, renamed `Con*` to avoid Card/Chip/Dot/Field
name collisions in the shared bundle namespace).

## Files (all additive, isolated to `.design-sync/` + one `.gitignore` block)
- `.design-sync/config.json` — converter config (synth-entry, `componentSrcMap`, hand-written
  `dtsPropsFor` for all 30 since the app ships no `.d.ts`, `docsMap` group stubs, `cssEntry`,
  `extraFonts`, `overrides`, `readmeHeader`, pinned `projectId`).
- `.design-sync/ds-src/index.tsx` — barrel entry re-exporting both primitive sets.
- `.design-sync/previews/*.tsx` — 30 hand-authored preview compositions.
- `.design-sync/conventions.md` — design-agent guidance (`.console-root` wrapper, token vocab).
- `.design-sync/tailwind-input.css` — Tailwind v4 compile input (utilities + both token layers).
- `.design-sync/fonts/` + `fonts.css` — self-hosted Inter/JetBrains Mono latin woff2.
- `.design-sync/groups/{ui,console}.md` — frontmatter group stubs.
- `.design-sync/NOTES.md` — repo-specific gotchas + re-sync risks + multi-account instructions.
- `.gitignore` — ignore regenerable design-sync artifacts (`.ds-sync/`, `ds-bundle/`,
  `.design-sync/.cache|learnings|node_modules`); durable inputs stay tracked.

No app source changed — `app/*/ui/primitives.tsx` were read-only inputs. STATUS.md/PLAN.md
intentionally untouched (this is an export artifact, not an app behavior/scope change).

## Verification
- `package-build.mjs` + `package-validate.mjs`: render check **30/30 clean, 0 bad/thin/floor**.
- All 30 preview components graded `good` on the absolute rubric (contact sheets reviewed).
- Driver (`resync.mjs`) verdict: 30 added, `pendingGrade: 0`, `learningsUnmerged: []`.
- Both uploads verified via `list_files` (167 paths each: 165 content + sentinel + anchor).

## Follow-ups / risks
- Re-sync recompiles the Tailwind CSS (`.ds-sync/compiled.css`) — see NOTES "Re-sync risks".
- A console `Tooltip` primitive is incoming (Codex `codex/console-tooltip-primitive`); next
  re-sync should add it (`ConTooltip`).
- Second account is a manual copy — re-syncs must push to it separately (see NOTES).
- Committed from an isolated worktree off `origin/main` because the primary worktree was in
  active use by a concurrent Cursor session.
