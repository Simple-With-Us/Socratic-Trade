# 2026-10-15 - Header dropdowns clipped by the header scroll container (ST-4544)

## Context & Objective

Owner report (Safari): clicking the account dropdown in the console header did not open any dropdown window.  The per-user Data Source Proxy feature the owner pasted alongside already exists (`app/console/settings/proxy.tsx`, `src/lib/proxy-fetch.ts`, `src/lib/data-source-fetch.ts`) and is not involved.  Linear ST-4544.

Root cause: the ChromeBar row in `app/console/components/shell.tsx` is `overflow-x: auto` (a 320px-width guard).  Per CSS, a non-visible overflow on one axis computes the other to `auto`, so the row clips its absolutely positioned dropdown panels to the bar's ~46px height.  Menu state opened; the panel was painted under the clip and hit-testing at its center landed on the click-away backdrop.  Reproduced with a WebKit + Chromium harness mirroring the header markup (state `open`, panel rect extending below the bar, center hit = backdrop, only a sliver visible).  All three header menus anchored inside that row were affected — not Safari-specific; Safari is the owner's browser.

## Changes Made

- `app/console/ui/use-anchored-menu.ts` — new shared hook: measures the trigger rect and returns `position: fixed` panel coordinates clamped to the viewport (recomputed on resize/scroll while open), plus `anchoredMenuContainer()` resolving the portal target to the trigger's `.console-root` so the `--con-*` theme variables stay in scope (a `<body>` portal renders the panel without surface/text colors — the same trap ToastProvider documents in shell.tsx).
- `app/console/components/chrome.tsx` — `ScopeSelector` (account scope) and `UserMenu` (profile/account menu) panels now render through that portal with fixed anchoring instead of `absolute` inside the bar.
- `app/console/components/notification-inbox.tsx` — Notifications panel, same treatment.
- `test/e2e/header-menus.spec.ts` — regression tests in the existing Playwright harness: each menu's panel must be visible AND hit-testable at its center (a clipped panel passes `toBeVisible` on its layout box, so visibility alone is not asserted).
- `STATUS.md` — session entry.

The `overflow-x: auto` 320px guard itself is unchanged; the panels escape it instead.

Review round (bot findings, all verified real and fixed): focus now moves into each panel on open via `useMenuInitialFocus` (the portal changed DOM tab order; close already returned focus to the trigger); the first measurement is synchronous in the effect so the click-away backdrop never exists without its panel; scroll/resize re-positioning is rAF-throttled and skips unchanged positions; closing resets the measurement so a reopen cannot flash stale coordinates. `anchoredMenuPosition` is a pure exported function with unit tests (`test/use-anchored-menu.test.ts`). A visual-suite test (`console header account dropdown` in `test/e2e/visual.spec.ts`) screenshots the open menu; its baseline is regenerated in CI with the repo's `update-visual-baselines` dispatch and committed from that artifact (baselines are chromium-linux).

## Decisions & Trade-offs

Portal-to-`.console-root` + fixed positioning was chosen over removing the overflow guard (which would reintroduce horizontal page overflow at ~320px) and over portaling to `<body>` (loses the scoped theme variables, verified visually).  Panel widths, gaps (4px scope / 2px menus), backdrop, Escape, and focus-return behavior are unchanged.  The native `<select>`s in the proxy settings card are unrelated to this bug and untouched.

Separately verified, not part of this change: the owner's pasted 502 (2026-10-15 23:29:43 UTC, Ray a4b29b837f9e3822) was the deploy-restart window of sha `fad904bcd` (live `/api/health` reports `processStartedAt` 23:29:54 UTC on that sha); production was healthy on live URLs when checked (`ok: true`, db ok, scheduler fresh, all static chunks 200).

## 2026-10-16 review round (PR #4761, autofix)

Review bots on the PR raised six threads.  Three were real defects in `use-anchored-menu.ts`, all fixed in the same file:

1. **Dismiss-on-open race** (Kody, high).  On the first render after `open` flips true the hook returned `CLOSED`, because the measurement only ran inside a `requestAnimationFrame`.  The click-away backdrop mounts in the same commit as `open`, so a click landing in that ~16ms window hit the backdrop and closed the menu the user had just opened.  Fix: call `update()` synchronously in the effect body, then schedule the rAF only for later resize/scroll.
2. **Per-scroll-tick re-render** (Kody, high/perf).  The capture-phase `window` scroll listener dispatched `setMeasured({...})` with a fresh object literal on every event — including scrolls inside the notification panel's own `overflow-auto` list, where the trigger rect has not moved — reconciling the whole portal subtree per tick.  Fix: compare `container` and the computed `position`/`top`/`left` against the previous measurement and return `prev` unchanged when identical, so React bails out of the re-render.
3. **Unthrottled listener** (Kody, perf).  Same root cause, listener side.  Fix: route `resize` and `scroll` through a `schedule()` that coalesces bursts into at most one `requestAnimationFrame`, replacing the unconditional per-event `update`.

A fourth finding (Sentry, low) — `measured` is not reset on close, so a reopen can paint one frame at the previous open's coordinates — is fixed too: the effect sets `measured` back to the module-level `CLOSED` constant when `open` is false, which React bails out of when nothing changed.

The effect's dependency array is unchanged (`[open, triggerRef, align, width, gap]`); `align`/`width`/`gap` are destructured primitives from an inline `opts` object at all three call sites, so keeping them as deps costs no extra listener churn.

Two Kody threads asking for committed `toHaveScreenshot()` baselines for the three dropdown panels are **not** addressed here, deliberately.  The repo generates visual baselines in CI, not from a code seat: `e2e.yml` exposes a `workflow_dispatch` input `update-visual-baselines` that regenerates the PNGs with the CI browser against the production build and uploads them as an artifact to download and commit.  This seat has no Playwright browsers installed, and a `toHaveScreenshot()` assertion added without its baseline PNG fails the run rather than self-generating, so committing the assertion alone would break CI.  Raised with the maintainer on the PR instead of guessing.

Verification for this round: `npx tsc --noEmit` clean, `npm run build` green, `test/console-a11y.test.ts` 11/11.  The full `npm test` run is red in this seat, but not because of this change: `test/llm-provider.test.ts`, `test/chat-llm.test.ts`, `test/openrouter-credits.test.ts`, and `test/framework-review.test.ts` fail because this cloud seat injects ambient LLM provider env vars (`resolveLlmEndpoint` picks `openrouter` where the test expects `anthropic`/`xai`/`moonshot`/`minimax`, and the credential the test expects to be `undefined` is populated instead).  Confirmed pre-existing by stashing this diff and re-running exactly those four files on the clean branch — byte-identical failures.  Two environment traps worth recording for the next seat: `node_modules` started empty here, and `npx tsc --noEmit` against an empty tree reports several hundred false `TS2591 Cannot find name 'process'` / `TS2307 Cannot find module 'vitest'` errors — run `npm ci` first or the trio's first step is pure noise.  A bare `npx tsc --noEmit` exit code is also not a sufficient signal on its own; read the error text before concluding the branch is broken.

## Verification State

```bash
npx tsc --noEmit
npm test
npm run lint
npx playwright test test/e2e/header-menus.spec.ts --project=chromium
```

`tsc` clean.  Playwright: 3/3 header-menu tests pass on the built app.  WebKit (Safari engine) probe against the same build: all three panels `position: fixed`, inside `.console-root`, center-hittable, and the account panel visually opaque and correctly anchored in a screenshot.  Full vitest and lint results recorded in the STATUS.md entry at landing time.

## Next Steps & Blockers

Merge via `scripts/land.sh`, confirm the auto-deploy on live health URLs, then close ST-4544.  Fixes ST-4544.
