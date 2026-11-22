# ST-4659 console accessibility smalls (2026-11-22, Muse Code MC)

## Context & Objective
ST-4650 fleet-sweep web-UX batch (non-decision slice): every relative timestamp was a keyboard tab stop, timed toasts could not be paused, and two destructive confirmations still used the native dialog.  The bare-hotkey question stays an explicit owner decision and is untouched here.

## Changes Made
- `app/console/ui/primitives.tsx` + `app/console/lib/tooltip-trigger.ts`: `Tooltip` gains opt-in `focusable={false}` (no tabIndex/focus ring; default unchanged so Chip/Stat explanatory tooltips stay keyboard-reachable per #2561).  `Ago` uses it and carries the exact time as the `<time>` element's `aria-label`; hover tooltip kept.
- `app/console/ui/toast.tsx`: exported `createToastCountdown` — a pausable one-shot with idempotent pause/resume/cancel.  Timed toasts pause per source (pointer and focus tracked separately, resume only when both leave; blur is relatedTarget-guarded so tabbing to Dismiss keeps the hold).  Error toasts remain untimed-until-dismissed; dismiss cancels the timer.
- `app/console/settings/page.tsx`: sign-out-everywhere confirms in a themed Sheet (same copy intent, POST revoke-all then /login; failure closes the Sheet and toasts).
- `app/console/strategy/page.tsx`: preset delete confirms in a Sheet wired to the existing `removePreset`, busy/Deleting states preserved.
- `test/console-ux-smalls.test.ts`: static-markup Ago/Tooltip assertions, fake-timer countdown behavior, source guards for both Sheet migrations.

## Decisions & Trade-offs
- `focusable` defaults to true so only `Ago` changes behavior; the exact-time text remains available to assistive tech via the aria-label, which is the information the tooltip carried.
- Error toasts deliberately keep their never-auto-dismiss behavior — a failure must not vanish unread; pause machinery applies to timed kinds only.
- Known minor: a toast evicted by the existing slice(-3) cap keeps its countdown entry until it fires (bounded, no user-visible effect).

## Verification State
- Writer lane: console-ux-smalls + a11y + focus-trap + copy-rules 45 tests passed; all 37 console suites exit 0; tsc clean; eslint 0 errors.
- Parent on harvested tree: full `npm run lint` 0 errors (one new-test lint error found and fixed), `npx tsc --noEmit` clean, console suites 35 files / 443 tests passed, `npm run build` exit 0 (see PR body).  Playwright not run locally; CI visual suite + e2e are the browser gate (Sheet focus behavior rests on the existing useFocusTrap coverage).

## Next Steps & Blockers
- Owner decision still open on ST-4659: bare `R`/`A`/`1`-`6` hotkeys fire Run Once with no modifier.  E2E baseline expansion also stays open.

## Zero-Code Findings
- None.
