# 2026-08-12 — iOS parity wave 3: order cancel from the phone

Branch `monet/ios-order-cancel` · worktree `~/apps/trading-monet-wave3`.

## 1. Context & Objective

Open orders were the phone's last see-but-cannot-act money surface: the Assets screen listed
working broker orders and offered nothing to do about them, so killing a rotting limit order
meant finding a laptop.  This wave closes that loop by building the iOS half of roadmap item #3
on top of the server command that was landed separately.

This branch is an **integration branch**.  It merges, unchanged, two branches that were built in
parallel and verified independently, then adds the iOS UI that needs both:

| Merged branch | What it brought | Its own rollout note |
| --- | --- | --- |
| `monet/ios-parity-wave2` (`ff6b7756`) | Tighten Guardrails, `snapshot.catalog` decoding + `MobileStore.serverAdvertises`, universal links / deep-link routing | `docs/rollouts/2026-08-12-ios-parity-wave2.md` |
| `monet/order-cancel-server` (`4f9d3aac`) | `order.cancel` mobile command, `src/lib/order-cancel.ts` (`cancelWorkingOrder`) shared with the console route | `docs/rollouts/2026-08-12-order-cancel-command.md` |

Both merged clean — no conflicts, no manual resolution, no regeneration of the Xcode project
was needed for the merge itself (the two branches touched disjoint files apart from `STATUS.md`
and `docs/EFFORT-LOG.md`, which auto-merged).

## 2. Changes Made

### The cancellable predicate is the whole safety property

`OrderCancellation.isWorkingState` is an exact mirror of the server's `isWorkingOrderState`
(`src/lib/broker-held-orders.ts`) — `ACTIVE_BROKER_ORDER_STATES` plus
`EXTRA_WORKING_ORDER_STATES`.  That predicate is not a UI nicety: it is the same precondition
`cancelWorkingOrder` enforces for this lane (`requireWorkingOrder: true`), so the control appears
exactly where the server would accept it.

- Cancellable: `accepted`, `accepted_for_bidding`, `confirmed`, `held`, `new`, `open`,
  `partially_filled`, `pending`, `pending_cancel`, `pending_new`, `pending_replace`, `queued`,
  `submitted`, `suspended`, `unconfirmed`, `stopped`, `calculated`.
- Not cancellable: everything else, including **`done_for_day`** — a terminal day-order outcome
  Alpaca returns forever in history, deliberately excluded from the server's working set (the
  same trap that once made the web Orders screen show hundreds of finished orders as pending).
- Matching is trimmed + lowercased; an unrecognised broker word is treated as un-cancellable
  rather than offered on a guess.
- `pending_cancel` stays cancellable on purpose, matching the console: a broker cancel stuck in
  that state is a reason to ask again, not a reason to remove the lever.

`/api/mobile/snapshot` already filters `orders` through the same predicate, so on a current
server every listed row passes.  The client-side check is still real work: the app renders
snapshots restored from its own `UserDefaults` cache, which can predate that filter.

### The control

`ios/SocraticTrade/MarketsView.swift` — `OrderRow` gained a trailing **Cancel Order** button
(44 pt minimum height, `.bordered`, destructive role) shown only when the row is cancellable
**and** the deployment advertises `order.cancel` (`store.serverAdvertises`, from wave 2's
catalog).  Submission goes through the ordinary `store.submit` path, so it inherits the busy
guard, the per-operation idempotency key, and the snapshot reload — no new store surface.

- **Payload**: `{ orderId, accountNumber }`, where `accountNumber` is
  `snapshot.readiness.selectedAccountNumber` (server-side that is `policy.accountNumber`, the
  exact value `cancelWorkingOrder` compares against).  This is the server's stale-view guard: a
  cancel queued while looking at account A is refused rather than landing on account B.  The key
  is omitted, not blanked, when no account is selected — the phone never claims a guard it did
  not assert.
- **Operation id** is `order.cancel:<orderId>`, so a double tap re-uses the first attempt's
  idempotency key instead of asking the broker twice, and one order's in-flight cancel never
  disables another row's button.
- **Swipe**: the same `swipeRevealAction` used by swipe-to-reject on proposals and
  swipe-to-delete on alerts, opening the *same* confirmation dialog rather than firing directly.
