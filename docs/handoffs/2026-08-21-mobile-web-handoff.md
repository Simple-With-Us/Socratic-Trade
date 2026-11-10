# Handoff — Mobile Website review fixes (docs only; implementer to act)

Source report: `/tmp/deepseek-review-mobile-web.md` (full findings).  Board refs: `bf05f16a` (P1 phone-touch-viewport — partially landed), `acc07df6` (P2 phone density — open), `620ef423` (P1 entry dead-ends, web-side — open).  Do NOT re-file; close/update these board items as work lands.  Repo: `/Users/jay/apps/trading-deepseek` (work in your own lane worktree, land via `scripts/land.sh`).

## 1) Top items to implement first (with anchors)

1. **P1 — 401 special-case in console fetch client** — `app/console/lib/useConsoleData.tsx:120-175` (`runFetch`/`runLoop`), `app/console/lib/api.ts` (`fetchDashboard`/`ConsoleApiError`), `middleware.ts:444-445` (bare 401 / login redirect drops destination).  Board `620ef423` web-side.
2. **P2 — Avatar trigger 32×32 on touch** — `app/console/components/chrome.tsx:903` (inline `width/height/minWidth/minHeight/maxWidth:32`) vs `console.css:460-485` (coarse floor).  Comment at `chrome.tsx:854` claims 44px — false.
3. **P2 — 44px-floor gaps** — Segmented `app/console/ui/primitives.tsx:399-403` (+ usage `components/policy-form.tsx:245`); Guardrails native checkboxes `guardrails/page.tsx:442-448,495-501`; collapsible `<summary>` focus ring removed `primitives.tsx:38`; theme picker `chrome.tsx:931-952`.
4. **P2 — Overflow guard + 320px scope collapse** — add `overflow-x: clip` on `.console-root` (console.css); chrome row `shell.tsx:397`, scope `chrome.tsx:207`; `policy-form.tsx:244` `min-w-[18rem]`.
5. **P2 — Coach composer single-line on phones** — `app/console/assistant/chat.tsx:606-607` (Enter sends; Shift+Enter unreachable on mobile keyboards), hint hidden `chat.tsx:661`.
6. **P3 — Gradient orbs animate under opaque console** — `app/globals.css:155-175` (`body::before/::after`, `orb1 24s infinite` / `orb2 28s infinite reverse`).
7. **P2 — Phone type scale + equity chart min-height** — `console.css:89-100` (tokens; 424×11px / 188×12.5px / 13×10px uses), `components/equity-chart.tsx:11,68` (viewBox 640×140, `h-auto w-full` ≈ 70-85px on phones).
8. **P2 — Mobile Scan sort/filter + virtualization + one tree per breakpoint** — `scan/scan-table.tsx:486-549` (desktop tree CSS-hidden but mounted, TableVirtuoso runs), `scan-table.tsx:550-564` (all rows as cards, unvirtualized), `scan-table.tsx:468` (column picker `hidden lg:flex`); same dual-mount pattern `watchlist/page.tsx:223,306`.

## 2) Recommended fix approach per item

