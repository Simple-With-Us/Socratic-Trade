# Web ↔ iOS Parity Audit — 2026-08-17

**Surfaces:** desktop website (`/console` ≥1024px), mobile website (`/console` <1024px), native iOS (`ios/SocraticTrade`).  
**Out of scope:** the retired PWA (`/mobile`, `mobile.socratictrade.com`) except leftover coupling that must be removed safely.  
**Method:** code-backed review of `app/console/**`, `ios/SocraticTrade/**`, `src/lib/mobile-api.ts`, `src/lib/push-deep-links.ts`, AASA, Playwright, Vitest, and XCTest.  Three parallel explorers plus lead verification of every P1 claim.  
**Not claimed:** authenticated visual QA.  This Cloud VM has no owner session and no iOS Simulator.  Screenshot and test recipes are in §12 so the next pass can capture them.

Do **not** conflate mobile website with PWA.  The product the owner uses on a phone browser is the same Next.js console as desktop, with a bottom tab bar below `lg`.  `/mobile` is a redirect, not a client.

---

## 1. Executive verdict

The three live clients already share a real control loop: approve / reject, Retry Red Team, Start / Resume / Stop, Close-only, Wind Down, Run Once, order cancel, watchlist, price alerts, Coach, Scan, Guardrails (tighten-only on iOS), and ticker sheets.  Run-state vocabulary is centralized and honest about **market closed ≠ agent stopped**.

The remaining gaps are not “iOS is a toy.”  They are:

1. **Notification taps lie about precision.**  Server URLs carry `?proposal=` and `?symbol=`.  iOS honors proposal ids.  The website ignores both query params.  iOS ignores `?symbol=`.
2. **Activity is not the same product on the phone.**  Web Activity is runs + fills + Alert Center.  iOS Activity is today’s stats + 20 fills + the mobile command log.  `run_failed` / `kill_switch` pushes land on a screen that does not list the event.
3. **Setup is still a desktop job.**  Connections (brokers, API keys) and most Settings (delivery channels, per-event toggles, sharing) have no native surface.
4. **The dead PWA tree is still in the repo** and still has a 368-line unit suite.  That invites the next agent to “fix the PWA” instead of the mobile website.
5. **Automated coverage does not match the product.**  Playwright is one Chromium smoke against `/`.  There is no mobile-viewport project, no axe gate, and no SwiftUI UI tests.

Nothing in this audit found a silent wrong-side approve path.  Money actions still go through server commands with typed live confirm.  Severity below is about **landing, clarity, and coverage**, not a new trading bug.

---

## 2. How to read the matrix

| Mark | Meaning |
|------|---------|
| **Full** | Same job, both (or all three) live surfaces |
| **Partial** | Same job, thinner or differently shaped |
| **Web-only** | Intentional: stay on `/console` (desktop or phone browser) |
| **iOS-only** | Native-only affordance |
| **Gap** | Should exist on that surface and does not |
| **PWA leftover** | Dead code; do not invest |

Severity:

| Sev | Use when |
|-----|----------|
| **P1** | Owner can miss a waiting proposal, a fill, or a failed run because the tap/page does not show the thing |
| **P2** | Real friction: a11y, responsive overflow, state-label drift, missing offline honesty, setup only on another device |
| **P3** | Polish, docs, dead code, known deferrals (widgets, replace-at-market) |

---

## 3. Feature-parity matrix

Clients: **D** = desktop website, **M** = mobile website (`/console` phone width), **iOS** = native app.  PWA is not a column.

