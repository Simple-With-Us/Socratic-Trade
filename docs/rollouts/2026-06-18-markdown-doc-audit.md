# 2026-06-18 - markdown-doc-audit

## Summary

Read and analyzed every repo-authored Markdown file outside dependency/generated
directories (`node_modules`, `.git`, `.next`). This included root docs, phase docs,
rollout notes, `CLAUDE.md` (a symlink to `AGENTS.md`), and ignored iCloud conflict
copies named like `" 2.md"`.

## Why

The project is being touched by Codex, Claude Code, Antigravity/Gemini, and
potentially Cursor. Current docs need to be internally consistent so the next tool
does not waste tokens following stale handoff paths or stale phase-plan status.

## Findings

- `CLAUDE.md` intentionally symlinks to `AGENTS.md`; keep durable multi-agent rules
  single-sourced there.
- Ignored iCloud conflict Markdown files are not repo source. Most are exact
  duplicates; `docs/phase-10-signals-learning-ui-v2 2.md` is stale and should not be
  read as current state.
- `README.md` still referenced the deleted `docs/HANDOFF.md` and an old test count.
- `docs/phase-10-signals-learning-ui-v2.md` lagged later June 18 rollouts for
  market-wide connectors, RAG, macro metrics, and symbol drilldown status.
- `docs/phase-9-web-sources.md` still pointed implementers at `CLAUDE.md` instead
  of `AGENTS.md`, and its follow-ups did not reflect SEC 8-K/sector progress.
- `docs/phase-1-autonomy-loop.md` and `docs/phase-8-cockpit-ui.md` mixed historical
  implementation specs with current guidance; both now call that out explicitly.

## Files

- `README.md` - handoff path, setup, environment variables, and current test-count guidance.
- `STATUS.md` - current documentation audit snapshot.
- `PLAN.md` - Phase 10 status refreshed.
- `docs/phase-1-autonomy-loop.md` - historical/current framing.
- `docs/phase-4-market-data-scoring.md` - positioning and technical overlay status.
- `docs/phase-7-strategy.md` - stale four-pillar/deferral language refreshed.
- `docs/phase-8-cockpit-ui.md` - current styling convention clarified.
- `docs/phase-9-web-sources.md` - add-a-field checklist and follow-ups refreshed.
- `docs/phase-10-signals-learning-ui-v2.md` - shipped/remaining Phase 10 status refreshed.
- Historical rollout notes - removed stray `</content>` / `</invoke>` artifact tags
  where they were accidental transcript leftovers, not useful historical content.
- `docs/rollouts/2026-06-18-markdown-doc-audit.md` - this rollout note.

## Verification

- `npx tsc --noEmit` passed.
- `npm test` passed: 26 files, 188 tests.
- `npm run build` passed: 11 app pages generated.

## Follow-ups

- Do not use ignored `" 2.md"` iCloud conflict files as source of truth. They can be
  removed manually later if desired, but this audit did not delete them.
- `.env.example` was updated in the continuation hardening pass.
- Historical rollout notes were mostly left intact even when superseded; treat them as
  chronological evidence, not current source-of-truth specs.
