# design-sync notes — Socratic Trade

This repo is the **Socratic Trade Next.js app**, not a published component library.
The synced "design system" is the two hand-built primitive sets:

- `app/ui/primitives.tsx` — the public/marketing renderer's primitive layer (group **UI**).
  Slimmed 2026-07-16 to its real app consumers: `Card`, `Button`, `buttonClass`. Everything
  else that used to live here (`IconButton`, `PanelHeader`, `Chip`, `Dot`, `Switch`,
  `Segmented`, `Tabs`, `Field`, `StatTile`, `EmptyState`, `inputClass`, `ICON`) was consumer-free
  dead code and was deleted; see
  `docs/rollouts/2026-07-16-public-renderer-decision-legacy-primitives-slim.md`. A design-sync
  re-sync of the "Socratic Trade UI Kit" project to drop the removed cards is a pending
  follow-up — not done as part of this slim-down.
- `app/console/ui/primitives.tsx` — the `/console` UI kit (group **Console**). Its own
  design system, deliberately independent of `app/ui/*`. Untouched by the 2026-07-16 slim-down.

## How the sync is wired (why the odd bits exist)

- **No `dist/`, no shipped `.d.ts`** → converter runs in **synth-entry mode**. The
  component list is discovered from `.design-sync/ds-src/{ui,console}-primitives.tsx`,
  two committed re-export files that name exactly the components we sync (`cfg.srcDir`
  points at `.design-sync/ds-src`). Props are extracted from each component's call
  signature (inline param types); add `cfg.dtsPropsFor.<Name>` only where extraction is wrong.