| Feature | D | M | iOS | Evidence | Sev | Fix |
|---------|---|---|-----|----------|-----|-----|
| Home / thesis / positions | Full | Full (1-col until `xl`) | Partial (metrics + controls, no two-col desk) | `app/console/page.tsx`; `HomeView.swift` | P3 | Keep.  Do not clone the desk onto iOS. |
| Proposals for Review | Full | Full + sticky Approve/Reject | Full + swipe-reject | `approval-card.tsx`; `ProposalsView.swift` | — | Shipped 2026-08-16 |
| Proposed / Now / Target / Delay | Full | Full | Full | `approval-card.tsx:411-450`; `ProposalPriceReview.swift` | — | Shipped |
| Bulk approve / reject | Full | Full (sticky bar) | Gap | `approvals/page.tsx:333-378` | P3 | Optional.  Phone native is one-card. |
| Typed live confirm | Full | Full | Full | `approval-card.tsx`; `ProposalsView.swift` | — | — |
| Retry Red Team | Full | Full | Full | `proposal.retry_red_team` | — | Shipped |
| Start / Resume / Stop | Full (sheet) | Full (sheet) | Full (inline primary) | `chrome.tsx:356+`; `AgentControlPlan.swift` | P2 | iOS still shows Close Only + Wind Down as peers when Stop is primary (`HomeView.swift:367-390`) |
| Close-only / Wind Down | Full | Full | Full | Commands exist; labels drift (see §5) | P2 | One word: **Exit-only** everywhere |
| Run Once | Full | Icon-only `<sm` | Full | `shell.tsx`; `HomeView.swift` | — | — |
| Order cancel | Full | Full (cards `<lg`) | Full | `orders/page.tsx:402`; `OrderCancel.swift` | — | — |
| Replace at market | Full | Full | Gap | `replace-market-sheet.tsx`; no iOS command | P2 | Add `order.replace_market` + iOS sheet, or deep-link the web card |
| Working-order list | Full | Full | Full | iOS snapshot is working-only | — | Honest.  History stays web. |
| Watchlist add/remove | Full | Full (table + `overflow-x`) | Full | `watchlist/page.tsx:227`; `MarketsView.swift` | P2 | Mobile web needs cards like Orders/Scan |
| Price alerts | Full | Full | Full | Watchlist page; `MarketsView.swift` | — | — |
| Ticker sheet | Full | Full (bottom sheet ≤767) | Partial | `symbol-drawer.tsx`; `SymbolInfoSheet.swift` | P3 | Native sheet is the glance; web owns depth |
| Scan table | Full | Cards `<lg` | Full | `scan-table.tsx:505`; `ScanView.swift` | P2 | iOS star control is 32×32 (`ScanView.swift:174`) |
| Coach chat | Full | Full | Full (drafts read-only) | `assistant/`; `CoachView.swift:323` | P3 | Keep drafts web-only |
| Guardrails read | Full | Dense | Full | `guardrails/page.tsx`; `GuardrailsView.swift` | — | — |
| Policy tighten | Full | Full | Full (tighten only) | `PolicyTightening.swift` | — | Asymmetric by design |
| Policy loosen / universe / overlays | Full | Full | Web-only | `strategy/overlays-panel.tsx` | P3 | Stay web.  Document in Settings. |
| Strategy / models | Full | Long form | Web-only | `strategy/page.tsx` | P3 | Stay web |
| Connections / API keys | Full | Full | Gap | `connections/page.tsx`; Home copy “connect on the website” | P2 | Authenticated handoff, not a native rebuild |
| Settings: appearance, danger, glossary | Full | Horizontal TOC | Partial (push + deletion + data knobs) | `settings/page.tsx`; `HomeView.swift` Account sheet | P2 | Per-event + delivery stay web |
| Results / P&L | Full | Full | Partial (no equity curve / thesis cards) | `results/page.tsx`; `ResultsView.swift` | P3 | Keep thin native |
| Activity: runs | Full | Full | Gap | `activity/page.tsx:24-31`; `ActivityView.swift:1-18` | **P1** | Port run rows or land `run_failed` on a web Activity handoff |
| Activity: fills | Full | Full | Partial (20 fills) | Same | P2 | Raise cap or link “All fills” |
| Alert Center | Full | Buried below fold on Proposals | Gap | `alert-center.tsx`; no iOS inbox | **P1** | iOS Activity tab “Alerts” or Settings list |
| Lessons (learning inbox) | Full | Width token broken | Gap | `lessons/page.tsx:5` uses undefined `--con-page-w` | P2 | Use `CONSOLE_PAGE_WIDTH`; no native Lessons |
| Insights (iOS brief) | — | — | iOS-only | `InsightsView.swift` — **not** web Lessons | P3 | Rename or add “Open Lessons on web” |
| Macro | Full | Full | Web-only | `macro/page.tsx` | P3 | Stay web |
| Usage | Full | Full (no snapshot wait) | Web-only | `shell.tsx` `SELF_SKELETON` / bare route | P3 | Stay web |
| Decisions / traces | Full (not in nav) | Full | Gap | `decisions/`; `DeepLink` drops | P3 | Add to More or keep Home-only |
| Admin | Full | Responsive admin | WKWebView fence | `AdminPortalView.swift` | — | Shipped |
| Command palette ⌘K | Full | Tap trigger; shortcuts dead | Web-only (App Intents not built) | `command-palette.tsx` | P3 | Do not port ⌘K to iOS |
| Customizable 2–4 tabs + More | Full rail | Full | Full | `mobile-tabs.ts`; `TabPreferences` | — | Same contract |
| Widgets / Live Activity | — | — | Gap | 2026-08-12 review item 9 | P3 | After App Group snapshot cache |
| PWA remote | Retired | Redirects to `/console` | — | `app/mobile/page.tsx`; `middleware.ts:283` | P2 | Delete dead tree (see §11) |

