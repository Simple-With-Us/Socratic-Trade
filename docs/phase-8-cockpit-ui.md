# Phase 8 - Cockpit UI and Strategy Studio

> **2026-06-16 redesign (branch `ui-redesign`) supersedes the layout below.**
> The cockpit was rebuilt on Tailwind CSS 4 + Recharts + Motion with a
> dark/light theme system. The `react-resizable-panels` shell and the always-on
> bottom drawer are replaced by: a slim command bar, a persistent Portfolio rail
> + a tabbed workspace (Decision / Market Scan / Performance / Strategy), feeds
> in a right slide-over, and modal Settings / Strategy Studio, plus a ⌘K command
> palette and learning-loop visualizations (P&L by thesis/regime).
> A 2026-06-18 glassmorphism pass then changed the visual treatment without
> changing the core information architecture. A 2026-06-19 stability pass replaced
> the dashboard's Recharts wrappers with SSR-safe SVG/CSS chart primitives so
> `next dev` can stream `/` reliably after builds. See
> `docs/rollouts/2026-06-16-ui-redesign-tailwind.md` and
> `docs/rollouts/2026-06-18-glassmorphism-ui.md`. The sections below describe
> the prior panel-based cockpit and current semantics that still matter.
>
> 2026-08-21: Native iOS / Mac Catalyst chrome now follows the website header on
> every tab: bell (notifications inbox) leading, settings gear trailing.  Regular
> width uses `tabViewStyle(.sidebarAdaptable)` plus the existing card-column
> scaffold so an iPad Air 11" and a resized Mac window reflow; compact keeps the
> phone tab bar.  Admin Portal is a first-class tab gated on `currentUser.isAdmin`,
> with a native rail of the eleven website admin pages and a fenced WKWebView that
> intercepts "Back to Console" instead of loading `/console` inside the app.
> The Assets price-alert composer is removed.  PR #3028 merged to `main` as squash
> `a851a68d` (2026-08-22).  iOS-only; TestFlight is separate.  Rollout:
> `docs/rollouts/2026-08-21-ios-wide-layout-admin-tab.md`.
>
> 2026-06-28: The SSR first-paint dashboard shell now uses a thin boot strip
> instead of repeated visible loading labels or quiet skeleton tiles. The loader
> keeps one screen-reader status and still renders an explicit alert card when
> `/api/dashboard` fails.
>
> 2026-06-28: Proposal cards show relative age while a decision is under 24
> hours old and switch to date/time for older decisions. Settings risk controls
> that present dollar vs percent modes must write the selected mode and clear the
> other mode in the same policy update so hidden stale caps cannot bind.
>
> 2026-06-28: Fresh proposal performance chips are suppressed until the proposal
> is at least 15 minutes old, approval failures with broker error status refresh
> the queue with explicit placement-failed copy, Market Scan column settings can
> reorder visible columns and default to Sector before Sec RS, Symbol drilldowns
> use the fixed slide-over header for logo/ticker/company/sector/price, close-only
> history renders as a line chart, and Macro header helper copy lives inside the
> same padded header block as the title.
>
> 2026-06-30: Activity/Audit feed diagnostics now favor plain-language summaries
> over raw JSON for strategy runs, signal snapshots, candidate skips, rationale
> diversity, and recoverable issues. Rows keep the detail to one line but set a
> full hover title so long text is inspectable without opening developer tools.
> Strategy LLM steps are shown with label/model/provider/status, and Settings uses
> a clearer User/Account scope header, account picker, tab shell, and denser
> notification/model controls.
>
> 2026-07-03: The Socratic Trade branch (`codex/socratic-trade-autonomy-mockup`)
> supersedes the cockpit's homepage direction with an Autonomy Desk: live thesis,
> capital posture, delegated action log, evidence contribution, dissent, outcome
> learning, coaching, and framework-improvement proposals. This is now backed by
> persisted Socratic decision cases, structured retrieval attribution, framework
> proposal review actions, coach notes, and explicit autonomous override semantics
> for owner preference gates. `/design/socratic-trade` is now a coded public product
> overview rather than a static mockup. See `docs/rollouts/2026-07-03-socratic-autonomy-ui.md`.
>
> 2026-07-04: `codex/console-ui-swimlane` extends the Autonomy Desk's inspection surfaces:
> approval cards expose served-model/failover provenance, red-team triggers, sizing/R:R receipt
> data, and linked citations; `/console/decisions/[id]` is the read-only trace inspector for
> decision cases, coach notes, and linked framework proposals; mobile LIVE approval uses the same
> phrase gate as desktop. See `docs/rollouts/2026-07-04-console-ui-swimlane.md`.
>
> 2026-07-04: `/console/scan` now matches the legacy dashboard's browser-local column controls
> for the current console scan columns: visibility toggles, reorder arrows, Reset, and saved
> visible-column state/order. See `docs/rollouts/2026-07-04-scan-column-customization.md`.
>
> 2026-07-13: Live Thesis no longer presents one concatenated Green/sizing/Red/outcome paragraph.
> It renders visually distinct Green Team, deterministic sizing/risk, Red Team, and deterministic
> outcome sections. Red verdicts say approved at full size / approved at half size / rejected /
> unavailable rather than "survived"; blocked proposals display intent ("Buy") rather than the
> false execution claim "Bought". Capital posture and approval cards resolve the selected daily
> dollar-or-percent cap against current NAV. Migration v27 persists the exact Green rationale and
> deterministic sizing receipt across refresh/lifecycle writes, and an objection is labeled
> overridden only when the final policy decision records an applied override; a pending request is
> explicitly labeled as requested rather than applied.
> The Guardrails cap selector derives from the persisted account whenever no draft is active, so
> discard/save/account changes cannot leave the Dollar/Percent control displaying stale local mode.
>
> 2026-07-14: approval cards and Live Thesis use the structured Green-only rationale rather than
> relabeling appended Red or owner-hold prose as Green evidence. Proposal/case lifecycle status now
> stays aligned through placement, broker rejection, expiry, withdrawal, and reconciliation. An
> uncertain submission says “Placement pending confirmation” and never invites a retry; final-size
> Red rejection/unavailability/half-size advice and any explicit owner override remain distinct.
> Independent rationale-diversity or preference-override holds render in their own “Why your
> approval is required” panel instead of being mislabeled as a Red Team outage. A synchronous
> broker fill renders as a completed success in the single/bulk approval flow and Activity feed,
> never as a failed approval or “awaiting next update.”
> Chat retries return the original proposal's current lifecycle status, and stale-fill recovery
> cannot show “Filled” while its accounting receipt remains pending; those ledgers advance together.
> A broker cancellation after partial execution is shown as a completed partial execution—not a
> total rejection—and current partial quantity enters exposure immediately.
>
> 2026-08-18: the console mobile tab bar (Safari browser, not PWA) keeps `bottom:0`
> and does not shift labels into the URL chrome. Browser `padding-bottom` is
> `calc(env(safe-area-inset-bottom) * 0.22)` so ~78% of the grey-blue band between
> the tab labels and the floating URL pill is gone; the bar and a `::after`
> underlay paint solid `--con-surface` so the remaining strip and the area around
> the URL chrome match the tab strip, not `--con-bg` `#f1f4f6`. Standalone/PWA
> still uses the full env() pad. See `docs/rollouts/2026-08-18-mobile-tabbar-chrome-gap.md`.
>
> 2026-07-14: the decision trace treats the structured Red Team verdict card as the
> canonical explanation. Exact generic dissent copies and known generated policy
> wrappers around that same reason are hidden, while genuinely distinct policy
> objections and override context remain visible. The canonical card owns the explicit
> verdict status too, preserving “Approved at half size” and “Rejected by Red Team”
> without restoring duplicate rationale rows.
>
> 2026-08-17: console a11y batch (#2561).  Light tonal chip text is validated on the
> matching soft fill (WCAG AA at 11px/600).  `Sheet`, nav `TabsSheet`, and the scan
> Columns popover share `useFocusTrap` so only the topmost surface handles Escape.
> Tooltip explanations are keyboard-reachable and announced via `aria-describedby`.
> `Meter` accepts an accessible name.  See `docs/rollouts/2026-08-17-console-a11y-batch.md`.


This phase restructures the dashboard from a long vertical page into a
single-screen trading cockpit. The goal is to make the app usable during active
mock/local vs live supervision without requiring page-level scrolling on a desktop
screen.

## Layout Model

- The desktop app shell uses `height: 100dvh` with a fixed command-bar row above
  the main cockpit. (The original always-on bottom-drawer row was replaced by an
  on-demand right slide-over for the feeds — see "User-Facing Tabs" — so the shell
  is no longer a three-row grid.)
- As of 2026-06-19, the fixed-height cockpit shell is desktop-only (`xl+`).
  Mobile/tablet use `min-height: 100dvh`, normal page scrolling, responsive shrinking command-bar buttons (grouped into selects/utility vs actions) that stack as exactly two right-aligned lines below the `md` (768px) breakpoint, and a compact portfolio summary above the workspace.
- The main cockpit has three regions: left rail, center workspace, and right
  inspector.
- Page-level scrolling is intentionally disabled on desktop. Long content
  scrolls inside its pane.
- Mobile/tablet breakpoints revert to a single-column layout with normal page
  scrolling.

## User-Facing Tabs

> Updated 2026-07-01 to match code. The tab set grew past the original
> 4-workspace / 3-feed split described in the 2026-06-16 redesign banner above;
> the lists below are the source of truth (`app/dashboard-client.tsx`
> `WorkspaceTab` type and `FeedTab` type).

- **Center workspace tabs (7):** `Decision`, `Assistant`, `Market Scan`,
  `Macro`, `Performance`, `Tax`, `Strategy` (`WorkspaceTab` union,
  `app/dashboard-client.tsx`). As of 2026-07-01, only the five primary tabs
  (`Decision`, `Assistant`, `Market Scan`, `Performance`, `Strategy`) render
  inline; `Macro` and `Tax` are demoted behind a **"More" overflow menu** on the
  tab row to keep the single-screen row scannable. Both overflow tabs stay
  reachable in one extra click, remain deep-linkable, and persist via the same
  `workspaceTab` state / `WORKSPACE_TAB_KEY` local-storage key as the primary
  tabs. The overflow menu preserves `role="tab"`/`aria-selected` semantics (see
  Accessibility below), and the "More" trigger shows the active overflow tab's
  label so the user always sees where they are.
- **Right inspector tabs:** `Operate`, `Risk`, `Profile`.
- **Feed tabs (4):** `Activity`, `Runs`, `Notifications`, `Audit` (`FeedTab`
  union, `app/dashboard-client.tsx`). These render in the feed slide-over rather
  than an always-on bottom drawer.
- **Console mobile tab bar (2026-08-18):** `MobileTabBar` stays `bottom:0`. In a
  normal Safari tab the safe-area pad is 22% of `env(safe-area-inset-bottom)` so
  the band above the floating URL chrome shrinks ~78%; a solid `--con-surface`
  `::after` covers the chrome halo. Do not reintroduce a negative-`bottom` gap
  shift (that hid labels on 2026-08-05). Installed/standalone still uses the
  full env() pad for the home indicator.

The `Decision` tab remains the default because the app's core value is showing
what the agent recommends or decided, not hiding that output in logs.

## Strategy Studio

Strategy Studio exists in two places:

- A center workspace `Strategy` tab for normal use.
- A command-bar modal for larger editing/review sessions.

It includes:

- editable strategy prompt with autosave
- reset-to-default prompt action
- Green Team proposal model, Red Team review model, and reasoning-effort controls
- slider/field controls for high-impact strategy and risk options
- scoring weight controls
- left-aligned LLM strategy review panel with a shared model picker
- manual apply flow for suggested strategy/policy changes

LLM-generated strategy updates are advisory only. They do not mutate prompt,
policy, risk, or scoring weights until a human clicks `Apply Reviewed Changes`.
This is intentional: automatically rewriting the trading strategy without a
review gate is unsafe for an agentic trading tool.
The review action should stay visually separate from modal/header submit
patterns; it generates a proposal and is not itself a save/OK action.

Review proposals render as before/after data. Prompt patches show the current
prompt and the exact replacement prompt. Scoring-weight changes are grouped as
Strategy Studio values; risk and automation policy changes are grouped separately
with current value, proposed value, and the settings area where the value lives.

## Strategy Tuning API

`POST /api/strategy/tune` gathers:

- active policy and prompt
- recent strategy runs
- recent fills in the active mock/local or live mode
- current performance summary
- latest market scan and proposal summary when available
- macro context from `src/lib/macro.ts`

When `OPENAI_API_KEY` is configured, the route asks the model for a strict JSON
strategy tuning proposal. Without the key, it returns a transparent local-rules
proposal so the UI path remains testable.

## Alerts and Toasts

Transient errors and command results are shown as a **toast stack anchored to
the bottom-right** (`.toast-stack` / `.toast`), not as a fixed-offset banner.
This was previously a `position: fixed; top: 202px` layer whose hardcoded offset
did not match the real command-bar height and floated over content; bottom-right
anchoring is stable regardless of how the header grid wraps or the body `zoom`.
Result/success toasts auto-dismiss after a few seconds; error toasts persist
until dismissed. Each toast carries an icon and an accessible dismiss button.
Setup-blocked actions route to the next setup surface instead of failing
silently: account blockers open Accounts, universe blockers open Settings.
Route/global error screens show the actual error message when available, and an
app-level browser listener surfaces uncaught runtime errors and unhandled promise
rejections as bottom-right error toasts.

As of 2026-06-27, recoverable broker/data fallbacks that would otherwise only
hit `console.warn` write throttled `recoverable_issue` audit rows and render in
Activity. This keeps resilience for transient broker/provider misses while
leaving a visible trail for later correction.
As of 2026-06-30, Robinhood quote-parameter validation errors are summarized as
plain broker-request issues in Activity instead of exposing schema-validator JSON
as the primary text.

## Accessibility

- All dialogs render through a single reusable `Modal` component. It provides
  `role="dialog"`, `aria-modal`, an `aria-label` from the title, focus-on-open
  with focus restoration on close, body scroll-lock, Escape-to-close (a
  document-level listener, so it works even if focus leaves the dialog), and
  backdrop-click-to-close. Size variants are `default`, `narrow` (confirmations),
  and `wide` (Strategy Studio).
- Tab groups use `role="tablist"`/`role="tab"` with `aria-selected`, roving
  `tabIndex`, and Left/Right arrow-key navigation.
- Icon-only buttons carry `aria-label`s; the command-bar layout dropdown exposes
  `aria-haspopup`/`aria-expanded` and closes on Escape.
- A global `:focus-visible` outline makes keyboard focus visible, and
  activity-feed detail rows expand on focus rather than hover-only.
- Small helper text and table-label contrast must meet normal-text readability
  because `text-faint` is used for real labels, not only decorative marks.

## Styling Conventions

Current cockpit styling lives primarily in `app/globals.css` and Tailwind 4
utility classes, with semantic CSS variables for surface, line, text, status,
and glass effects. Avoid reintroducing large inline style objects or per-component
rgba constants; add reusable variables/classes when a visual rule will be shared
across panels, feeds, popovers, or status chips.

## Display Semantics

- Sentiment values are displayed as explicit chips: `Positive`, `Neutral`, or
  `Negative` with the numeric score.
- Up/down arrows are avoided for sentiment because they look like price
  direction or a buy/sell signal.
- Top status values are kept visible in the command bar: Mock/Local/Live mode,
  autonomy/setup state, market session, daily risk, and allowed universe.
- Settings → Operate groups the tradable universe controls together: Indices
  (Guardrails → Universe, same name on iOS Guardrails and Desk) show the
  selected-set as common names (`S&P 500, Nasdaq Composite, Dow 30, NYSE
  Composite`, never `sp500, nasdaqComposite, dow30, nyseComposite`) plus
  multi-select toggles labeled the same way. iOS Home Desk is a heading plus
  the Coach / Scan / Guardrails / Results buttons — it does not repeat those
  four names as a subtitle.  Empty-universe copy on iOS Home / Insights points
  at Guardrails with the `S&P 500` example (web `/console/guardrails`); there
  is no iOS Strategy tab.  S&P 500 is selected by
  default, Additional Watchlist adds explicit tickers, and Ignore List subtracts
  symbols from the final universe. S&P 100 and S&P 500 are mutually exclusive;
  Nasdaq 100 and Nasdaq Composite are mutually exclusive. The backend normalizes
  those same families so API writes cannot persist both at once. Dynamic broad
  indexes show approximate counts because their constituents come from live
  holdings/screener feeds rather than embedded arrays. The backend runs a one-time migration for
  untouched empty default policies so existing local installs get the same S&P
  500 start state without repeatedly overriding later user edits. Additional
  Watchlist accepts quote-resolvable non-index U.S. equity/ETF tickers such as
  `SPCX`; newly added custom tickers are quote-checked before save and rejected
  with a ticker-specific explanation when no quote is available.
- Settings → Display includes a local ticker-logo preference: `Option 1` (tile),
  `Option 2` (transparent), or `Off`. The field hint explains the visual styles.
  Logos are loaded through the app's cached proxy for
  `davidepalazzo/ticker-logos`, and missing logos must fall back to text rather
  than blocking symbol navigation.
- Settings → Accounts distinguishes a stored Robinhood account row from an
  authenticated Robinhood MCP session. If `/api/broker/mcp/health` reports
  configured-but-unauthenticated, the Robinhood row shows `OAuth Needed` plus a
  Reconnect action instead of a plain `Connected` badge. As of 2026-06-27, the
  row warning copy is intentionally concise: `Robinhood needs to be reconnected.`
- The top readiness strip must use the server-provided selected-account
  readiness result, not only `policy.accountNumber`. A stored/backfilled account
  row may stay visible for management, but Account is not ready if broker
  OAuth is needed, selected-account enumeration fails, the selected
  account is absent from live broker results, the broker marks it non-agentic,
  or portfolio/balance data cannot be read.
- Standalone ticker text should use the shared clickable ticker treatment so
  hover/click styling and symbol drilldown are consistent in Market Scan,
  Macro movers/news, Smart Money, portfolio, tax, and proposal surfaces.
- Ticker drilldowns must prefer a full scan quote from `topCandidates` or
  `quotesBySymbol` and must preserve quote metadata when the symbol is not in
  the visible top-candidate table. Sparse/event-only symbols may open with a
  partial record, but the price header should never display `$0.00` for a
  missing quote.
- Settings → Data includes Market Scan candidate controls. `Candidate cap`
  controls how many ranked/enriched rows reach `marketScan.topCandidates` and
  the LLM prompt; `Outlier reserve` controls how many below-cutoff names with
  notable web/technical signals may replace lower-ranked plain candidates inside
  that cap. The Market Scan tab header includes a gauge button that opens
  Settings directly to this Data section, and the scan subtitle shows returned
  candidates against the active cap. Source subtitles are formatted through the
  shared dashboard helper so aliased providers dedupe before display, including
  `congress`/`congress.trade` to `Congress.Trade` and delayed Yahoo variants to
  `Yahoo Finance`.
- Settings → Connections owns provider/API keys and connection status context.
  Editable Green/Red Team model behavior belongs in Strategy Studio; Connections
  may show a read-only model summary and a link to Studio.
- Settings uses an explicit User/Account scope header with the account selector
  below it when Account scope is active. Review/tuning proposal actions should
  remain in Strategy Studio rather than appearing as bottom-right settings
  confirmation controls.
- Whole-row switches in Settings must look clickable: use hover/active/focus
  affordance when the entire row toggles a setting.
- The command-bar `Mode:` selector is approval mode, not run state. `Propose
  Mode` stages orders for approval; `Autonomous Mode` may execute while the
  system is running. Start/Stop controls whether scheduled/autonomous runs can
  place orders.
- `Run once` is a manual proposal check. It must work while the system is
  stopped and must force proposal-only behavior, so it never bypasses the
  Start/Stop gate for scheduled/autonomous execution.
- If pending proposals are visible while the mode selector says Autonomous Mode,
  the Decision tab must explain that they came from the manual/proposal-only Run
  once path; scheduled autonomous placement still requires Start and passing
  account/risk checks.
- Workspace and feed tabs persist in local storage so a browser refresh returns
  to the same tab/area instead of resetting the user to Decision/Activity.
- Headings and card titles use Title Case. Abbreviated data labels can stay
  compact, but every interactive control, column, and important data point
  should carry a tooltip or adjacent hint with a plain-English meaning.
- `Run during extended hours` means scheduled/event-triggered strategy runs may
  start during pre/post-market windows; it does not by itself permit
  extended-hours order placement, and dollar/fractional orders remain
  regular-hours only.
- The dashboard must never show `Autonomy On` when required setup is missing.
  Render `Setup Needed`, block Run/Resume, and route the user to Accounts or
  Settings.
- The Test/Paper/Brokerage execution banner is a safety control, not decoration.
  It may be compacted for density but must remain visible, with `role="status"`
  and reduced-motion-safe animation for Brokerage/live.
- Accounts rows should distinguish the user label from the execution environment:
  show the saved account label as the row title and Paper/Brokerage in supporting
  broker metadata.
- The cockpit should expose a compact readiness checklist for account, universe,
  risk caps, and selected broker/account readiness so setup blockers are
  actionable before the user clicks Run once or Start.
- Switching from Mock/Local to Live requires explicit confirmation and a visible
  warning that live mode can submit real broker orders.
- Approving a Brokerage/live proposal requires a typed server-validated
  confirmation payload tied to proposal id, account number, execution mode, and
  estimated notional. The current implementation uses a browser prompt; the next
  UI iteration should replace it with an in-app modal that shows the same fields.
- Account switching should always preserve a nearby management path. The
  command-bar account selector includes `Manage Accounts...` so an empty or
  incomplete account list does not strand the user away from Settings. The
  Settings modal also keeps a `Manage Accounts` header action beside the close
  button, and command-bar Mode/Account selectors should use matching typography
  without truncating `Autonomous Mode`.
- The Hide Test account preference filters inactive Test rows from both
  Settings -> Accounts and the command-bar selector; if Test is still active, it
  stays visible until the user switches away so the current execution mode is not
  hidden.
- Account rows should remain readable on narrow screens: stack account details
  above actions, make inactive `Use` the primary action, keep Edit/Remove as
  secondary actions, and visually anchor the active account with a subtle left
  accent rather than all-caps badges alone.
- Settings -> Data owns privacy, sharing, and destructive app-account actions.
  The app-account deletion procedure must be multi-step, must explain what the
  app can and cannot delete from Google/Apple/brokers, and must keep the final
  destructive button disabled until every acknowledgement and typed phrase is
  satisfied.
- Symbol drilldown factor values are normalized 0-100 **factor scores**, not
  signed contribution deltas. Avoid labeling that panel as a waterfall unless
  the UI is changed to show actual weighted contributions around a baseline.
- Symbol drilldown summary thresholds must use the same 0-100 scale; avoid
  calling weak evidence "AI conviction."

## Verification Expectations

After touching this phase, run:

```bash
npx tsc --noEmit
npm test
npm run build
```

For UI changes, also verify desktop and mobile behavior in a browser:

- desktop: body scroll height should equal viewport height
- mobile: shell overflow should become visible and page-level scrolling should
  return
