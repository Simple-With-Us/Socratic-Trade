# 2026-07-08 — Alert Center filter pills (fix clipped tile headings) (MONET)

## Summary

Owner reported (with screenshot) that the Alert Center's four filter tiles clipped their
headings — "DELIVERIE…", "APPROVAL…" — and asked for a modest redesign. Root cause: the
filter block was a fixed `sm:grid-cols-4` grid of stat tiles whose headings use
`con-card-title` (uppercase + 0.09em letter-spacing); in the rails/widths the card actually
lives in, a quarter-column cannot fit "DELIVERIES" at that tracking, so the text clipped.

Replaced the tile grid with a wrapping pill row (console chip idiom):

- Sentence-case labels ("Deliveries 6") — removes the uppercase-tracking width blowup
  entirely; counts render inline in `con-num`.
- `flex flex-wrap` — pills reflow to any container width (verified: one row at 641px, clean
  two-row wrap at 309px, zero clipping at either).
- Selected state = accent border + tint + **bold weight** and **`aria-pressed`** — this
  closes the catalogued UI-audit finding "[P1][A11y][S] AlertCenter filter buttons signal
  state by color only → add aria-pressed" (55-findings backlog).
- Per-pill `title` hover hints explaining what each filter covers (matches the console's
  hover-explanation idiom).
- `[@media(pointer:coarse)]:min-h-11` touch-target floor on the pills (the global 44px
  console floor remains a separate catalogued item).

## Why

Owner request 2026-07-08 (screenshot of clipped headings). Also resolves one 55-findings
backlog row in passing (aria-pressed) — annotated on the board.

## Files

- `app/console/components/alert-center.tsx`
- `docs/EFFORT-LOG.md` (55-findings row annotated done; new row), `STATUS.md`

## Verification

- `npx tsc --noEmit` clean; `npm run lint` 0 errors; full `npm test` + `npm run build` green
  via `scripts/land.sh` at landing.
- Driven live on a seeded dev DB (10 notification events): pills measured via DOM at 641px
  (single 31px row, `clipped: false` on all four) and at 375px viewport / 309px container
  (two-row wrap, no clipping); `aria-pressed` toggles correctly; mobile screenshot captured.

## Follow-ups

- The console-wide 44px coarse-pointer floor for `.con-btn` + compact chrome stays open
  (55-findings backlog row).
