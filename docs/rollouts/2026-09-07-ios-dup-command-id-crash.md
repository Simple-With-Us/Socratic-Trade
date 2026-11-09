# 2026-09-07 — iOS hard-crash fix: `Dictionary(uniqueKeysWithValues:)` on duplicate server command ids

## Context & Objective

P1 hard crash (board `3b3df6ca`, duplicate of `d9f81e44`, originally flagged in the
2026-08-20 DeepSeek full-stack review).  `CommandAttemptTracker.reconcile(_:)`
(`ios/SocraticTrade/MobileStore.swift`) built its id→command lookup with
`Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })`.  That initializer
calls `fatalError` — not a catchable Swift error — the instant the input sequence
contains two entries with the same key.  The server can legitimately report the same
`MobileCommand.id` twice in one `recentCommands` snapshot (e.g. overlapping poll
windows), so this was a reachable crash on real production data, not a theoretical one.

Goal: eliminate the trap without changing observable behavior for the common
(non-duplicate) case, pick a deliberate and documented collision policy, surface real
duplicates instead of silently dropping them, and add a regression test.  A Codex PR
review (threads anchored to commits `c375c55a` / `8f681793`) then asked for three P2
correctness refinements — an equal-timestamp tie-break, duplicate handling shared by
every command lookup, and gating the Sentry warning so a persistent server duplicate
cannot re-report on every poll — plus the repo-standard process items (hosted iOS
verification, the four-command web gate, a complete touched-path list, and a PLAN.md
entry).  This note covers both the original fix and that review round.

## Investigation

`grep -rn "uniqueKeysWithValues" --include="*.swift" .` from the repo root found
exactly one call site: `ios/SocraticTrade/MobileStore.swift`.  No other
`Dictionary(uniqueKeysWithValues:)` usage exists anywhere in the iOS app or test
target.  `grep -rn "recentCommands" ios/SocraticTrade --include="*.swift"` (excluding
Tests) found only two programmatic consumers of that array — the tracker `reconcile`
and `MobileStore.proposalActionFeedback` — so sharing one fold between those two closes
the "every snapshot consumer" gap without mutating the stored snapshot.

## Changes Made

Complete touched-path list for this PR/round:

- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `STATUS.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-07-ios-dup-command-id-crash.md` (this note)
- `PLAN.md`

### `ios/SocraticTrade/MobileStore.swift`

- `import Sentry` added (already a linked SPM dependency via `SentryTelemetry.swift`;
  this is the only telemetry/logging facility present anywhere in the iOS app — there
  is no `os.Logger` / `OSLog` / custom `AppLogger` in the codebase to reuse instead).
- New `MobileCommand.foldDuplicate(existing:incoming:)` — the single, shared,
  deterministic duplicate fold: the freshest `updatedAt` wins (ISO8601 timestamp strings
  sort lexicographically), an exact `updatedAt` tie prefers the terminal state, and a
  full tie keeps the existing value.  The outcome for a pair is order-independent, so
  lookups no longer depend on whatever array order the server happened to send.
- `CommandAttemptTracker.reconcile(_:)` now builds its lookup with a plain loop over
  `foldDuplicate` — no `Dictionary(uniqueKeysWithValues:)` and no
  `Dictionary(_:uniquingKeysWith:)` either, i.e. nothing that can trap.  Resolving the
  Codex equal-timestamp example: a `[failed, queued]` pair sharing one `updatedAt` now
  keeps the `failed` entry, so the tracked operation resolves instead of staying queued
  forever.  The comment on the fold documents why the winner is content-derived rather
  than array-position-derived.
- The Sentry warning is gated: it fires only when a duplicate command id is one a
  *pending tracked attempt* is waiting on.  A duplicate that no local operation is
  tracking cannot re-report itself on every snapshot and flood the Sentry event quota.
