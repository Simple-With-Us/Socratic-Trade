# 2026-07-22 — Dark mode near-black (de-blue) retint

## Summary

Dark mode backgrounds were too blue/navy: public pages used slate `#111827` plus
high-opacity teal/blue mesh orbs, and console used teal-tinted `#0b1114` /
`#1c2b31` surfaces. Sign-in (`/login`) sits the candle wordmark on that backdrop,
so the logo read poorly. Both renderers now use neutral near-black charcoal.

## Why

Owner feedback: dark mode not black enough and too blue; logo on sign-on pages
does not look good on the dark navy backdrop.

## Files

- `app/globals.css` — `.dark` tokens → `#0a0a0a` + neutral glass surfaces;
  dark mesh opacity 0.9/0.7 → 0.22/0.12
- `app/console/console.css` — both dark blocks (explicit + media) → neutral
  charcoal surfaces/lines/fg
- `app/console/layout.tsx` — dark `themeColor` → `#0a0a0a`
- `app/layout.tsx` — root `themeColor` → `#0a0a0a` (was `#080b12`)
- `app/global-error.tsx` — dependency-free dark fallback hex aligned
- `docs/design/visual-system.md` — contrast notes + near-black rule
- `STATUS.md`, `docs/EFFORT-LOG.md`, live board

## Token map (dark)

| Token | Before | After |
|-------|--------|-------|
| public `--bg` | `#111827` (slate) | `#0a0a0a` |
| console `--con-bg` | `#0b1114` (teal-navy) | `#0a0a0a` |
| console surfaces | `#11191d` / `#162127` / `#1c2b31` | `#141414` / `#1a1a1a` / `#242424` |
| dark mesh `::before` / `::after` opacity | 0.9 / 0.7 | 0.22 / 0.12 |

Accent (`--brand-accent-dark` teal), pos/neg/warn remain; only base/surface chroma
was stripped.

## Verification

```bash
# contrast (scripted): faint≥4.85, muted≥6.6 on public surface-3; con-faint 4.50 on #242424
npx tsc --noEmit
npm run lint
# full suite + build before land
```

## Follow-ups

- Spot-check `/login`, `/welcome`, `/console` in dark after deploy.
- If any panel still looks "blue," it is likely a one-off Tailwind `slate-*` /
  `gray-*` hardcode rather than the semantic tokens — fix in place.