- **Outcome** surfaces the way every other row command's does: the in-button spinner while
  `store.isBusy`, then either the row disappearing on the reload (a cancelled order is no longer
  working, so the server drops it from `orders`) or the store's own failure banner carrying the
  server's message verbatim.
- `AppFormat.commandLabel` learned `order.cancel` -> "Cancel Order" so Activity and the
  unavailable-command message read as words.

### Ceremony

A confirmation dialog, and nothing more — the same weight the alert-delete row already carries.
No typed confirmation: the server requires none for cancel even on a live brokerage account,
because cancelling prevents an execution rather than causing one.  The dialog copy is condensed
from the console's cancel sheet and every clause is load-bearing — no new order is placed, fills
that already happened stand, and the cancel is a request the broker may take a moment to honour.

Buttons are **Cancel Order** (destructive) and **Keep It Working** — "Cancel" alone would be
ambiguous next to the thing being cancelled.

### Files

New:
- `ios/SocraticTrade/OrderCancel.swift`
- `ios/SocraticTradeTests/OrderCancelTests.swift`
- `docs/rollouts/2026-08-12-ios-parity-wave3.md` (this note)

Modified:
- `ios/SocraticTrade/MarketsView.swift`
- `ios/SocraticTrade/AppComponents.swift` (one command label)
- `ios/Socratic Trade.xcodeproj/project.pbxproj` (regenerated for the two new files)
- `STATUS.md`, `docs/EFFORT-LOG.md`

No web/server file was changed by this wave; the server half arrived via the merge.

## 3. Decisions & Trade-offs

- **`store.canSubmit` gating left as-is.** `order.cancel` is not added to `MobileStore`'s
  `protectiveCommands` set, so it is catalog-gated (an older server genuinely cannot run it —
  better to hide the control than to collect a 400) and snapshot-staleness-gated like every
  other row action.  The rows themselves come from that snapshot, so acting on data the app
  cannot vouch for would be the incoherent option; pull-to-refresh is one gesture away.  This is
  deliberately not new friction — it is the same gate `alert.delete` and `watchlist.remove`
  already sit behind.
- **Predicate duplicated rather than inferred.** A "not obviously terminal" heuristic would have
  been shorter and would have quietly offered Cancel on `done_for_day`.  The literal set is
  annotated with its source of truth so the next drift is a visible diff.
- **No replace-at-market.** Out of scope, and the server half explicitly did not build it; the
  requirements are listed in `docs/rollouts/2026-08-12-order-cancel-command.md` §5.
- **No dust-warning surface on the phone.** The server returns `dustWarning` on the cancel
  result and the console keeps its sheet open to show it, but the mobile command result is not
  currently threaded into a per-row view model.  The advisory never gates the cancel, and the
  server still raises its own `risk_advisory` notification, so nothing is lost silently —
  rendering it on the card is a follow-up, listed below.

## 4. Verification State

All foreground, full output observed.

```
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
```
-> `Executed 64 tests, with 0 failures (0 unexpected)` / `** TEST SUCCEEDED **`
(56 inherited from the merged wave-2 branch, +8 new in `OrderCancelTests`).

```
npx tsc --noEmit          # clean, no output
npm run lint              # 750 warnings, 0 errors (grandfathered backlog)
npx vitest run test/mobile-order-cancel.test.ts \
  test/apple-app-site-association-route.test.ts test/mobile-api.test.ts \
  test/orders-cancel-dust-risk-route.test.ts test/dashboard-feed.test.ts
                          # Test Files 5 passed (5) · Tests 59 passed (59)
```

`xcodegen generate` was run for the two new `.swift` files and the `objectVersion = 100` /
`preferredProjectObjectVersion = 100` header pair re-applied (both the top-level key and the
inner `PBXProject` value).  `Info.plist` untouched — `project.yml` still declares the version
keys as build-variable substitutions, so the regen did not reintroduce the literal `1.0`/`1`
regression.  The resulting pbxproj diff is 8 lines, all of them the two new file entries.

## 5. Next Steps & Blockers