- `MobileStore.proposalActionFeedback` no longer does a raw
  `snapshot?.recentCommands.first(where: { $0.id == commandID })`; it goes through a new
  `recentCommand(id:)` helper that folds every matching `recentCommands` entry through
  the same `foldDuplicate`.  The proposal card and the tracker therefore cannot disagree
  about which version of a command is current.

### `ios/SocraticTradeTests/MobileModelsTests.swift`

- `testReconcileDoesNotCrashOnDuplicateCommandIdsAndKeepsTheFreshestByUpdatedAt` (the
  original crash regression: feeds two entries sharing one id, stale one listed last,
  asserts the fresher wins).
- `testReconcileDuplicateEqualUpdatedAtPrefersTerminalRegardlessOfArrayOrder` — feeds
  `[failed, queued]` AND `[queued, failed]` where the two entries share an `updatedAt`
  and asserts the terminal `failed` resolution in both orders.
- `testFoldDuplicateIsSharedDeterministicRuleAcrossLookups` — pins the shared fold rule
  used by both consumers: freshest `updatedAt` wins, an exact `updatedAt` tie prefers the
  terminal state in either argument order, and a full tie keeps the existing value.

### Handoff docs

- `STATUS.md` entry and `docs/EFFORT-LOG.md` row updated for the review round; `PLAN.md`
  gains the iOS workstream plus the remaining TestFlight release action.

## Decisions & Trade-offs

- Shared fold at the lookup consumers rather than mutating the stored snapshot:
  `MobileSnapshot.recentCommands` is a `let` and doubles as the raw activity feed, and
  the only two *programmatic* consumers are `reconcile` and `proposalActionFeedback`, so
  folding at those two sites closes the consistency gap Codex identified while preserving
  the snapshot's existing display semantics.
- Last-wins by `updatedAt`, not first-wins: a duplicate id most plausibly represents the
  same underlying command observed at two points in its lifecycle (one page of a poll
  captured it mid-flight, a later fetch shows it terminal).  The freshest status is the
  one the tracker's terminal-state resolution logic (`command.isTerminal`) needs to see.
- Terminal-over-non-terminal on an exact `updatedAt` tie is the documented tie-break.  A
  fuller lifecycle ranking (e.g. `running` over `queued`) is not documented anywhere in
  the codebase and is unnecessary for the tracker, which only acts on terminal states.
- Sentry (`SentrySDK.capture(message:)`) is the only telemetry facility integrated into
  the iOS app at all; level `.warning`, message text only (id count, not raw ids or
  payloads), consistent with the app's PII-conscious Sentry configuration
  (`sendDefaultPii = false`, URL param redaction in `beforeSend`).  Now gated to tracked
  pending attempts per the Codex review.
- No other call sites existed to leave alone or change — this was the sole trapping
  initializer in the codebase.

## Verification State

Swift compile + XCTest is delegated to the GitHub-hosted
`.github/workflows/ios-build.yml` job (`xcodebuild (unsigned)` on this PR) per repo
policy — no local `xcodebuild`.  The hosted run is appended below once the check is
green.

The repo's web/backend gate was run in this lane and recorded here (iOS+docs-only
change; these are the required `verify` checks for merge):

```bash
npm run lint       # PASS — 0 errors (801 grandfathered warnings)
npx tsc --noEmit   # PASS
npm test           # 7782 passed, 51 skipped, 9 failed (pre-existing LLM key-routing
                   #   failures in test/chat-llm.test.ts, test/framework-review.test.ts,
                   #   test/llm-provider.test.ts, test/openrouter-credits.test.ts,
                   #   test/proposal-revalidation.test.ts — reproduced on a pristine
                   #   branch in this seat's env, unrelated to this change)
npm run build      # PASS
```

## Next Steps & Blockers

- **Merging to `main` does NOT ship this fix to users.**  The iOS app is distributed
  separately via TestFlight/App Store; this change reaches real devices only on the next
  iOS release build and submission, not on merge/deploy of `main`.
- No Coolify mutate.  No extra-ship beyond this PR.
- Board `3b3df6ca` (duplicate `d9f81e44`) to be updated to reflect PR + merge status.
