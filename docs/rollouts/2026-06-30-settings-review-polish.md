# 2026-06-30 - Settings review-action polish

## Summary

- Moved LLM Strategy Review controls out of header/corner action placement in the Strategy tab and Strategy Studio.
- Reframed the review trigger as a left-aligned advisory panel so it does not read like a settings OK, Save, or submit action.
- Shared the strategy-review model picker between both review surfaces and included current provider/model families plus a current-custom fallback option.
- Tightened Settings scope header and account-selector spacing/alignment.
- Converted the `Resume strategy on server restart` row from a silent full-label click target into an explicit whole-row switch with hover, active, and keyboard-focus affordance.

## Why

The review strategy button visually sat where users expect a modal or settings submit action. That was misleading because running a strategy review only generates an advisory tuning proposal; the app does not mutate prompt, policy, risk, or scoring weights until the explicit reviewed-change apply flow.

The auto-resume setting also used the whole row as a click target without enough visual feedback. Keeping the larger target is useful in the Settings modal, but the control now behaves and renders as a single switch row so the clickable area is visible.

## Files

- `app/dashboard-client.tsx`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-30-settings-review-polish.md`

## Verification

- `bash scripts/npm-ci-with-shared-deps.sh` - passed in the fresh worktree; npm reported 2 moderate audit findings and allow-scripts warnings for install-script packages.
- `npm run lint` - passed with 0 errors and the existing 256-warning backlog.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 160 files / 1555 tests.
- `npm run build` - passed. Next emitted the existing middleware-to-proxy deprecation warning.

## Follow-ups

- Consider a broader Settings visual pass after the current multi-branch settings work has fully landed, especially around dense Risk/Tuning sections.