- No credential or infrastructure action was needed or taken.  Shipping this to a device is the
  ordinary TestFlight path (`scripts/ios-ship-testflight.sh`), which is an owner action.
- Follow-up (small): render the server's `dustWarning` on the order card after a successful
  cancel, matching the console sheet's behaviour of staying open to show it.
- Follow-up (larger): replace-at-market from the phone — requirements enumerated in the
  order-cancel server rollout note.

## 6. Adversarial money-path review (2026-08-12, follow-up commit)

An adversarial reviewer re-traced the cancel path, the tighten-only invariant, the deep-link
router, and the catalog decode against this branch.  Two real defects were found and fixed here;
one structural gap is left open below.

### Fixed

1. **A stale menu option could LOOSEN a cap** — `ios/SocraticTrade/PolicyTightening.swift`.
   `tightenedCapOptions` runs when the menu's content is built, but the value it yields is an
   ABSOLUTE number, `policy.patch` is a QUEUED mobile command (not in
   `IMMEDIATE_MOBILE_COMMAND_TYPES`), and the server enforces no direction on it
   (`normalizePolicyPatch` accepts both ways; `applyPolicyPatch` merges verbatim).  A menu held
   open across a snapshot refresh — or opened before the owner lowered the same cap in the web
   console — would re-send the older, larger number and RAISE the cap, under a footer that reads
   "These controls only tighten."  Added `PolicyTightening.isStillATightening(_:value:in:)` and a
   tap-time re-check against `store.snapshot?.policy` before submitting; a refused tap says so in
   the error banner instead of silently doing nothing.  Covered by
   `PolicyTighteningTests.testAStaleOptionIsRefusedOnceTheCapHasMovedUnderIt`.

2. **A malformed `catalog` failed the WHOLE snapshot decode** — `ios/SocraticTrade/MobileModels.swift`.
   `decodeIfPresent` returns nil only for a MISSING or null key; a catalog of the wrong shape
   (`"catalog": "v2"`, `commands` not an array, an element whose `type` is not a string) throws,
   and the `try` propagated out of `MobileSnapshot.init` — blanking the entire app over a field
   the design treats as optional.  Proven by reverting the fix and re-running the new test:
   `DecodingError.typeMismatch ... Path: catalog`.  Now `try?`, landing on nil, which
   `serverAdvertises` already reads as "the server did not answer" and falls back to the built-in
   controls.  Covered by
   `ControlCatalogTests.testAMalformedCatalogFallsBackInsteadOfFailingTheWholeSnapshot` (6
   malformed shapes).

### Left open (structural — not fixed here)

- **Queue latency still allows a loosening patch.**  The tap-time re-check closes every window
  the phone can see, but `policy.patch` is queued: between submission and execution a
  `strategy.run_once` can drain for minutes while the owner lowers the same cap in the console,
  and the queued absolute value then raises it.  Closing this needs a server-side precondition
  (e.g. an `expectedCurrent` on the patch, refused on mismatch — the same shape as
  `order.cancel`'s `expectedAccountNumber`), which is a command-contract change and an owner
  call.

### Verified safe (traced end to end, not taken on trust)

- `order.cancel` cannot reach another user's or another account's order.  `cancelWorkingOrder`
  resolves `getPolicy(userId)` and `getBrokerGateway(policy, userId)` from the session user only;
  the broker call is always `cancelEquityOrder(policy.accountNumber, orderId)`.
  `expectedAccountNumber` is a refusal, never a redirect.  `mobile_commands` idempotency dedupe is
  scoped `WHERE user_id = ? AND idempotency_key = ?`.
- One implementation, not two: `POST /api/orders/cancel` is now a thin shell over
  `src/lib/order-cancel.ts`, and `app/console/orders/api.ts` still posts to that route.
- Fill-between-render-and-tap surfaces honestly (409 naming the state, or 404), and a failed
  command's server message reaches the banner through `reconcileTrackedCommands`.
- Deep links are navigation-only: `DeepLinkDestination` is `.tab`/`.proposal`, and
  `focusedProposalId` only scrolls and rings a card.  https-only, exact-host, no subdomain or
  suffix match; the custom scheme is rejected for content routes.
- `/.well-known/apple-app-site-association` genuinely routes under a dot-prefixed `app/` directory
  (verified live, not just by importing the module): `curl` against `next dev` returned
  `200 ct=application/json` with the expected body.

Re-verified after the fixes: `Executed 66 tests, with 0 failures (0 unexpected)` / `** TEST
SUCCEEDED **` (64 + 2 new), and `npx vitest run test/mobile-order-cancel.test.ts
test/apple-app-site-association-route.test.ts test/orders-cancel-dust-risk-route.test.ts
test/mobile-api.test.ts` -> 4 files / 21 tests passed.

## 7. Round-2 review close-out (2026-08-12): queued-loosening gap CLOSED, cancel un-gated, focus ring made transient

Two adversarial reviewers passed the branch "ship" and left three items.  All three are closed
here.  The first is the structural gap §6 left open.

### 7.1 The queued-loosening gap is now closed SERVER-SIDE

**Was:** §6 fixed the phone's tap-time re-check, but `policy.patch` is a QUEUED command (it is not
in `IMMEDIATE_MOBILE_COMMAND_TYPES`), so it can execute minutes later behind a draining
`strategy.run_once`.  `applyPolicyPatch` merges verbatim in either direction, so a reduction
tapped against a $10,000 cap that the console lowered to $2,000 in that window executed as a
**LOOSENING** — under a footer that reads "These controls only tighten."

