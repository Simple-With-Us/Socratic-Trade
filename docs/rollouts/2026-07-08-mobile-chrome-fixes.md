# 2026-07-08 — Mobile chrome bar fixes: scope width, run-state chip, profile menu, avatar, STOP (MONET)

## Summary

Six owner-reported issues from production phone screenshots, all in the console
header chrome:

1. **Account scope wider on phones** — the trigger is now `flex-1` below `sm`
   (it absorbs the bar's slack; the desktop spacer is hidden there), instead of
   being capped at 44vw.
2. **Run-state indicator no longer looks like a second dropdown** — below `sm`
   the chip renders unboxed (no border/fill) with the state stacked above the
   authority in smaller type ("Running" over "Autopilot"); desktop keeps the
   boxed single-line chip.
3. **Profile button is a real touch target** — 44px below `sm` (32px desktop),
   and it now shows the **Google/GitHub avatar** when the session has one
   (`snapshot.currentUser.imageUrl` was already wired from the Auth.js session
   but never rendered; `referrerPolicy="no-referrer"` because googleusercontent
   403s with a referrer). Generic icon fallback otherwise.
4. **Theme toggle moved off the bar into the profile menu** — a "Theme" row
   with the mode label (System/Dark/Light) that cycles on tap. One less bar
   control on every viewport.
5. **Profile menu is a slide-DOWN dropdown** anchored under the bar — the old
   bottom Sheet was covered by the fixed mobile tab bar, making Sign out
   unreachable on phones. The panel anchors to the bar row (not the small
   button — that overflowed the left viewport edge on phones, caught during
   verification), width `min(92vw, 340px)`, click-away backdrop + Escape,
   160ms slide-down (disabled under reduced motion).
6. **STOP button squeeze fixed** — `.con-stop-btn`/`.con-start-btn` get
   `flex-shrink: 0` and `justify-content: center`; in the crowded phone bar the
   button was being flex-squeezed and its start-aligned content read as "STOP
   shoved right with a missing symbol" (owner report).

## Files

- `app/console/components/chrome.tsx` — ScopeSelector trigger width, StateChip
  mobile variant, UserMenu rewrite (dropdown + avatar + theme row), `Avatar`
  helper, THEME_LABEL/THEME_WORD moved here.
- `app/console/components/shell.tsx` — ThemeToggle removed from the bar (the
  component and its lucide imports deleted); theme/cycle now flow into
  UserMenu; bar row is `relative` (dropdown anchor); desktop spacer hidden
  below `sm`.
- `app/console/console.css` — stop/start button centering + shrink guard;
  `con-menu-drop` keyframes (+ reduced-motion off).
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board), this note.

## Verification

- `npm run lint` 0 errors; `npx tsc --noEmit` clean; `npm test` 3101 passed
  (301 files); `npm run build` OK.
- Live dev-server at 375×812: bar shows wide scope / unboxed chip / 44px
  profile / centered Start; profile menu slides down fully on-screen with
  identity, Theme row, and a reachable Sign out; theme cycled
  dark→light→system from the menu with `data-theme` + localStorage verified
  each step; click-away backdrop closes it. At 1280×800: desktop bar unchanged
  except the theme button now lives in the menu; dropdown right-anchored under
  the bar; dark theme rendering confirmed.
- Not exercised: the stacked two-line chip with a live "Running · Autopilot"
  state (dev DB is stopped; the split renders one line for single-word labels,
  verified) and a real provider avatar (no imageUrl in the dev session; prod
  sessions carry one).

## Follow-ups

- If the owner wants Run once / the command palette reachable on phones, that's
  nav-lane territory (the mobile-nav-drawer-fixes lane reserved nav.tsx).
