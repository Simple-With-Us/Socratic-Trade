# Phone touch viewport cluster (`phone-touch-viewport`)

## Context & Objective

Expert review Part II cluster `phone-touch-viewport` (15 findings: mweb-01/05/07/08/09/10/12/13/16/18/19/21, a11y-13).  At 360–390px the chrome bar over-budgeted run-state text and sub-44px controls squeezed the account scope selector.  Overlays ignored visual viewport height, did not lock background scroll, and did not participate in browser history.

## Changes Made

- Added `app/console/ui/use-overlay.ts` — ref-counted body scroll-lock, `visualViewport` CSS vars (`--con-vv-height`, `--con-vv-offset-top`), and history `pushState` / `popstate` dismissal (opt-out for non-dismissible consent gate).
- `app/console/console.css` — expanded coarse-pointer 44px floor to all console interactive classes; 16px input floor includes command palette search; icon-only run-state label below `sm`; overlay/dvh/visualViewport sizing; overscroll containment on sheets and palette.
- `app/console/components/chrome.tsx` — run-state button icon-only on phones; `con-bar-ctl` on scope/state/avatar triggers.
- Wired `useOverlay` into `sheet.tsx`, `symbol-drawer.tsx`, `command-palette.tsx`, `nav.tsx` (TabsSheet), `consent-gate.tsx` (scroll-lock only).
- `app/console/layout.tsx` — `interactiveWidget: "resizes-content"` for Android keyboard resize.
- `app/console/ui/toast.tsx`, `app/console/scan/scan-table.tsx` — 44px dismiss/watch targets.
- `test/console-use-overlay.test.ts` — `syncVisualViewport` unit tests.

## Decisions & Trade-offs

- Consent gate uses scroll-lock without history entry (non-dismissible; back must not fake-close it).
- Did not take on `phone-layout-density` (type scale) or `visual-tokens-theme-contrast` (#2795).
- Scope selector keeps flex width on phones; only run-state label hides below `sm`.

## Verification State

```bash
npm run lint
npx tsc --noEmit
npm test -- test/console-use-overlay.test.ts
npm run build
```

All pass clean.

## Next Steps & Blockers

- Manual phone-width check at 360px/390px in browser devtools (account label readable, overlays dismiss with back gesture).
- Remaining cluster siblings (mweb-06 tab-bar offsets, mweb-09 typed-confirm keyboard) may need follow-up if visualViewport alone is insufficient on iOS Safari.

## Zero-Code Findings

None.
