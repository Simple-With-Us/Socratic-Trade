# 2026-07-03 - Run-state UX: Start/Resume is not STOP

## Summary

- Changed the console header run-state control so paused states show a Start or
  Resume action instead of a red STOP button.
- Reordered the run-state sheet so Start/Resume comes first when the strategy is
  halted or close-only.
- Kept red styling reserved for STOP, Wind down/liquidation, and other genuinely
  destructive or halting actions.
- Changed the legacy dashboard "Enable autonomous execution" confirm from danger
  tone to primary tone.

## Why

The owner correctly flagged that requiring a click on STOP to reach Start options
is backwards, and that start/autonomy flows using red visually collapse into the
stopped/stopping/destructive semantics. The UI now maps color and action hierarchy
to intent: green/primary starts or resumes, red stops or winds down.

## Files

- `app/console/components/chrome.tsx`
- `app/console/components/shell.tsx`
- `app/console/console.css`
- `app/dashboard-client.tsx`
- `docs/settings-navigation-redesign/spec/01-global-frame.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-03-run-state-ux.md`

## Verification

- `npm run lint` — passed with 0 errors and 303 existing warnings.
- `npx tsc --noEmit` — passed.
- `npm test` — passed, 243 files / 2361 tests.
- `npm run build` — passed.
- `git diff --check` — passed.
- `pm2 restart trading-codex --update-env` — passed after build regenerated `.next`.
- Playwright desktop/mobile check against `http://localhost:4101/console` with the trusted local
  Cloudflare Access header — passed: stopped header renders `Start` with `con-start-btn`
  green styling, opens a sheet titled "Start the strategy", and lists "Start scheduled runs"
  before Close-only/Wind down.

## Follow-ups

- None expected for this slice. If the owner wants STOP to remain visible beside
  Resume in close-only state, add a compact secondary STOP icon; for now the
  primary header action favors the recovery path and the sheet still exposes STOP.
