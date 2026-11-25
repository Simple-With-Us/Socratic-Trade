# ST-4687 iOS batch 3 — price alerts UI, TabPreferences @Observable, coach draft staging, charts overhaul, scan search/sort, typography twins

## 1. Context & Objective

ST-4687 is the third iOS child of the ST-4668 full-stack roadmap (owner approved the roadmap
and its OD recommendations Tue, Nov 24).  This batch delivers the six remaining iOS items the
reconciliation marked not-started: the P8 price-alert surface, the P1 TabPreferences
@Observable migration, the P2 acknowledgeNotifications local-patch remainder, the P11b Coach
draft -> proposal staging path, the P12 Swift Charts overhaul, and the scoped P13a/P13b
typography work.  It runs in parallel with other seats' pending PRs, so every shared-file edit
is the smallest contiguous hunk.

## 2. Changes Made

Single coherent iOS batch 3: alerts UI on the existing snapshot + command rails, the last
Combine ObservableObject store migrated to Observation, the web draft-staging bridge ported to
Swift, chart crosshairs moved onto `chartXSelection`, the scan list given the system search
field plus a client-side sort, and the type ramp given explicit Bold twins.

- `ios/SocraticTrade/PriceAlertsView.swift` (new) — `PriceAlertDirection` (Codable above/below
  with the server's alias table), `PriceAlertForm` (pure symbol/price validation +
  `alert.create` payload builder), `PriceAlertsCard` (per-symbol alert list from
  `snapshot.alerts`, armed-first sort, "Add Alert" row), `PriceAlertRow` (trash button +
  `swipeRevealAction` delete calling `alert.delete`), `PriceAlertCreateSheet` (ticker,
  direction, price, optional note; submits `alert.create` through `MobileStore.submit`).
- `ios/SocraticTrade/SymbolInfoSheet.swift` — one-line section insertion:
  `PriceAlertsCard(symbol: normalized)` inside the scroll column (:105).  No other hunk.
- `ios/SocraticTrade/MobileControlView.swift` — `TabPreferences` migrated from
  `ObservableObject` + five `@Published` to `@MainActor @Observable` (plain `private(set)
  var`s), `@StateObject` -> `@State` (:344), `MoreView` `@ObservedObject` -> plain `var`
  (:635), `import Observation` added.  Behavior identical; the file lives under its existing
  tab-bar contract.
- `ios/SocraticTrade/CoachDraftStaging.swift` (new) — `CoachDraftStaging.wirePayload(from:)`
  re-serializes a decoded `ChatDraft` into the snake_case shape
  `chatDraftToProposal` (src/lib/chat/promote-draft.ts) parses; `userFacingMessage(for:)`
  maps the route's error codes to sentence-case copy; `CoachDraftStageButton` posts it
  (`dryRun: false`), shows an inline success line and inline error copy, then reloads the
  snapshot so the Proposals badge picks the row up.
- `ios/SocraticTrade/CoachView.swift` — one-hunk change in `CoachDraftCard`: stale
  "no path from iOS" comment replaced, `CoachDraftStageButton(draft: draft)` added (:347).
  Approval stays in the Proposals list.
- `ios/SocraticTrade/MobileAPIClient.swift` — `stageDraftAsProposal(draft:)` POST helper
  (:506) + private `FromDraftResponse` (:917).
- `ios/SocraticTrade/MobileStore.swift` — one-hunk `stageDraftAsProposal(_:)` passthrough
  (:1588), same shape as the existing `fetchSymbolDesk` passthroughs.
- `ios/SocraticTrade/ChartDateParsing.swift` (new) — `PlottedChartPoint` (parsed x-value +
  raw label + optional delta) and `ChartDateParsing` (ISO-8601 with/without fractional
  seconds, `yyyy-MM-dd` day keys as UTC midnight; `chartPoints(from:)` for both series
  shapes; `nearest(_:to:)` selection match).  The wire models stay untouched.
