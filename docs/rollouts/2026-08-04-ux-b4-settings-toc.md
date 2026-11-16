# 2026-08-04 — UX PR-B4 Settings sticky TOC / jump chips (GROK)

## Context & Objective

Settings is a long single page (notifications → danger). The UX program
(`docs/design/ux-improvement-program.md` §PR-B4) called for sticky jump chips so
operators can reach Notifications / Display / Sharing / Danger (and the other
major cards) without hunting via full-page scroll. Acceptance: hash deep links
still work; no policy behavior changes.

## Changes Made

- Sticky horizontal jump-chip strip under the page title on
  `/console/settings`.
- Chips stick under the measured console topbar (`.con-topbar` ResizeObserver)
  so they remain reachable while scrolling; mobile uses `overflow-x-auto`
  (scrollbar hidden).
- Active chip tracks the section in view (`IntersectionObserver`) and the
  current URL hash after a chip click.
- Chip click updates `location.hash` via `history.replaceState` and smooth-
  scrolls to the section (shareable deep links).
- Added / normalized section anchor wrappers with `scroll-mt-36` so targets clear
  sticky chrome + the TOC bar.

### Touched files

- `app/console/settings/page.tsx` — `SETTINGS_TOC`, `SettingsToc`, section
  wrappers / ids
- `docs/rollouts/2026-08-04-ux-b4-settings-toc.md` — this note
- `docs/EFFORT-LOG.md` — PR-B4 row
- `STATUS.md` — snapshot

### Section list (chip → id)

| Chip label | Anchor id |
|---|---|
| Notifications | `#notifications` |
| Delivery | `#delivery` |
| Sharing | `#sharing` |
| Learning review | `#learning-review` |
| Scan shape | `#scan-shape` |
| FMP | `#fmp-features` |
| Confirmation | `#confirmation` |
| Boot | `#boot` |
| You | `#you` |
| Display | `#appearance` |
| Glossary | `#glossary` |
| Danger | `#danger` |

Preserved existing deep links: `#sharing`, `#learning-review`, `#confirmation`,
`#danger`. New anchors for the rest. Legacy `#brokers` / `#api-keys` still
redirect to `/console/connections`.

## Decisions & Trade-offs

- **Per-card anchors, not group chips only** — acceptance named Notifications /
  Display / Sharing / Danger; full card list matches how people hunt settings.
- **No policy / API changes** — pure UI navigation.
- **Measured topbar height** instead of a hard-coded sticky `top-*` so desktop
  chrome vs mobile freshness bar both work.
- **IntersectionObserver active state** is best-effort highlight; hash + click
  still work if the observer is unavailable.

## Verification State

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
./node_modules/.bin/eslint app/console/settings/page.tsx   # clean (0 errors)
npx tsc --noEmit   # deferred to CI verify: host load avg ~100+ SIGTERM'd local tsc
```

Local eslint on the touched file is clean. Full-project `tsc` was repeatedly
SIGTERM'd under host load (multi-agent blitz); CI `verify` is the type gate.

## Next Steps & Blockers

- Land via PR + auto-merge when `verify` is green.
- Optional follow-up: collapse very minor chips (You / Boot) if the row feels
  dense in production feedback.
- Peer keepout: do not re-implement Settings TOC on `grok/ux-wave-b-ia` if that
  branch also planned B4 — this PR is the exclusive B4 slice.