**Now:** `policy.patch` accepts an OPTIONAL `expectedCurrent` precondition, modelled directly on
`order.cancel`'s `expectedAccountNumber` (`src/lib/order-cancel.ts`) — same shape, same
audit-then-throw style, same 409.

Payload:

```jsonc
{
  "patch":           { "maxOrderNotional": 2500 },   // unchanged, as before
  "expectedCurrent": { "maxOrderNotional": 10000 }   // NEW, optional
}
```

- **Validated at the door** (`normalizePolicyPreconditions`).  Keys must be scalar fields
  `policy.patch` can actually set — the `strategyAuthority` / `holdingHorizon` enums plus every
  numeric and boolean guardrail (both lists hoisted to `POLICY_PATCH_NUMERIC_FIELDS` /
  `POLICY_PATCH_BOOLEAN_FIELDS` so the patcher and the guard cannot drift apart).  Anything else
  — an unknown name, `riskRules`, `blocklist`, a wrong-typed value, a non-object `expectedCurrent`
  — is a `MobileCommandValidationError` (400) at queue time.  Fail closed on purpose: silently
  dropping an assertion the caller believes is being enforced is the exact failure this guard
  exists to prevent, and `asRecord` would have coerced a bad value into an empty, always-passing
  guard.  `null` is a real expectation meaning "I believed this was unset"; `{}` and `null`
  overall assert nothing and are dropped so the stored payload keeps its legacy shape.
- **Enforced at execution time** (`applyPolicyPatch`), BEFORE anything is merged.  On any
  mismatch: audit `mobile_policy_patch_precondition_mismatch`
  (`{ field, expected, actual, fields }`, with the user's `connectedAccountId`, mirroring
  `order_cancel_account_mismatch`), then throw `PolicyPatchPreconditionError` (`status = 409`).
  The command finishes `failed` with a message naming the field and both values, and a structured
  `result` (`{ error: "policy_precondition_mismatch", field, expected, actual }`) alongside the
  existing `LiveApprovalConfirmationError` case.  **All-or-nothing:** a multi-field patch applies
  none of its fields when one precondition fails, and no `mobile_policy_patch` write event is
  recorded.
- **Optional is load-bearing.** A patch with no `expectedCurrent` behaves byte-for-byte as before
  — legacy last-write-wins — and its stored payload is unchanged (`{ patch: … }`, no empty guard
  object).  The web console and every existing caller are untouched.  Proven by
  `test/mobile-policy-precondition.test.ts` -> "keeps a patch WITHOUT preconditions behaving
  exactly as before", which performs the *same* mid-flight console edit as the refusal test and
  asserts the queued patch still lands, plus the payload shape and the single audit row.
- **The phone now sends it.**  `PolicyTightening.authorityPayload()` guards
  `strategyAuthority: "decide"` (the only value that offers the row at all), and
  `capPayload(_:value:current:)` guards the cap it is lowering with the value read from the SAME
  snapshot the tap-time re-check just approved.  No snapshot value -> no key, rather than a
  claimed expectation the phone never read.