- `ios/SocraticTrade/AppComponents.swift` — `EquityChartView` and `BenchmarkCompareChart`
  (the file's whole chart area, :1700-end): `.chartOverlay` + `DragGesture(minimumDistance:
  0)` crosshairs replaced by `.chartXSelection(value:)` bound to `Date?`; series parsed once
  in `init` via `ChartDateParsing`; `.chartYScale(domain: .automatic(includesZero: false))`
  added (both charts are line/area, and money curves anchored at zero were the flat line);
  selection readouts keep the existing label style and gain a signed delta line — return
  sign for equity points, dollar spread vs the benchmark for the compare chart; positive/
  negative sign colors on the readout only, line colors keep the `isLive` semantics.
  MetricTile value text gains `.monospacedDigit()` (:427, :438).
- `ios/SocraticTrade/AppTypography.swift` — explicit Bold twins for the whole ramp (:113-131:
  `appLargeTitleBold` … `appCaption2Bold`, `appHeadlineBold` alias, `appMetricBold`), each
  naming `AppFont.bold` at the regular token's size/relativeTo.  No call sites changed.
- `ios/SocraticTrade/ScanView.swift` — in-card filter `TextField` replaced by
  `.searchable(text:placement:.navigationBarDrawer(prompt:))` on the NavigationStack-backed
  root (:30, placeholder copy kept); new compact sort `Menu` in the toolbar
  (Default/Price/Symbol) over `ScanSortOption` + pure `ScanRowSorter` (:419, :436) — price
  desc with nil-quote rows last and a symbol tie-break, `.ranked` leaves server order
  untouched; `digest.overlap` (decoded but previously unrendered) now shows as one
  sentence-case line in the Weekly Screens card (:149, `WeeklyScreensCopy` :456).
- Tests: `ios/SocraticTradeTests/TabPreferencesTests.swift` — `import Observation` +
  `testTogglePublishesThroughObservation` pinning the @Observable contract (existing
  accessor usage is identical under Observation, so nothing else moved).
  New `PriceAlertsFormTests.swift` (symbol non-empty, price > 0, direction Codable
  round-trip + alias table, payload shape), `CoachDraftStagingTests.swift` (snake_case wire
  keys pinned against a decoded sample draft, JSON-serializability, error-code copy),
  `ScanSortTests.swift` (sort helper + overlap line), `ChartDateParsingTests.swift` (format
  acceptance, delta preference, drop-on-garbage, nearest-selection).  All deterministic —
  fixed strings only, nothing compares against `Date()`.

## 3. Decisions & Trade-offs

- Alerts entry point: SymbolInfoSheet section (smallest insertion — one line) instead of a
  MarketsView toolbar; alerts are per-symbol, so they belong beside the symbol.
- Alert delete has both a visible trash button and the swipe path (mirrors the order-cancel
  row: the swipe is a faster path to an existing action, never a new confirmation class).
  No confirmation dialog — an alert is trivially re-creatable.
- Charts bind `chartXSelection` to the parsed `Date` and resolve the nearest plotted point,
  rather than the prior exact-string lookup; unparseable dates drop their point (a mixed
  garbage series degrades to the same empty card the app shows for no history) instead of
  keeping the categorical string axis.  Deployment target is iOS 18 (`ios/project.yml`), so
  the iOS 17 selection API is used directly — no `if #available` needed.
- After a drag the selection now PERSISTS (standard `chartXSelection` behavior) instead of
  clearing on touch-up.  Chosen deliberately: it matches every other iOS 17 Charts app and
  keeps the readout legible; the old gesture hack cleared because it was hand-rolled.
- Item 3 (acknowledgeNotifications local patch) SKIPPED — see section 5.
- Typography is additive only (constants + MetricTile digits); the repo-wide call-site sweep
  is deliberately NOT part of this task (Next Steps).
