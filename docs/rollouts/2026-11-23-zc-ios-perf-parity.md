# ZC iOS perf parity — stream refresh, cold start, account switcher, one badge destination

Seat ZC · lane `zc-ios-perf-parity` · branch `zc/4639-ios-perf-parity` · 2026-11-23

## 1. Context & Objective

The 2026-11-21 iOS audits (`docs/audits/2026-11-21-zc-ios-perf.md`, `docs/audits/2026-11-21-zc-ios-ux.md`) found four client-side problems worth fixing without a server change: the SSE reader published a store change on every received line (including the 25 s heartbeats), every stream event triggered a full `/api/mobile/snapshot` download, a signed-out cold start waited on a snapshot probe that could only 401, and the native app had no reachable account switcher while its two unread badges pointed at different surfaces.

This lane implements the client half of ST-4639, ST-4640 and ST-4645. The server half of the fill-ledger bound (an optional new payload field) belongs to a parallel backend lane, so every change here works the same whether or not that field exists.  No money-path code (risk, order construction, P&L) was touched, and the account picker reuses the existing `account.activate` command rather than adding a new one.

## 2. Changes Made

### 2.1 The stream reader no longer publishes per line (ST-4639a, audit O2)

- `ios/SocraticTrade/MobileAPIClient.swift`: `events(onConnect:onEvent:)` now fires `onConnect` ONCE, when the stream response is established.  The per-line call is gone; it existed only so a healthy idle stream could flip the connected indicator (#2559), and establishment already proves the stream is open.  `onEvent` now carries the frame's event name.
- `SSEFrameAccumulator` returns an `SSEFrame` (with `eventName`) instead of a bare `Bool`, so the client can tell a `dashboard.order` from a `dashboard.chat-turn`.  Comment frames (`: ping`, `: connected`) still never produce a frame.
- `ios/SocraticTrade/MobileStore.swift`: `markStreamConnected()` / `markStreamDisconnected()` publish only on a real transition.  `@Published` fires `objectWillChange` on every assignment, including one that writes the value the property already holds, so the old unconditional `isStreamConnected = true` re-rendered every store-observing view on every received line.

### 2.2 Stream events cost one snapshot download, not one per event (ST-4640 client half, audit N1)

- `scheduleReload()` is now a throttle with a trailing edge: at most one coalesced refresh per 2 s, with the newest event in a burst honoured.  A burst of N events therefore costs ONE download instead of N.  A pure debounce was rejected because a continuous event stream (fills during a run) would starve the refresh forever.
- `performScheduledReload()` skips the refresh when a fetch that STARTED after the event arrived already carries that event's effect (the server had changed state before it emitted the event).
- A refresh waits for an in-flight load (a command's own refresh, a pull-to-refresh) instead of downloading a second snapshot beside it.
- `handleStreamEvent(_:)` filters by event kind.  `dashboard.chat-turn` and `dashboard.pending-learned-change` change nothing the app renders (the Coach transcript has its own transport; the learning queue is not in the snapshot), so they cost no download.  Every other event, including an unknown name, still refreshes.

### 2.3 Cold start (audit S1, S2, S3)

- `ios/SocraticTrade/SocraticTradeApp.swift`: a signed-out cold start no longer waits on the snapshot probe.  With no session cookie there is nothing to fetch, so the login screen appears immediately instead of after a 401 round trip (45 s timeout x 2 plus backoff, up to ~95 s of splash).
- The cached snapshot is decoded OFF the main actor (`restoreCachedSnapshotIfNeeded()`), once.  The launch path used to decode it synchronously at init and again during session restore.
- `SnapshotCache` (new, in `MobileStore.swift`) keeps the cached payload in a FILE under Application Support instead of a `UserDefaults` blob.  The payload carries the fill ledger, the notification inbox and the equity curve, and UserDefaults carries every value it holds on every launch.  Only the small "when was it saved" stamp stays in UserDefaults.  Application Support rather than Caches on purpose: the warm-launch path uses "a cache exists" to decide the session is worth restoring, and the system may purge Caches.

### 2.4 One canonical destination for the unread badge (audit W3)

- The toolbar bell on every tab now routes to the Alert Center (Activity → Alerts Center) through a new `openAlertCenter` environment action, instead of opening a separate notification inbox sheet.  The Activity tab badge counts the same unread notifications and lands on the same surface.
- The now-unused notification inbox sheet (`NotificationsInboxView`, `NotificationHistorySection`, `NotificationHistoryFilter`) was deleted; the Alert Center renders the same rows with the Attention/Deliveries/Approvals filters and is the richer surface.
- The website console is being aligned to the same destination by a parallel web lane, so both apps point at the Alert Center.

### 2.5 Native account switcher (audit N2)

- `ios/SocraticTrade/HomeView.swift`: the Home hero shows a compact account picker (`AccountSwitcherMenu`) when more than one account is connected.  The label is the account label plus the last four of the account number ("Alpaca Paper — MFK9"), matching the website console's scope picker.
- The picker and the Account & Settings rows share one path: `MobileStore.activateAccount(_:)` issues the same `account.activate` command with the same operation id, so the busy handling and the post-switch snapshot reload are identical.

### 2.6 Files touched

- `ios/SocraticTrade/MobileAPIClient.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/SocraticTradeApp.swift`
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `ios/SocraticTradeTests/AccountScopeAndMoneyActionTests.swift`
- `ios/SocraticTradeTests/MobileAPIClientRetryTests.swift`
- `ios/SocraticTradeTests/MobileAPITransportTimeoutRetryTests.swift`
- `ios/SocraticTradeTests/MobileSessionHardeningTests.swift`
- `ios/SocraticTradeTests/MobileStreamRefreshPolicyTests.swift` (new)

### 2.7 Review round (Kody + Seer)

The first hosted review round produced six actionable findings and one declined with a reason.

- **The legacy `UserDefaults` blob was never cleared (Seer, Kody).** An upgraded install kept the whole snapshot in a plist forever.  `SnapshotCache` now migrates the old blob into the file once at launch and deletes the key, and both `save` and `remove` clear it.
- **`stopEvents` left the refresh machinery alive (Seer, Kody).** The in-flight refresh task and the pending flags are now cancelled and cleared with the stream, so a sign-out cannot fetch a snapshot for a session that is gone.
- **The cache file read still ran on the main actor (Kody).** The file read AND the decode now both happen inside the detached task, so neither blocks the first frame.
- **`hasSuffix` over-matched event names (Kody).** The two non-rendering event names are now matched exactly (`chat-turn` and `dashboard.chat-turn`, `pending-learned-change` and `dashboard.pending-learned-change`), so a future event that merely ends the same way is never silently skipped.
- **A test leaked the seeded timestamp key (Kody, high).** The defer now clears it alongside the scratch file.
- **The cache write stays ordered with the sign-out removal.** `SnapshotCache.save` writes the file on the calling actor, so a cache can never be written back after a sign-out wiped it, and the legacy-key removal inside `save`/`remove` is guarded by an existence check so a normal refresh no longer dirties the UserDefaults plist.
- **The launch path skipped the Keychain restore retry (Seer).** A transient restore failure (the device was locked) clears the in-memory cookies, so the new "no session cookie, skip the probe" guard signed the user out for good.  The guard now also asks the store whether a restore is still pending, because `load()` is where that retry lives.
- **A decode that landed after a sign-out could repopulate the store (Seer).** The off-main decode now carries the session epoch it started under and is discarded when the session changed.
- **A switch the server never confirms left the picker disabled (Kody, high).** A pending account switch now gives up after 20 s and clears itself, so a draining account that can never become active cannot lock the picker.
- **An `event:`-only SSE frame triggered a refresh (Kody).** Only a `data:` line marks a payload now; the event name is carried separately.
- **The cache write stalled the main actor (Kody, performance).** The atomic write of the whole payload now runs off the main actor, guarded by a generation counter: a write that lands after a sign-out or an account switch is deleted instead of kept, so a cache can never outlive its session.
- **A transient read error deleted a valid cache (Kody, medium).** The cache read now reports WHAT happened: decoded, corrupt (the file was there but did not decode), or unreadable (nothing to read, or a transient I/O error).  Only a corrupt file is self-healed; an unreadable file is left alone.
- **The legacy migration blocked the cold start (Kody, medium, performance).** The one-time migration now runs off the main actor, and the launch flag counts the legacy blob as a cache until the file lands.  The restore path reads the legacy blob directly if the file is not there yet, so the two cannot race.
- **A dropped corrupt cache left a stale "last updated" stamp (Kody, medium).** `lastUpdatedAt` is cleared with the file.
- **Three more findings from the migration review (Kody, high and two medium).** The corrupt-file self-heal no longer invalidates a concurrent valid save (it removes the file without bumping the generation); the pending-switch timeout is cancelled with the session it belongs to, so it cannot wake during a later switch and clear it; and the legacy migration only drops the legacy copy once the file proves decodable, so a corrupt file leaves the recoverable copy in place.
- **The legacy migration could resurrect a signed-out snapshot (Kody, medium, security).** The migration now carries the session generation it was queued under and aborts when the session changed, so a sign-out that lands while the migration waits cannot be undone by it.
- **Two races in the off-main cache write (Kody, high and medium).** The cache writes are now serialized on one chain, so the stale-generation check and the delete always run against the write they belong to and an older write can never destroy a newer one.  The one-time legacy migration joins the same chain and re-checks the destination immediately before its write, so a save that landed in between is not clobbered.
- **The legacy blob could be dropped before the file write succeeded (Kody, high, twice).** The legacy key is now removed only after a successful write, in both `save` and the one-time migration, so a failed write never destroys the last copy of the snapshot.  The migration also leaves the legacy blob alone when the write fails.
- **A corrupt cache file could mark the session authenticated (Kody, declined with a reason).** The live session cookie is the authentication authority, not the display cache: the cookie decides the session and the network load is the source of truth, so a corrupt cache cannot sign the user into a wrong state.  The cache file is now self-healing anyway: a file that fails to decode is deleted on the restore attempt, so the next launch starts clean.

## 3. Decisions & Trade-offs

- **The `onConnect` callback lost its per-line firing.** #2559 needed the connected indicator to be truthful on a healthy idle stream, and the establishment call already provides that.  The per-line call was pure churn, but it is a behavior change on a shared path, so it is called out here.
- **Throttle, not debounce.** A trailing debounce of 2-5 s would never fire during a busy run (fills arrive faster than the window), so the snapshot would freeze exactly when the user is watching.  The throttle refreshes once per interval and honours the newest event in the window.
- **A fetch that started after the event counts as covering it.** This is the sound rule (the server had already applied the change when it emitted the event).  The cost is that an approve can still cost two downloads when its own refresh started before the event arrived; the old code cost about three.
- **The signed-out skip lives in the app bootstrap, not in `load()`.** `load()` is also the authenticated refresh path, and moving the check inside it would change the meaning of every call site.  The app knows whether this launch is a first, signed-out launch; the store does not.
- **The Activity tab keeps its last-chosen section.** The bell always lands on the Alert Center; the Activity tab keeps the section the user last chose, because resetting it on every tab switch is a regression the web console does not have either.
- **No `@Observable` migration in this PR.** `MobileStore` is still an `ObservableObject` with its `@Published` properties, which violates `ios/CLAUDE.md:54`.  Migrating it touches 44 environment-object sites across 17 files and every injection point, and a missed site is a runtime crash (not a compile error) on that screen.  Swift compiles only in CI here, so a half-migrated store that breaks the app is a worse outcome than a documented deferral.  It is tracked as a follow-up below.
- **The notification inbox was deleted rather than kept as a second destination.** Keeping it would have preserved the exact problem W3 describes: two badges, two surfaces.

## 4. Verification State

Swift compiles only on the hosted `ios-build` job, so the local gate is the TypeScript one plus a careful read.

- `git diff --stat` — 13 files, all under `ios/**`.
- Brace/paren balance checked on every changed Swift file (the only imbalance is pre-existing, from JSON literals in the test fixtures).
- Every changed symbol checked for collisions: `SnapshotCache`, `SSEFrame`, `openAlertCenter`, `AccountSwitcherMenu`, `activateAccount`, `hasSessionCookie`, `markInitializedSignedOut`, `restoreCachedSnapshotIfNeeded`, `streamEventNeedsSnapshot`.
- New tests: `ios/SocraticTradeTests/MobileStreamRefreshPolicyTests.swift` covers the event policy (what refreshes, what does not, and that an unknown event name still refreshes), the file cache round trip, the off-main decode, and the signed-out cold start.
- Updated tests: the SSE accumulator test now asserts the event names; the four snapshot-cache tests now use a scratch file; the sign-out and account-switch tests now assert the cache FILE is removed.
- `npx tsc --noEmit`, `npm test`, `npm run build`: not run, because this branch touches no TypeScript.
- **Final CI: green.** The hosted `ios-build` job (unsigned build + simulator XCTest) is GREEN on the final head `ad5e0551` of PR #5451, and GREEN on `c623a09b` of PR #5452 (the @Observable migration).  The hosted Kody review and the Seer review both ran on every head; every actionable finding is fixed in a follow-up commit and the one declined finding carries a written reason.
- The compile gate is the hosted `ios-build` job on this PR; see "Next Steps".
- The first hosted `ios-build` run failed on one line: `MobileStore.swift:644` — `error: 'nil' requires a contextual type`.  The `Task.detached` closure that now reads AND decodes the cache file has two statements, so Swift could not infer its result type from the body and fell back to the synchronous `Task.detached` overload.  The fix is an explicit `() -> MobileSnapshot?` on the closure.  That was the only compile error in the run; every other file in the batch compiled.
- Review round: the hosted Kody review and the Seer review both ran on the PR head; every actionable finding is fixed in the follow-up commit and the one declined finding carries a written reason.

## 5. Next Steps & Blockers

- **ST-4639 (`@Observable` migration) is deferred, not done.** The per-line publish is fixed in this PR; the store is still an `ObservableObject`.  The migration needs every one of the 44 `@EnvironmentObject private var store: MobileStore` sites (17 files) plus every `.environmentObject(store)` injection point (the app, the consent sheet, the preview) moved to `@Environment(MobileStore.self)` and `.environment(store)`, and the `MobileStore` class and its `@Published` block converted.  A missed site compiles fine and crashes at runtime on that screen, so it must land as its own PR with the hosted `ios-build` job as the gate.  This lane did not attempt it because it cannot be verified locally.
- **ST-4640 server half**: the unbounded fill ledger in the snapshot payload is a backend change (a parallel lane owns it).  The client here is defensive: it does not assume any new payload field exists.
- **ST-4645**: the native half (account picker, one badge destination) is done.  If the web lane lands the Alert Center destination, both apps point at the same place.
- The `ActivityView` sheet deletion removes the "Mark All Read" over ALL unread rows from the bell (the Alert Center still has Mark All Read for the Attention filter, and Activity → Notifications still lists every row).

A fourth Kody round on the final head raised two more findings; both are real races and both are fixed (see the PR for the replies):

- The legacy migration's re-check branch dropped the `UserDefaults` legacy blob without proving the file it keeps decodes.  The same decodable-only contract as the primary branch now applies there: a corrupt or unreadable file leaves the legacy copy in place for `read()`'s fallback.
- The corrupt-cache self-heal deleted the file unconditionally off the write chain, so a valid save landing between the read and the delete was destroyed by the heal.  The self-heal now joins the serialized write chain (`SnapshotCache.removeCorruptSelfHeal()`), re-checks the session generation, and deletes only when the file still exists AND still fails to decode; the timestamp is cleared with the file.

Kody's fifth round revised the self-heal once more, correctly: the corrupt branch cleared the store's cache flags synchronously while the heal can still abort and KEEP the file (a valid save landed ahead on the chain, or a transient read).  `removeCorruptSelfHeal()` now returns whether the file was actually deleted, and the store awaits it, clearing `hasCachedSnapshot`/`lastUpdatedAt` only on a confirmed deletion — so the UI's cache flags stay truthful about whatever remains on disk.

Kody's sixth round (LOW, on the migration PR — fixed here too so both branches stay identical) caught that `read()` only consulted the pre-migration legacy blob when NO cache file existed, so the copy the migration deliberately retains behind a corrupt/unreadable file sat unreachable in the plist.  `read()` now consults the legacy blob on corrupt and unreadable outcomes as well, which makes the decodable-only retention contract true as written; the corrupt file itself is still self-healed (or overwritten by the next save) exactly as before.

Kody's seventh round revised the sixth-round fix, correctly: serving the legacy blob as `.decoded` hid the `.corrupt` outcome, so the self-heal never ran and the known-bad file survived launch after launch.  The corrupt-file fallback now serves the legacy snapshot AND schedules `removeCorruptSelfHeal()` (which re-validates before deleting; a concurrent fresh save still wins).  The transient-read path still never heals — an unreadable file is not known-bad.

## 6. Zero-Code Findings

- The SSE reader's per-line `onConnect` was the amplifier behind the whole-tree re-render: the store is an `ObservableObject`, so `@Published` publishes on every assignment, and the app has 44 environment-object readers of that store.
- The event-name mapping on the wire is `ready`, `mobile.command` and `dashboard.<type>`, where `<type>` is one of `run-complete`, `proposal`, `order`, `market-data`, `dirty`, `pending-learned-change`, `chat-turn`.  The client now keys its refresh policy off those names.
- `dashboard.dirty` and `dashboard.market-data` are emitted WITHOUT a `userId`, so every subscriber receives them.  They are regime and market-data changes, both of which change what the phone renders, so they still trigger a coalesced refresh.
- The website console's scope picker orders the menu with the active account first and shows the last four of the account number; the native picker copies both.