1. **401**: In the console fetch client, detect `status === 401` from `fetchDashboard` and (a) stop the poll loop, (b) surface a distinct "Session expired — sign in again" state (distinct from offline/transient error so the freshness strip must NOT say "delayed"), (c) `window.location.assign("/login")` carrying the current path (`/login?next=<path>`).  Middleware already redirects unauthenticated pages to `/login`; add the `next` param there too (`middleware.ts:444-445`) and honor it on the login page.  Keep the middleware's existing pass-throughs (peer market paths, x-admin-token/bearer) untouched — only the *client* 401 handling is new.
2. **Avatar**: delete the inline `style` block (or gate it to `(pointer: fine)` via CSS, not inline) so `.con-bar-ctl` coarse `min-width/min-height:44px` applies.  Re-check the UserMenu dropdown anchor (`chrome.tsx:891-913` — panel anchors to the row's right edge, not the button, so un-capping should be safe; verify at 320px that the panel doesn't overflow left).
3. **44px gaps**: add the missing classes to the coarse-pointer block in `console.css:460-485` (e.g. a `.con-segmented` row class, a `.con-check-row` label class with `min-height:44px`, `padding` on the checkbox labels, and `min-height` on the theme-picker buttons — the theme buttons can reuse `.con-bar-ctl`).  For `summary`: restore a `:focus-visible` ring (remove `focus:outline-none` at `primitives.tsx:38` or replace with `focus-visible:outline-none` + a real ring) and add the summary to the touch floor — do NOT break the closed-state min-height at `console.css:1233-1238` (`.con-disclosure.con-card:not([open]) > summary > div { min-height: 3.25rem }` — that part already clears 44px when closed; the open-state summary and non-card disclosures are the gap).
4. **Overflow**: add `overflow-x: clip` to `.console-root` (clip, not hidden — hidden creates a scroll container and breaks `position: sticky` ancestors; clip does not).  Then audit the chrome bar at 320px: if the scope still collapses, fold the ⌘K trigger into the More/Tabs sheet below `sm` (it is keyboard-dead on touch anyway) rather than shrinking STOP.  Wrap or reflow the `policy-form.tsx:244` `min-w-[18rem]` cluster (e.g. `w-full sm:min-w-[18rem]`).
5. **Composer**: in `chat.tsx:606-607`, branch on coarse pointer / ≤640px (`window.matchMedia("(pointer: coarse)")`): Enter inserts a newline; the explicit Send button submits.  Keep desktop Enter-to-send and the `title`/hint text in sync; un-hide the hint below `sm` (drop `hidden sm:inline` at `chat.tsx:661`).
6. **Orbs**: gate them off when the console is mounted — cheapest is `body:has(.console-root)` in `globals.css` (`body:has(.console-root)::before, body:has(.console-root)::after { content: none }`) or a body class set by the shell.  Verify the marketing/login pages still get the mesh.
7. **Type scale**: add a `@media (max-width: 640px)` block overriding the type tokens (xs→12px, sm→13.5px, base→14px; keep 2xs at 10px only for non-reading labels or bump to 11px) and give the equity chart a `min-height` on its `<figure>`/`<svg>` wrapper (do NOT change the viewBox — it scales; a min-height wrapper preserves the aspect ratio).  Sweep the 13 `fs-2xs` uses; anything a user must read (chat footnote `chat.tsx:660`, chrome mode `chrome.tsx:311`) goes to `--con-fs-xs`.
8. **Scan**: below `lg`, render only the card list (keep the desktop tree mounted is acceptable for v1 only if you also stop the mobile wall from mounting all rows — add a cap/virtualization, e.g. render top N with "Show more" or reuse `TableVirtuoso`'s list mode).  Add a minimal phone sort control (reuse `activeSort`/`setSort`; expose the score/price header chips as tappable sort buttons on the card wall) or state the fixed score-desc order in copy.  Do the same dual-mount cleanup on watchlist if trivial.

## 3) Tests that must fail first + verification

Write failing tests BEFORE the fix (failing-first proof per fleet rules):

- 401 handling: vitest on the fetch client asserting a 401 response stops polling and triggers the login redirect (extend an existing `test/console-*.test.ts` — e.g. alongside `test/console-use-overlay.test.ts`); plus a Playwright case in `test/e2e/` that loads the console with an expired/invalid session cookie and asserts a "Session expired" surface, not a stale dashboard.
- Avatar/44px: Playwright under the existing `mobile-chrome` project (`playwright.config.ts:59-63`) measuring the avatar trigger's bounding box ≥ 44×44 (assert it fails on the current inline style), plus the same measurement for a Segmented button, a Guardrails checkbox row, and a collapsible card summary.
- Overflow: Playwright at 320×700 asserting `document.scrollingElement.scrollWidth <= window.innerWidth` on `/console` (and the Guardrails page, which holds the `min-w-[18rem]` cluster).
- Composer: unit test on the keydown handler (Enter at coarse → newline, not send) or Playwright typing Enter at 390px asserting the textarea gained a `\n` and no send fired.
- Type scale: Playwright computed `font-size` of a `--con-fs-sm`-bearing element at 390px ≥ 13px (fails today at 12.5px) and equity-chart rendered height ≥ 100px at 320px.
- Scan: Playwright at 390px asserting a visible sort control and that DOM row count < data row count (virtualization) — fails today.

Verification commands (in order; from your lane worktree):

```bash
npm run lint            # eslint 9 flat config; fails on errors only
npx tsc --noEmit        # fast type gate
npx vitest run test/<your-new-or-touched-files>   # focused first
npm run build           # full Next build; also regenerates .next types
# Playwright (local smoke recipe — same as playwright.config.ts webServer).
# Load PRIMARY_USER_EMAIL, ENCRYPTION_KEY, and DATABASE_URL from the local
# env file — do not inline values (gitleaks flags hex-looking placeholders).
npm run build && npx playwright test --project=mobile-chrome
# Live probe after deploy/merge: headless Chrome at 320/390/430 for the chrome bar + scope:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --dump-dom --window-size=320,700 https://socratictrade.com/console
```

Full `npm test` may hit network flakes (Yahoo/TwelveData/SEC) locally — CI `verify-hosted` is the authoritative full gate; focused vitest + build locally is sufficient.  No `ios/**` touched — no xcodebuild needed.

## 4) Pitfalls / related code to touch carefully

- **Scope selector is owner-tuned** (`chrome.tsx:196-206`, `shell.tsx:388-396` comments): never add a fixed min-width floor to the scope, never shrink STOP; the 2026-08-05 negative-bottom tab-bar shift is FORBIDDEN (`nav.tsx:327-332`, `console.css:856-896`).
- **Cascade order**: `console.css` is unlayered and therefore beats Tailwind's layered utilities — that is the only reason order actions reach 44px (`orders/page.tsx:161-200` `max-lg:min-h-10`).  If you touch either side, keep the 44px outcome explicit (`min-h-11` or the coarse class).
- **useOverlay scroll-lock** (`use-overlay.ts:28-51`) is the fragile iOS Safari spot: body `position:fixed` + `--con-vv-offset-top` anchoring.  The rollout itself left `mweb-06`/`mweb-09` open for on-device verification (ControlSheet typed-confirm with keyboard up).  Do not refactor the scroll-lock while doing these fixes; verify sheet+keyboard behavior on-device as part of this work.
- **16px input floor excludes checkboxes by design** (`console.css:717` `:not([type="checkbox"])` — checkboxes don't trigger iOS focus-zoom; don't add them to that rule).  Their fix is the 44px row padding, not the font rule.
- **401 redirect loop risk**: the login page and its assets must not hit the same 401 client path; scope the redirect to the console snapshot fetch only.  Do not break middleware pass-throughs for peer market paths / bearer / x-admin-token (`middleware.ts:420-442`).
- **Don't change the equity viewBox** (640×140) — add a min-height wrapper only, or the path math breaks.
- **Don't add `@axe-core/playwright`** — the parity rollout deliberately skipped it because the grandfathered backlog would fail CI; keep the bar at landmark/skip-link smoke + targeted measurements.
- Update `docs/rollouts/YYYY-MM-DD-*.md`, `STATUS.md`, `docs/EFFORT-LOG.md` (and the live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`) and the board items (`bf05f16a`, `acc07df6`, `620ef423`) per the pre-commit/handoff protocol.  Two spaces after sentence terminators in all prose.

## 5) What to avoid (already fixed / duplicates)

- Do NOT re-file board findings `bf05f16a`, `acc07df6`, `620ef423` — close/update them.
- Already fixed — do not redo: the 44px floor on the listed classes, 16px input floor, icon-only run-state below sm, `useOverlay` wiring (scroll-lock + history back + vv sizing) across Sheet/Drawer/Palette/TabsSheet/ConsentGate, watchlist mobile cards, desktop Shift+Enter in the composer, `interactiveWidget`, `themeColor` lockstep, table `overflow-x-auto` wrappers, tab-bar chrome-gap underlay, deep-link focus (`?proposal=`/`?symbol=`), skip link, error-toast roles.
- Do NOT touch the PWA (`app/mobile/**`) — retired, redirects to /console; out of scope.
- Do NOT add `user-scalable=no` / `maximum-scale` — zoom stays enabled (a11y).
- Do NOT touch `ios/**` for any of this — web-only fixes.
- Do NOT change the tab bar `bottom:0` invariant or reintroduce a measured-gap shift.
- Do NOT delete the desktop scan table — only de-duplicate what mounts at phone widths.
- Do NOT add new provider keys, new dependencies without approval, or a second "Run once" control anywhere near the chrome bar (owner report — one is enough).