---

## 4. Deep-link matrix

Canonical emitter: `src/lib/push-deep-links.ts`.  iOS parser: `DeepLink.swift`.  Domain claim: `app/.well-known/apple-app-site-association/route.ts`.

| URL | Push event | Desktop web | Mobile web | iOS | AASA claimed? |
|-----|------------|-------------|------------|-----|---------------|
| `/console/approvals` | (list) | Page | Page | Proposals tab | Yes |
| `/console/approvals?proposal=<id>` | `pending_approval`, `proposal_withdrawn` | **Page only — no scroll/highlight** | Same | Tab + focus ring | Yes (path) |
| `/console/approvals/<id>` | — | No dedicated route (console list) | Same | Focus if id valid | Yes `/*` |
| `/console/orders` | fill / stale limit (no symbol) | Page | Cards | Assets tab | Yes |
| `/console/orders?symbol=AAPL` | `fill`, `limit_order_stale` | **Query ignored** | **Ignored** | **Query ignored** | Path only |
| `/console/watchlist` | — | Page | Table | Assets tab | Yes |
| `/console/watchlist?symbol=TSLA` | `price_alert` | **Query ignored** | **Ignored** | **Query ignored** | Path only |
| `/console/activity` | `run_failed`, `kill_switch`, default | Full feed + Alert Center | Same | Thin Activity | Yes |
| `/console/assistant` | — | Coach | Coach | Coach tab | Yes |
| `/console/coach` | — | 404 / not a route | Same | Coach tab **if** delivered | **No** |
| `/console/scan` | — | Scan | Cards | Scan | Yes |
| `/console/guardrails` | — | Page | Page | Guardrails | Yes |
| `/console/results` | — | Page | Page | Results | **Yes** (router + AASA aligned) |
| `/console` | — | Home | Home | **DROP** (needs two segments) | No — Safari keeps it |
| `/console/settings` `#notifications` etc. | Palette / TOC | Hash scroll | Hash scroll | DROP | No |
| `/console/connections` `#brokers` | — | Hash scroll | Hash scroll | DROP | No |
| `/console/strategy` `#models` | — | Hash scroll | Hash scroll | DROP | No |
| `/console/lessons` | — | Page | Page | DROP | No |
| `/console/macro` | — | Page | Page | DROP | No |
| `/console/decisions/[id]` | — | Trace | Trace | DROP | No |
| `/console/usage` | — | Page | Page | DROP | No |
| `socratictrade://…` | Auth only | n/a | n/a | Rejected as content | n/a |
| `https://www.socratictrade.com/…` | — | Works | Works | DROP (host pin) | No |

**P1 evidence (web proposal focus):** `push-deep-links.ts:91-95` emits `?proposal=`.  `test/apns-deep-link-contract.test.ts` pins that shape.  `approvals/page.tsx` has no `useSearchParams`.  `approval-card.tsx:455` is a bare `<article>` with no `id`.

**P1 evidence (symbol focus):** `push-deep-links.ts:96-102`.  `DeepLink.swift:75-77` maps orders/watchlist to `.markets` and drops query.  `orders/page.tsx` and `watchlist/page.tsx` never read `symbol`.

**P3 AASA alias:** `DeepLink.swift:80-81` accepts `/console/coach`.  AASA only claims `/console/assistant`.  A `/coach` URL never becomes a universal link.

---

## 5. Control and state clarity

Shared vocabulary lives in `app/console/lib/derive.ts` (`deriveStateInfo`) and `ios/SocraticTrade/MobileModels.swift` (`deriveRunStateWord`).  XCTest: `RunStateDerivationTests.swift`.