- TabPreferences stays defined inside MobileControlView.swift (where it lives today) rather
  than being moved to a new file: the task demanded the minimal diff, and the tests keep
  compiling unchanged except for the new Observation pin.
- Light theme, Title Case headings/buttons, sentence-case values, and `"\u{00A0} "` gaps in
  all new Swift string literals per the fleet copy rules.

## 4. Verification State

NOTHING WAS COMPILED OR TESTED LOCALLY: this is a Linux seat.  Swift compilation and XCTest for
every file above are gated by the hosted `verify-ios` job (GitHub-hosted `macos-latest`,
unsigned xcodebuild + simulator XCTest) after the lead pushes.  Local verification performed:

- Symbol-by-symbol declaration checks against `MobileStore.submit/isBusy/canSubmit/load`,
  `MobileAPIClient` private helpers, `StatusPill`/`AppCard`/`SectionHeading`/`InlineErrorBanner`/
  `swipeRevealAction` signatures in AppComponents.swift, `EquityCurvePoint`/`PriceAlert`/
  `WeeklyMarketDigest`/`ChatDraft`/`ScanCandidate` fields in the model files, and the server
  contracts in `src/lib/mobile-api.ts`, `src/lib/alerts.ts`, `src/lib/chat/promote-draft.ts`,
  and `app/api/proposals/from-draft/route.ts`.
- `git diff` reviewed hunk-by-hunk; brace/paren/bracket balance checked per file (all zero);
  the two pre-existing chart structs confirmed replaced in full (file tail intact, call sites
  in HomeView/ResultsView unchanged).
- Copy lint by eye: no `/api/...` routes or dotted command ids in user-facing strings
  (UserFacingCopyTests' forbidden classes).

## 5. Zero-Code Findings (item 3 skipped, with the reason)

`acknowledgeNotifications` (MobileStore.swift:1649) still does a full `load()` after the ack
POST, and event-typed `mobile.command` stream events still route through the 2s-throttled
full reload (`streamEventNeedsSnapshot` :1420, `scheduleReload` :1909).  A genuine optimistic
local patch is NOT possible without restructuring the snapshot, which this task forbids:

1. The badge is not stored anywhere — it is derived: `unreadNotificationCount` counts
  `notifications.filter { !$0.read }` (MobileModels.swift:211), Activity rows render
  `item.read`, and `NotificationHistoryItem.read` is a `let` on a Decodable-only struct with
  no memberwise init.
2. The "overlay/partial-update mechanism the SSE coalescing already uses" does not exist for
  snapshot data: SSE coalescing is purely TIME (scheduleReload + pendingReloadEventAt + a
  2s `reloadThrottleInterval`) and always ends in a full `load()`. `reconcileTrackedCommands`
  patches a separate command-status dict, never snapshot fields.
3. `MobileSnapshot` has ~20 `let` fields and a custom decoder init only — producing a patched
  snapshot requires either mutating wire models or a new parallel override store threaded
  through every unread/read consumer (MobileControlView badges, AppComponents bell,
  ActivityView rows).  That is exactly the cache restructure the task scoped out.

Follow-up needs: introduce an explicit optimistic-notification-set (or make the unread badge
a first-class @Observable store field decoupled from the snapshot), route the badge readers
through it, and drop the `load()` from the ack path to a throttled background refresh.  The
event-typed `mobile.command` reload stays correct but costs one snapshot fetch per command —
acceptable until the same refactor lands.

## 6. Next Steps & Blockers

- Lead pushes; hosted `verify-ios` (compile + XCTest) is the gate.  Compile-risk notes live in
  the lane report (chartXSelection availability, WithObservation sync-delivery assumption in
  the new TabPreferences test).
- Deliberately NOT done here: the repo-wide `.weight(.bold)` -> bold-token sweep (P13a
  follow-up), an alert-count chip on watchlist chips, moving TabPreferences into its own
  file, and the item-3 restructure above.
- No blockers: nothing in this batch depends on other pending PRs beyond region isolation.
