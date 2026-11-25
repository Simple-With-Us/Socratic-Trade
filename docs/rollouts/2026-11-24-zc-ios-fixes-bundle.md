# ZC iOS fixes bundle — ST-4669 (OpenRouter availability, order identity, shared decoder, logo cache, coach polish, layout smalls)

Seat ZC · lane `zc-4669-ios-fixes-bundle` · branch `zc/4669-ios-fixes-bundle` · 2026-11-24

## 1. Context & Objective

ST-4669 (child of ST-4668) bundles twelve small iOS correctness, performance, and layout fixes from the 2026-11-21 audit follow-up.  The goal is native parity with the web console on model availability and citations, two bug fixes (order row identity, per-decode allocation), and the small layout debts, without touching the server or the wire format.

## 2. Changes Made

Twelve items, each kept minimal and idiomatic:

- `ios/SocraticTrade/DeskModels.swift` — `CoachModelCatalog.isAvailable`/`firstAvailable` accept the server's `openrouter` flag (item 1); `ChatTurn.citations` is now `[ChatCitation]` with a string-array fallback, and `ChatCitation` gains a memberwise init (item 6)
- `ios/SocraticTrade/CoachView.swift` — draft card dismiss control (item 5); citations render as `Link`s (item 6); transcript `.textSelection(.enabled)` and `.scrollDismissesKeyboard(.interactively)` (item 7)
- `ios/SocraticTrade/MarketsView.swift` — order rows keyed `order-<id>`; deep-link scroll target mapped to the first order for the symbol, else the watchlist chip (item 2)
- `ios/SocraticTrade/MobileAPIClient.swift` — new `MobileJSON.decoder` shared static; five decode sites use it (item 3)
- `ios/SocraticTrade/MobileStore.swift` — `SnapshotCache.decode` uses the shared decoder (item 3)
- `ios/SocraticTrade/AppComponents.swift` — `TickerLogoLoader` (NSCache + in-flight dedupe) behind `TickerLogo` (item 4); `AppFormat.date` made internal and `AppFormat.dayHeading` added for item 9
- `ios/SocraticTrade/SocraticTradeApp.swift` — `LegalConsentSheet` text scrolls; accept button pinned (item 8)
- `ios/SocraticTrade/AuditDayGrouping.swift` — new pure day-grouping helper (item 9)
- `ios/SocraticTrade/ActivityView.swift` — Audit Log renders day groups with `SectionHeading` headers; `StrategyRunRow` reads the shared run helper (items 9, 12)
- `ios/SocraticTrade/StrategyRunSummary.swift` — new shared run status/tone/count helper (item 12)
- `ios/SocraticTrade/HomeView.swift` — `LatestStrategyRunCard` after Schedule (item 12)
- `ios/SocraticTrade/SymbolInfoSheet.swift` — `SymbolInfoHeaderCard` moved to the top of the sheet (item 11)
- `ios/SocraticTrade/ControlBriefCard.swift` — deleted; grep confirmed zero references under `ios/` (item 10)
- `ios/SocraticTradeTests/DeskModelsTests.swift` — OpenRouter availability and citation-shape tests; one existing assertion updated to `.map(\.source)`
- `ios/SocraticTradeTests/AuditDayGroupingTests.swift` — new
- `ios/SocraticTradeTests/StrategyRunSummaryTests.swift` — new

## 3. Decisions & Trade-offs

- OpenRouter rule mirrors the web assistant's `chatCredentialServiceForModel`: a connected OpenRouter key makes every curated option available, because the server routes all four through OpenRouter first and none is `openRouterOnly`.  Native-key behavior is unchanged, and an empty provider map still yields no `firstAvailable` (the picker's existing `!providers.isEmpty` guard remains the fail-open path while status loads).
- Order rows are keyed per order (`order-<id>`), not per symbol, so two orders for one symbol keep distinct identities.  The scaffold scroll key is mapped in `MarketsView`: first order for the focused symbol when one exists, else the bare-symbol watchlist chip id, so scroll-to-symbol keeps working.
- One shared decoder is correct because every cache and client decode path uses the default configuration (no date or key strategy anywhere on those paths).  `SessionKeychain`'s iso8601-configured decoder is a different configuration and stays untouched, as do the preview/update-prompt decoders outside the named scope.
- `TickerLogoLoader` is a `@MainActor` class with `static let shared`, mirroring `AppleSignInCoordinator`, `WebAuthSessionManager`, and `PushNotificationCoordinator` in this app; no `nonisolated(unsafe)` or `@unchecked Sendable` was needed.  Failures are not cached, so a later appearance retries, matching `AsyncImage`; the placeholder, size, shape, and monogram fallback are unchanged.
- Citation decode accepts both wire shapes (objects first, strings fallback), keeping old history turns renderable.  The model change is contained to `DeskModels.swift`, `CoachView.swift`, and `DeskModelsTests.swift`; no server or wire change.
- Day grouping uses `Calendar.current` by default (injectable for tests), matching the device-local row timestamps; the app pins Central only for the explicitly labeled `dateTimeCentral` quote stamp, not for these rows.  Items with no parseable timestamp collect into one trailing group headed "Undated" instead of being dropped.
- Home's latest run trusts the server's newest-first `strategyRuns` order, the same contract `StrategyRunsSection` renders; no client re-sort was added.  The card reuses `StrategyRunSummary` (extracted from the Activity row) and the existing `AppCard`/`SectionHeading`/`StatusPill` components.

## 4. Verification State

Swift was NOT compiled locally and no test was executed locally.  This lane runs on Linux, where the repo forbids local `xcodebuild`; the hosted `verify-ios` job (`.github/workflows/ios-build.yml`, GitHub-hosted `macos-latest`) is the compile and XCTest gate once the lead pushes.  Commands run here were reference and byte checks only: `grep -rn 'ControlBriefCard' ios/` (zero external references before deletion), a decoder-configuration grep across `ios/SocraticTrade/*.swift`, `git diff` review of every edited region, and `grep -c $'\xc2\xa0'` on both doc files.  Every edited region was re-read against the declarations it uses (`StatusPill`, `SectionHeading`, `AppCard`, `SymbolInfoHeaderCard`, `EquityOrder`, `StrategyRunItem`, `ActivityAuditItem`, `ChatCitation`).

## 5. Next Steps & Blockers

The lead pushes `zc/4669-ios-fixes-bundle` and opens the PR (`Fixes ST-4669`); `verify-ios` must compile and pass the new XCTest cases before merge.  No owner decision is blocked and no server, wire, or project-file change is needed (sources compile by folder glob).

## 6. Zero-Code Findings

None.