- **Name collisions**: `Card`, `Chip`, `Dot`, `Field` exist in BOTH sets. The console
  re-export file renames them (and all console exports) to **`Con*`** so the shared
  `window.SocraticTradeDS` namespace and the on-disk `components/<group>/<Name>` tree
  stay unique. Real import names in the app are unprefixed — the `Con` prefix is a
  sync-only disambiguation (noted in each card's docs).
- **Grouping**: there are no per-component docs, so `cfg.docsMap` points every name at a
  frontmatter-only stub (`.design-sync/groups/{ui,console}.md`) whose `category:` sets the
  group label. This docsMap is intentionally an enumeration (the normal "exceptions only"
  rule doesn't apply — it's the only grouping signal we have).

## Styling model (two token systems, one compiled sheet)

- `app/ui/*` uses **Tailwind utility classes** over `globals.css` `@theme` semantic tokens
  (`bg-accent`, `text-fg`, `border-line`, …). Dark mode = a `.dark` ancestor class.
- `app/console/*` uses **bespoke `con-*` classes** defined in `app/console/console.css`
  (`.con-card`, `.con-btn-*`, `.con-chip-*`) PLUS Tailwind layout utilities, all scoped
  under **`.console-root`**. Dark = `.console-root[data-theme="dark"]` (or `prefers-color-scheme`).
- `cfg.cssEntry` = `.ds-sync/compiled.css`, produced by the Tailwind v4 CLI from the
  committed input `.design-sync/tailwind-input.css` (imports `globals.css` + `console.css`,
  `@source`s the two primitive files). **Regenerate it before every build:**
  ```sh
  .ds-sync/node_modules/.bin/tailwindcss -i .design-sync/tailwind-input.css -o .ds-sync/compiled.css
  ```

## Fonts

- The app declares `"Inter"` / `"JetBrains Mono"` but ships NO `@font-face` (relies on
  OS copy or the fallback stack). design-sync ships the real self-hosted **latin** woff2
  (`.design-sync/fonts/` + `.design-sync/fonts.css`, wired via `cfg.extraFonts`) so designs
  render in the intended type. Weights: Inter 400/500/600/700, JetBrains Mono 400/500.
  This is a deliberate, self-contained (no remote/CDN) resolution of `[FONT_MISSING]`.

## Preview authoring conventions (confirmed by solo calibration)

- Import from the package name: `import { Button, ConChip } from "socratic-trade-dashboard"`
  (rewritten to `window.SocraticTradeDS` at compile).
- **UI** components render at the document root (light theme) — no wrapper needed.
- **Console** components MUST be wrapped: `<div className="console-root"> … </div>`.
- Use realistic trading content (orders, P/L, theses), never foo/test. 2–6 exports each.
- Solo-verified good: Button, StatTile (UI), ConBtn (Console). Wiring/tokens/fonts all work.

## Preview authoring rules (IMPORTANT)

- **Console previews MUST wrap content in `<div className="console-root">`** or nothing is
  styled (all `con-*` classes and `--con-*` tokens are scoped there). UI previews render at
  the document root (light theme); add a `.dark` wrapper only to show the dark variant.
- No React context/providers are required (`cfg.provider` unset) — the console wrapper is a
  plain DOM class, applied per-preview in the authored `.tsx`.

## Multi-account upload (two Claude accounts, one folder)

This one folder pushes the SAME built bundle to TWO separate claude.ai accounts (owner has
both; no team/org, so claude.ai/design sharing isn't available between them):

- **Primary (config-pinned)** — `projectId` in `config.json`: `0a962679-49e6-4f41-9718-596be2392525`.
- **Second account** — project `1da8546c-c496-479f-9f7f-4a37ba769f82` ("Socratic Trade UI Kit").
  NOT in `config.json` (it pins only one). The `resync.mjs` anchor diff also tracks one project.

**To re-sync BOTH accounts** after a rebuild: run the normal re-sync for the primary (its
`_ds_sync.json` anchor is fetched from the pinned project), then to update the second account,
`/design-login` into it and re-upload the same `ds-bundle/` to `1da8546c-...` (finalize_plan +
write_files, same sequence as the primary). Only one account is writable per `/design-login` at a
time — do the accounts serially. Both got the identical bundle on 2026-07-05.

## Capture-harness gotchas (folded from preview-authoring waves)

- **`package-capture.mjs` needs the `chromium-headless-shell` Playwright build**, not just
  `chromium`. If capture fails with `Executable doesn't exist … chromium_headless_shell-*`,
  run `npx playwright install chromium-headless-shell` (machine cache, one-time).
- **The capture clock is frozen at `2024-05-15T12:00:00Z`.** Any preview using time
  (`ConAgo`, or anything reading `Date.now()`) must use ISO timestamps BEFORE that instant or
  it renders "in Nd" nonsense. Use e.g. `2024-05-15T11:52:00Z` (8m ago).
- **Console preview flex trap**: `alignItems:"center"` on a single-row (`flexDirection:"row"`,
  the default) `.console-root` wrapper vertically-centers content in the tall capture frame and
  reads as "broken/empty". Use `alignItems:"flex-start"` (not bare removal → `stretch`), or nest
  the centered row inside a `flexDirection:"column"` outer wrapper.

## Bundle helper exports

- `.design-sync/ds-src/index.tsx` also re-exports the non-component helper `buttonClass` from
  `app/ui/primitives.tsx` (it's on `window.SocraticTradeDS` but is NOT a component —
  `componentSrcMap` defines the component set, so it doesn't get a card). `buttonClass` is the
  shared button-look class string for composing DS-styled non-`<button>` elements (e.g. an `<a>`
  styled as a button).
- `inputClass` and `ICON` were also re-exported here until 2026-07-16, when both were deleted
  from `app/ui/primitives.tsx` as consumer-free dead code (see "How the sync is wired" above).

## Re-sync risks (what can silently go stale)

- **A console `Tooltip` primitive is incoming** (Codex branch `codex/console-tooltip-primitive`
  added it to `app/console/ui/primitives.tsx`, not yet on main as of 2026-07-05). When it lands,
  the next re-sync should add it: re-export it (as `ConTooltip`) in `ds-src/index.tsx`, add a
  `componentSrcMap` + `docsMap` + `dtsPropsFor` entry, and author its preview.

- **`cssEntry` is a gitignored build artifact** (`.ds-sync/compiled.css`). A fresh clone or
  a re-sync that re-stages `.ds-sync/` has NO compiled.css until the Tailwind command above
  is re-run. Always recompile before `package-build.mjs`/`resync.mjs`.
- **The compiled sheet tracks `globals.css` + `console.css`.** If those token files change,
  recompile so the bundle CSS matches the app.
- **The `Con*` rename lives in `console-primitives.tsx`.** If a console primitive is renamed
  or a new one added in `app/console/ui/primitives.tsx`, update that re-export file and the
  `docsMap`.
