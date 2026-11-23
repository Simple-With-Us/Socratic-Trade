# ZC iOS — MobileStore migrated to @Observable

Seat ZC · lane `zc-ios-perf-parity` · branch `zc/4639-ios-observable` · 2026-11-23

## 1. Context & Objective

`ios/CLAUDE.md:54` says: `@Observable` + `@MainActor` on stores, never `ObservableObject`.  `MobileStore` was the last store in the app that broke that rule: an `ObservableObject` with 24 `@Published` properties, which means every store change invalidated every view that reads the store, and every view read the store.

This is the second half of ST-4639. The first half (the per-line publish from the SSE reader) is PR #5451; this PR is the enabling fix the 2026-11-21 audit calls its top priority (`docs/audits/2026-11-21-zc-ios-perf.md`, finding O1).

## 2. Changes Made

- `ios/SocraticTrade/MobileStore.swift`: the class is now `@MainActor @Observable`.  The 24 `@Published` wrappers are gone (the macro tracks the property itself) and `import Combine` gave way to `import Observation`.  The bookkeeping that no view body reads (the event task, the refresh flags, the load generation, the command tracker, the Keychain restore state, the test seams) is marked `@ObservationIgnored`, following the pattern `AppLockController` already uses in this repo.
- 40 read sites across 17 files moved from `@EnvironmentObject private var store: MobileStore` to `@Environment(MobileStore.self) private var store`.
- The four injection points moved from `.environmentObject(store)` to `.environment(store)`: the app root, the consent sheet, and the two DEBUG previews.
- `ios/SocraticTrade/SocraticTradeApp.swift`: the app holds the store in `@State` instead of `@StateObject` (the `@Observable` equivalent).

## 3. Decisions & Trade-offs

- **Everything was enumerated by reading, not by guessing.** The greps for `@Published`, `objectWillChange`, `ObservableObject`, `@ObservedObject`, `@StateObject`, `.publisher`, `send(` and `willSet` came back with 40 store read sites, 4 store injection points, one `@StateObject` and no `objectWillChange`, `willSet` or Combine usage on the store.  `TabPreferences` and `PushNotificationCoordinator` stay `ObservableObject`: they are separate classes with their own `@ObservedObject` / `@StateObject` users and they are not what the audit flagged.
- **A missed injection point is the one failure mode a compiler cannot catch** (a view that reads the store without one crashes at runtime, not at build time).  There are only four injection points and all four are converted, and every screen in the app is under the app-root injection, so the risk is enumerated rather than open.
- **The store's public API did not change.** The commands, the load path and the tests are untouched; this is a change to how the store publishes, not to what it does.
- **The money path was not touched.** Risk, order construction and P&L are not in this diff.

## 4. Verification State

- `grep -rn "@EnvironmentObject" ios/` returns one line, the `PushNotificationCoordinator` (an `ObservableObject` that stays one).  `grep -rn "\.environmentObject(" ios/` returns one line, the same coordinator.
- `grep -rn "@Published" ios/SocraticTrade/MobileStore.swift` returns only a doc comment.
- Swift compiles only on the hosted `ios-build` job, so the compile gate for this diff is CI on the PR.  No local `xcodebuild` was run.

## 5. Next Steps & Blockers

- This PR is stacked on `zc/4639-ios-perf-parity` (PR #5451): it must land after it, because both touch `MobileStore.swift`.  The base branch of this PR is the first PR's branch, so the diff here is only the migration.
- The hosted `ios-build` job is the compile gate.
- The hosted `ios-build` job (unsigned build + simulator XCTest) is GREEN on the final head `c623a09b` of PR #5452, which carries this migration on top of PR #5451's commits.  A device pass is still worth doing before the next TestFlight: the observable behaviour that CI cannot check is that every screen re-renders when it should (the Activity list on a snapshot refresh, the proposal cards on a command, the tab badges on an unread count).

A follow-up review round raised one finding, and the parent session ported the two fourth-round race fixes from the perf PR so the two iOS branches land the same cache implementation; all three are fixed here (see the PR for the replies):

- The legacy migration now validates the blob with `decode` before writing it: an undecodable legacy blob is dropped instead of becoming a corrupt cache file the next restore must delete.
- The legacy migration's re-check branch applies the decodable-only contract before dropping the `UserDefaults` blob.
- The corrupt-cache self-heal joins the serialized write chain (`SnapshotCache.removeCorruptSelfHeal()`), re-checks the session generation, and deletes only when the file still exists AND still fails to decode.

The parent session's fifth-round refinement is ported too: `removeCorruptSelfHeal()` returns whether the file was actually deleted, and the corrupt branch awaits it — the store's cache flags clear only on a confirmed deletion, so they stay truthful when the heal keeps the file.

Kody's sixth round (LOW): the migration retained the UserDefaults legacy blob behind an existing corrupt/unreadable file, claiming `read()` falls back to it — but `read()` only consulted the blob when no file existed.  `read()` now consults the legacy blob on corrupt and unreadable outcomes as well, making the retention contract true as written; the corrupt file itself is still self-healed or overwritten by the next save.

Seventh-round refinement (ported from the perf PR): serving the legacy blob as `.decoded` hid the `.corrupt` outcome, so the self-heal never ran on a corrupt file with a retained blob.  The corrupt-file fallback now also schedules `removeCorruptSelfHeal()`; the transient-read path still never heals.

## 6. Zero-Code Findings

- The `@Observable` macro tracks a property per property, so the whole-tree invalidation the audit measured came from `objectWillChange` firing on every one of the 24 `@Published` properties, not from the number of views.  `AppLockController` was already migrated, so the pattern is proven in this repo.
- `@ObservationIgnored` is the right tool for the store's internal bookkeeping: it keeps the observation graph small, so writing `loadGeneration` or `busyOperations` does not wake a reader that only cares about the snapshot.