| State | Chip / word | What it means | Drift |
|-------|-------------|----------------|-------|
| `active` + session open | Running | Scheduled autonomy is on | Clean |
| `active` + session closed + extended off | Paused · market closed | Agent is **on**; market is closed | Copy is explicit on web (`chrome.tsx:470-472`) and iOS (`AgentControlPlan.swift:49-50`) |
| `close_only` | **Exit-only** (chip) | No new buys; exits work | Control sheet title is **Close-only** (`chrome.tsx:425`); iOS button is **Close Only**; glossary says Exit-only (`settings/help.tsx:76`) |
| `liquidating` | Winding down | Sells to cash | Sheet: “Wind down” |
| `halted` | Stopped | Nothing this app will trade | Clean |

**iOS vs web chrome.**  Web hides secondary postures in `ControlSheet` and shows one Start / Resume / Stop button in the top bar.  iOS `AgentControlPlan` picks a primary, then `HomeView` still renders Close Only and Wind Down in the same card when the agent is on (`HomeView.swift:367-390`).  That is better than the pre-2026-08-16 “Start + Stop both live” bug, but it is still more peers than the website.

**Approvals while stopped.**  Web banner: server refuses approve/reject; Run Once can still create proposals (`approvals/page.tsx:389-396`).  iOS gates via `canSubmit` + catalog.

**Fix:** pick one product word.  Owner glossary already chose **Exit-only**.  Rename the sheet option, the iOS button, and the toast (“Close-only”) to Exit-only.  Keep `close_only` as the wire id.

---

## 6. Accessibility

Baseline is better than the 2026-06-29 audit: landmarks on `<main>`, roving tablists (Scan, Activity), focus trap for palette / consent / drawer, `:focus-visible`, `prefers-reduced-motion`, loading `aria-live`, failure `role="alert"`, many 44px hooks via `.con-btn` + `(pointer: coarse)`.