This is what makes the "These controls only tighten" footer true end to end: the phone closes
every window it can see, and the precondition closes the one it cannot.

**Deployment-order note:** an app build that sends `expectedCurrent` to an OLDER server is not
rejected — the previous `normalizeCommandPayload` simply ignored unknown payload keys, so the
patch applies unguarded exactly as it did before this change.  That is the safe direction (no
400, no lost patch), but it does mean the guarantee only holds once the server side is live; on
this repo the two ship together and `main` auto-deploys, so the window is a build cycle, not a
standing condition.

### 7.2 Cancel is no longer gated on snapshot staleness

`MarketsView`'s Cancel went through `store.canSubmit`, whose >180 s staleness gate is backwards
for this one action: a stale snapshot usually means a flaky connection, and a flaky connection is
exactly when someone reaches for cancel.  Withholding the only lever that can *reduce* risk is the
paternalism this repo's product philosophy rules out.

`order.cancel` is now exempt from the staleness gate in `MobileStore.canSubmit`, alongside the
existing `account.activate` exemption ("that is exactly when users try to switch away from a stuck
context") and written in the same style.  Safe because the SERVER re-validates: the mobile lane
runs `cancelWorkingOrder` with `requireWorkingOrder: true` and refuses with 404/409 when the order
is no longer working or is not in the selected account, so a stale tap collects an honest error
instead of cancelling the wrong thing.  The exemption is narrow — it still requires a loaded
snapshot (there must be an order row and an account number to send) and still respects capability
discovery (a catalog that does not advertise `order.cancel` keeps the control off).

### 7.3 The deep-link focus ring is transient again

`MobileControlView.focusedProposalId` was never cleared, so the accent ring stayed on a linked
proposal card for the rest of the session — reading as "this one is special" long after it meant
"here it is."  It now clears on any tab change (the rerouting `selection` binding, with `apply`
setting the focus *after* the tab move so a link's own jump does not clear it) and expires on its
own four seconds after the link lands.  Clearing scrolls nothing back: `SnapshotScaffold` only
acts on a non-nil target.  The deep-link plumbing itself is unchanged.

### Files

Modified:
- `src/lib/mobile-api.ts` (precondition normalize + enforce + error class + audit)
- `ios/SocraticTrade/PolicyTightening.swift` (send `expectedCurrent`)
- `ios/SocraticTrade/MobileStore.swift` (cancel staleness exemption)
- `ios/SocraticTrade/MobileControlView.swift` (focus-ring lifetime)
- `ios/SocraticTradeTests/PolicyTighteningTests.swift`,
  `ios/SocraticTradeTests/MobileModelsTests.swift`,
  `ios/SocraticTradeTests/ControlCatalogTests.swift`
- `STATUS.md`, `docs/EFFORT-LOG.md`

New:
- `test/mobile-policy-precondition.test.ts`

No new `.swift` file, so no `xcodegen generate` and no pbxproj header re-apply was needed.

### Verification (all foreground, full output observed)

```
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project "Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'platform=macOS,variant=Designed for iPad' test
```
-> `Executed 68 tests, with 0 failures (0 unexpected)` / `** TEST SUCCEEDED **` (66 + 2 new).

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit     # clean, no output
npm run lint         # 750 problems (0 errors, 750 warnings) - grandfathered backlog
npx vitest run test/mobile-policy-precondition.test.ts test/mobile-api.test.ts \
  test/mobile-order-cancel.test.ts test/policy-caps.test.ts test/policy-normalization.test.ts \
  test/stale-mobile-commands.test.ts test/mobile-stop-preemption.test.ts \
  test/console-policy-write-queue.test.ts
                     # Test Files 8 passed (8) · Tests 47 passed (47)
npx vitest run       # Test Files 551 passed | 1 skipped (552)
                     # Tests 6369 passed | 51 skipped (6420)
```

The full suite was run because `src/lib/mobile-api.ts` is imported broadly; no other caller of
`applyPolicyPatch` or `normalizePolicyPatch` regressed.
