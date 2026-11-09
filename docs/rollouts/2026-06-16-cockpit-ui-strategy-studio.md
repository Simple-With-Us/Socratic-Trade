# 2026-06-16 - cockpit-ui-strategy-studio

## Summary

- Reworked the dashboard into a desktop single-screen cockpit with top command
  bar, left rail, center workspace tabs, right inspector tabs, and bottom drawer
  tabs.
- Added Strategy Studio as both a workspace tab and command-bar modal.
- Added `POST /api/strategy/tune` for LLM-assisted strategy tuning proposals.
- Replaced ambiguous sentiment arrows with explicit sentiment chips.
- Added focused tests for the strategy tuning local fallback and LLM payload
  sanitization path.
- Changed Strategy Studio slider controls to draft locally and commit on
  release/blur/Enter so dragging does not spam policy writes.

## Why

- The prior dashboard stacked every control and table vertically, which made the
  UI difficult to operate from one computer screen.
- The strategy prompt and tuning controls needed a dedicated review surface
  where the LLM can propose changes after reading performance and market
  context, while still requiring manual approval before mutation.

## Files

- `app/dashboard-client.tsx`
- `app/styles.css`
- `app/api/strategy/tune/route.ts`
- `src/lib/strategy-tuning.ts`
- `src/lib/types.ts`
- `test/strategy-tuning.test.ts`
- `docs/phase-8-cockpit-ui.md`
- `STATUS.md`
- `PLAN.md`

## Verification

- `npx tsc --noEmit`
- `npx vitest run test/strategy-tuning.test.ts`
- `npm test`
- `npm run build`
- Browser desktop check at `http://localhost:3000`: verified fixed cockpit
  shell, tab switching, Strategy Studio modal, tuning proposal rendering, and no
  page-level desktop scroll.
- Browser mobile-width check: verified responsive single-column layout and
  normal page-level scrolling.

## Follow-ups

- Add a persisted strategy-tuning history table if the review trail becomes
  important for audits.

## Blockers

- First `npm run build` after the dev-server browser check hit a transient
  stale `.next` `PageNotFoundError` for `/api/policy` and `/api/orders`; rerun
  passed without code changes.