Checked against current [accessibility coding guidelines](https://github.com/GoogleChrome/modern-web-guidance) (skip links, label association, live-region urgency, 44px targets, native dialogs).

| Finding | Surface | Sev | Evidence | Fix |
|---------|---------|-----|----------|-----|
| No skip-to-content | D + M | P2 | `shell.tsx:207` `<main>` has no `id`; no skip link in console | `<a href="#console-main" class="visually-hidden">Skip to content</a>` + `id="console-main" tabindex="-1"` |
| Error toasts are `polite` | D + M | P2 | `toast.tsx:47` single `role="status" aria-live="polite"` for `neg` too | Split: polite region for info/pos; `role="alert"` / assertive for `neg` |
| `TypedConfirm` label not wired | D + M | P2 | `chrome.tsx:556-570` — `<label>` has no `htmlFor`; input has no `id` | `htmlFor` / `id` pair; do not use placeholder as the name |
| More tab missing `aria-expanded` | M | P2 | `nav.tsx:442-460` | `aria-expanded={tabsOpen}` `aria-controls={sheetId}` |
| Mobile tab labels 10px | M | P2 | `console.css:823` | `12px` / `0.75rem` minimum; do not use `px` for type if Dynamic Type on web is a goal |
| Header chrome not all on `.con-btn` | D + M | P2 | `console.css` notes ScopeSelector / StateChip / UserMenu | Route those through `.con-btn` or `min-h-11` |
| No axe / Lighthouse a11y in CI | D + M | P2 | Playwright has one spec, no `@axe-core/playwright` | Add axe to a console smoke at 390 and 1280 |
| Swipe-to-reject / cancel has no VO alternative | iOS | P2 | `AppComponents.swift:711-755` — swipe only; buttons also exist on the card for proposals, not advertised as the swipe twin | `accessibilityAction` / hint: “Swipe left to reject, or use Reject” |
| Scan watchlist star 32pt | iOS | P2 | `ScanView.swift:174` | `min 44×44` hit box, visual glyph can stay 22 |
| Sheets are custom, not `<dialog>` | D + M | P3 | `sheet.tsx` + `focus-trap.ts` | Acceptable; document stacked-trap risk.  Native `<dialog>` is a later cleanup |
| iOS forced light | iOS | P3 | `SocraticTradeApp.swift` `preferredColorScheme(.light)` | Matches owner default.  Web still has Light / Dark / System |

Login bullets are already synced (`LOGIN_VALUE_BULLETS` ↔ `LoginView.valueBullets`).

---

## 7. Responsive behavior (mobile website ≠ PWA)

Breakpoint contract:

| Width | Chrome |
|-------|--------|
| `<640` | Dense header; Run Once icon-only; 2-col price strip on cards |
| `≤767` | Sheets become bottom sheets; toasts lift above the tab bar |
| `<1024` (`lg`) | Bottom tabs (2–4 pins + More); freshness bar under header; `pb-24` on main |
| `≥1024` | Left rail; freshness at bottom |
| `≥1280` (`xl`) | Home + Proposals two-column |

**Works.**  Orders and Scan have real card lists below `lg`.  Approval CTAs stick above the tab bar (`console.css:911-918`).  Tab pin state is SSR-safe (`mobile-tabs.ts`).

**Does not work as well.**

| Issue | Sev | Evidence | Fix |
|-------|-----|----------|-----|
| Watchlist is a wide table on every width | P2 | `watchlist/page.tsx:227` `overflow-x-auto` only | Add `lg:hidden` cards like Orders |
| Lessons max-width is a missing CSS variable | P2 | `lessons/page.tsx:5` `max-w-[var(--con-page-w)]` — `--con-page-w` is defined **nowhere**.  Other pages use `CONSOLE_PAGE_WIDTH` = `max-w-5xl` (`page-width.ts:18`) | One-line swap |
| Guardrails stop-flow is a wrapped diagram | P2 | `stop-flow.tsx` | Stack the circuit on `<lg`; keep the diagram for desktop |
| Alert Center on Proposals sits in the `xl` aside | P2 | `approvals/page.tsx` | On `<xl`, pin a “Alerts” chip that jumps to Activity → Alert center |
| Command palette dirty-guard bypass | P2 | `command-palette.tsx:8-9` | Run the same `useNavDirtyGuard` before `router.push` |
| 10px tab labels | P2 | See §6 | — |

Installed-console (`display-mode: standalone`) still gets a safe-area inset (`console.css:788-791`).  That is the **website** added to the home screen, not the retired PWA product.  Keep the CSS; do not revive `/mobile`.

---

## 8. Notifications

| Channel | Desktop web | Mobile web | iOS |
|---------|-------------|------------|-----|
| In-app Alert Center | Yes (Proposals aside + Activity tab) | Yes, easy to miss | **No** |
| Toasts | Yes | Yes (raised) | Command / inline banners |
| APNs | — | — | Yes (`PushNotifications.swift`) |
| ntfy / Pushover / email / SMS / webhook | Settings → Delivery | Same | Configure on web only |
| Browser Push API / service worker | **Never implemented** | Same | n/a |

Foreground iOS banners are suppressed while SSE is connected (`PushNotifications.swift`).  Permission is asked on first Proposals visit, not at cold start — correct.

**P1 product hole:** a `run_failed` push opens iOS Activity.  That view does not render `snapshot.notifications` or strategy-run rows.  The owner sees “today’s order count” instead of the failure.  Web Activity’s Alert Center **does** list it.

**Fix (smallest):** add an Alerts section to `ActivityView` from the existing snapshot notifications array (already on the dashboard snapshot for web).  If the mobile snapshot omits `notifications`, add that field — do not invent a second inbox.

---

## 9. Offline and error states

| Situation | Desktop / mobile web | iOS |
|-----------|----------------------|-----|
| First load in flight | Wordless intro + SR live region; 15s “still loading” (not a failure) | Wait on launch; cached UserDefaults snapshot if any |
| First load failed | `role="alert"` + Retry (`shell.tsx:143-165`) | Error card + Retry; cache if present |
| Refresh failed, old data | Freshness “refresh failing” / delayed | Stale banner at 180s; most commands blocked, stop still allowed |
| SSE drop | Reconnect; poll every 15s | Reconnect every 5s |
| Tab hidden | Poll skipped | Foreground reload |
| `navigator.onLine` | **Not listened** | OS reachability not shown beyond stale |
| Session expired | Middleware → login | Store clears → `LoginView` |
| Cloudflare 521–523 | Generic fetch error | Mapped copy (`MobileAPIClient.swift`) |
| Scan / Coach local fail | Page empty / chat error | `InlineErrorBanner` + retry |
| Watchlist refresh fail | Chip: “refresh failing — showing last good data” | Snapshot-level only |

**P2 fix:** listen for `online`/`offline` on web and show the same sentence on both clients: “You’re offline.  Showing the last snapshot.”  Do not invent quotes while offline.

---

## 10. Performance

| Cost | Web | iOS |
|------|-----|-----|
| First paint | Full dashboard snapshot; broker chain can take ~15–24s (documented, no longer a fake error) | Same payload via `/api/mobile/snapshot` |
| Poll | 15s + SSE debounce 200ms | SSE + foreground + 30s status tick |
| Heavy modules | `approval-card.tsx`, `chrome.tsx`, `intro-canvas.tsx`, Home page | Full snapshot in memory + UserDefaults JSON |
| Images | Ticker logos | `AsyncImage` from GitHub CDN, no disk cache (`AppComponents.swift`) |
| Scan | Memoized table + separate mobile cards | On-demand fetch; UI admits ~20s |
| Usage | Renders without snapshot | n/a |

**P3 risks:** UserDefaults as a snapshot store will grow with proposal/fill history.  Uncached logos hitch long Scan lists.  Neither is a ship blocker.

**Do not** add a service worker “for performance.”  That is how a PWA comes back.

---

## 11. PWA leftovers — remove safely

`/mobile` and `mobile.*` already redirect to `/console` (`app/mobile/page.tsx`, `middleware.ts`, `test/pwa-retired-redirect.test.ts`, `test/subdomain-routing.test.ts`).  The owner does not use this client.  **Do not add features under `app/mobile/**`.**

### Safe to delete (after helper extraction)

| Path | Why |
|------|-----|
| `app/mobile/mobile-pwa-client.tsx` | `MobilePwaClient` is never imported by production |
| `app/mobile/components/*` | Only mounted from the dead client |
| `test/mobile-pwa-client.test.tsx` | Tests dead UI.  Move any still-useful helpers (`mobileRunState`) into `src/lib/` **first** if console tests need them |

Keep `app/mobile/page.tsx` as the redirect so old bookmarks do not 404.

### Must keep (iOS and/or `/console` depend on them)

| Path | Why |
|------|-----|
| `app/api/mobile/**` | iOS `MobileAPIClient` |
| `src/lib/mobile-api.ts` | Command catalog + worker |
| `src/lib/apns.ts`, `push-deep-links.ts`, `db-device-tokens.ts` | Native push |
| AASA route + `DeepLink.swift` | Universal links |
| `app/manifest.ts` + `public/icons/*` | Installable **console** (home-screen website), not the PWA product |
| `test/mobile-*.test.ts` except `mobile-pwa-client` | iOS contract |
| `test/apns-*.test.ts` | Cross-language push contract |

### Refactor, do not delete blindly

- Comments that still say “iOS/PWA” as one lane: `src/lib/mobile-api.ts:72`, `app/api/mobile/snapshot/route.ts:29`, `src/lib/symbol-desk.ts:2`, `src/lib/push-deep-links.ts:6`.
- `docs/mobile-api-and-clients.md` still describes “phone PWA” as a peer client.  Rewrite to: **website `/console` + native iOS**.  `/api/mobile` is the native transport, not a PWA.
- Orphan commands with no live client: `consent.set`, `notification.test` (web uses `POST /api/notifications/test`).  Keep server handlers until an audit of the catalog snapshot; do not expose them in iOS UI.

### Removal sequence (so nothing breaks iOS)

1. Grep that no file outside `app/mobile/**` and `test/mobile-pwa-client.test.tsx` imports the PWA components.
2. Extract any helper still asserted by non-PWA tests.
3. Delete the component tree + PWA test.
4. Rewrite `docs/mobile-api-and-clients.md`.
5. Keep redirect tests green.
6. Do **not** delete `/api/mobile` or the manifest in the same PR.

---

## 12. Test coverage and screenshot strategy

### What exists

| Layer | What it covers | Hole |
|-------|----------------|------|
| Vitest console | Tab keyboard, focus trap, load-state, nav labels, triage, price review, readiness | Almost no rendered-page tests.  No `?proposal=` test |
| Vitest mobile API | Commands, cancel, policy precondition, stop preemption, view scope | Keep — this is iOS backend |
| `test/apns-deep-link-contract.test.ts` + Swift `PushNotificationTests` | Every notify event → URL → iOS tab | Does **not** assert web scroll/highlight |
| `test/pwa-retired-redirect.test.ts` | `/mobile` → `/console` | Keep |
| Playwright | **One** spec: `test/e2e/dashboard-smoke.spec.ts` on `/` looking for “Portfolio”, “Decision”, “Scan”, Run, Start\|Stop | Single Chromium width.  No `390×844`.  No approvals.  No axe.  Copy is Home leftovers, not a real console IA test |
| XCTest (14 files) | Deep links, push contract, agent plan, run-state, tighten, cancel, models, tabs, type | **Zero** SwiftUI UI tests.  Home / Proposals / Markets / Activity untested as views |
| Visual / Percy | None | — |

### Screenshot recipe (next implementation PR, or owner device)

This Cloud session could not sign in or boot a Simulator.  Capture in **light** theme (`docs/FLEET-UI-COPY.md`).

**Website** (Playwright, add a `Mobile Chrome` project at `390×844` and keep `1280×720`):

1. `/login` — both widths (public; no secrets).
2. `/console` Home — rail vs bottom tabs; state chip “Paused · market closed” vs “Stopped”.
3. `/console/approvals` — price strip; sticky CTAs vs tab bar; Alert Center below fold on 390.
4. `/console/approvals?proposal=<id>` — **today this will fail the highlight assertion**; that is the bug.
5. `/console/orders` — table vs cards.
6. `/console/watchlist` — horizontal scroll on 390 (bug).
7. `/console/lessons` — width vs neighboring pages (bug).
8. `/console/activity` — Alert center tab.
9. Offline: DevTools offline → freshness / error copy.

**iOS** (`xcrun simctl io booted screenshot`, iPhone 16/17 Pro, light):

1. Home Agent Controls when `active` + market closed (Stop primary; Close Only / Wind Down still visible).
2. Proposals card with Proposed / Now / Target / Delay + Retry Red Team.
3. Assets: working order cancel; watchlist.
4. Activity after a simulated `run_failed` deep link (empty of the failure — bug).
5. Scan row star hit target.
6. VoiceOver rotor on a proposal card (swipe reject undiscoverable).

Store shots under `docs/audits/2026-08-17-web-ios-parity-shots/` in a follow-up.  Do not commit App Store Connect screenshots from a failed highlight.

### Tests to add with the first fix PR (not this report)

```ts
// test/console-deep-links.test.tsx
// /console/approvals?proposal=abc → article#proposal-abc in view, data-focused
// /console/orders?symbol=T → row/card[data-symbol=T] focused
// /console/watchlist?symbol=T → same
```

```swift
// DeepLinkTests: destination keeps .markets but MobileControlView applies symbol focus
// ActivityView: notifications non-empty renders an Alerts section
```

```ts
// playwright: 390 and 1280; axe on /login + /console (smoke auth);
// assert getByRole('navigation') and skip link.
```

Do **not** add Playwright against `/mobile` except the existing redirect assertion.

---

## 13. Severity-ranked findings (actionable)

### P1 — do these first

1. **Honor `?proposal=` on the website.**  **Fixed 2026-08-20** (`cursor/web-ios-parity-fixes-e83a`).  
   Scroll and ring `article#proposal-${id}` on `/console/approvals`.  Same id iOS already uses.  
   Files: `approvals/page.tsx`, `approval-card.tsx`.  
   Test: `test/console-deep-links.test.ts` + keep APNs contract.

2. **Honor `?symbol=` on web Orders / Watchlist and iOS Assets.**  **Fixed 2026-08-20.**  
   Filter or scroll to the row; open the ticker sheet on iOS.  
   Files: `orders/page.tsx`, `watchlist/page.tsx`, `DeepLink.swift` (pass symbol through), `MarketsView.swift`, `MobileControlView.swift`.

3. **Show the notification on iOS Activity.**  **Fixed 2026-08-20.**  
   Render Alert Center rows (or a compact list) from snapshot notifications.  `run_failed` / `kill_switch` must be visible after a tap.  
   Files: `ActivityView.swift`, `app/api/mobile/snapshot/route.ts` (`notifications`, payload/webhook stripped).

### P2 — next wave

4. One label: **Exit-only** (chip, sheet, iOS button, toasts).  Wire id stays `close_only`.  **Fixed 2026-08-20.**
5. Lessons → `CONSOLE_PAGE_WIDTH`.  **Fixed 2026-08-20.**
6. Watchlist mobile cards.  **Fixed 2026-08-20.**
7. Skip link + assertive error toasts + `TypedConfirm` `htmlFor`.  **Fixed 2026-08-20.**
8. More button `aria-expanded`.  **Fixed 2026-08-20.**
9. Scan star 44pt; swipe `accessibilityAction`.  **Fixed 2026-08-20.**
10. `navigator.onLine` banner on web; match iOS stale copy.  **Fixed 2026-08-20.**
11. Delete PWA component tree per §11 (own PR, after helper extract).  **Fixed 2026-08-20** (redirect + `/api/mobile` kept; no helper extract needed).
12. Rewrite `docs/mobile-api-and-clients.md` so PWA is not a peer.  **Fixed 2026-08-20.**
13. Playwright mobile project + axe on login/console.  **Fixed 2026-08-20** as skip-link + landmark smoke on Desktop Chrome and iPhone 13 (390×844).  Did not add `@axe-core/playwright` so a grandfathered backlog cannot fail CI.
14. iOS: collapse Close Only / Wind Down behind a “More postures” disclosure when Stop is the primary (match web sheet).  **Fixed 2026-08-20.**
15. Connections: “Open in Safari” authenticated handoff from Account & Settings (cookie / ASWebAuthentication), not a native broker form.  **Fixed 2026-08-20** as a Safari `Link` to `/console/connections`.

### P3 — backlog (do not block)

16. Replace-at-market on iOS (explicitly deferred in wave 3).
17. Widgets / Live Activity.
18. Wash-sale note on proposal cards (still no decoded field on the mobile snapshot).
19. `dustWarning` after iOS cancel.
20. AASA `/console/coach` or drop the alias from `DeepLink`.
21. Put Decisions in the More sheet or accept Home-only.
22. Insights → “Status” so it is not confused with Lessons.
23. Logo disk cache; snapshot cache size cap.
24. Command-palette dirty guard.
25. Native `<dialog>` migration.

---

## 14. What not to do

- Do not rebuild Strategy, Macro, Usage, Lessons, or overlay CRUD in Swift.
- Do not wrap `/mobile` in WKWebView.
- Do not add browser push / a service worker.
- Do not treat `app/manifest.ts` as the retired PWA — it is the installable website.
- Do not delete `/api/mobile` while deleting PWA UI.
- Do not re-paternalize approve (extra “are you sure it’s real money” beyond typed live confirm).
- Do not spend a cycle on PWA parity or `/mobile` restyles.

---

## 15. Prior review — shipped vs still open

From `docs/rollouts/2026-08-12-ios-web-parity-review.md` top 10, updated 2026-08-17:

| # | Item | Status |
|---|------|--------|
| 1 | APNs | **Shipped** |
| 2 | Decoded proposal fields | **Mostly shipped**; wash-sale still missing |
| 3 | Cancel + replace-at-market | Cancel **shipped**; replace **open** |
| 4 | Close Only + Wind Down | **Shipped** (label drift remains) |
| 5 | `runDuringExtendedHours` | **Shipped** |
| 6 | Tighten-only policy | **Shipped** |
| 7 | Universal links | **Shipped** (query precision incomplete) |
| 8 | Catalog decode | **Shipped** |
| 9 | Widget + Live Activity | **Open** |
| 10 | Watchlist quotes + ticker sheet | **Partial** (sheet shipped; `?symbol=` not consumed) |

2026-08-16 review UX (`#2757`): approve speed, price strip, Retry Red Team, state-aware Start/Stop, PWA **redirect** (not deletion).  This audit starts where that PR stopped.

---

## 16. Suggested PR slices (implementation, not this report)

| PR | Scope | Risk |
|----|--------|------|
| A | Web `?proposal=` + `?symbol=` + tests | Low.  Money path unchanged |
| B | iOS symbol focus + Activity alerts | Medium.  Snapshot field check |
| C | Exit-only copy + Lessons width + Watchlist cards | Low |
| D | A11y: skip link, toasts, labels, More, 44pt star, VO swipe | Low |
| E | Delete PWA UI tree + doc rewrite | Low if §11 sequence followed |
| F | Playwright 390 + axe | Medium (flake budget) |

This document is report-only.  No product code changed in the PR that lands it.
