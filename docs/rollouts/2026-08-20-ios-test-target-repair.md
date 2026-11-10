# 2026-08-20 — iOS test target: repair the compile break and three stale assertions

## Context & Objective
Owner-directed.  The Swift test target had been red on `main` and nobody could see it, because the required `verify` gate never runs `xcodebuild test` — findings `qa-01` / `qa-02` from the 2026-08-18 review, biting in the wild.  Nothing here changes app behavior: this is test-only repair so the suite can run again and start catching regressions.

## What was actually wrong

**Blocker first — the target did not compile.**  `xcodebuild test` failed at build with 5 errors, so no test in the target could run at all (including the three below, which therefore could not have been observed failing on a clean checkout).  `ios/SocraticTradeTests/MobileModelsTests.swift:415/437/457` called `JSONEncoder().encode(snapshot)` on `MobileSnapshot`, which is `Decodable`-only.

Fixed on the TEST side, not the model: `MobileStore` caches the **raw response bytes** (`saveCachedSnapshot(rawData)`, fed by `client.snapshotData()`) and never re-encodes a snapshot — which is exactly why the model has no `Encodable` conformance.  The tests now seed the cache with the same raw JSON the app writes.  Adding `Encodable` would have bent the production model to satisfy a test.

**1. `testCoachProviderRoutingMatchesChatCatalog`** asserted `provider(for: "mock") == "mock"`, but there is no `mock` branch, so it returns `"openai"`.

**2. `testFirstAvailablePrefersAKeyedProviderThenMock`** asserted `firstAvailable(providers: [:])?.id == "mock"`, but there is no option with id `mock`, so it returns `nil`.

Both are STALE TESTS, not implementation bugs.  `git show fd508bbfa` (PR #2887) removed the `"Mock (offline)"` option, the `mock` provider branch and the `provider == "mock"` availability bypass together — a keyless offline model is the mock/demo path the product rules forbid, and the review filed it as `copy-16`.  Restoring `mock` would revert #2887, so the tests were updated to the real contract and made to earn their keep: unrecognised ids fall through to `openai`, and with no keys `firstAvailable` returns `nil` so the caller must say "no model configured" rather than silently answering from a fake one.  Added coverage for the `mistral` / `deepseek` / `moonshot` branches, which had none.

**3. `testScanQuotesUnavailable503DecodesAbortReceipt` contradicted itself.**  It decoded two JSON bodies differing only in an unrelated top-level `error`/`code`, then asserted the same `errorDescription` was BOTH the first warning alone AND all warnings joined.  `MobileAPIError.errorDescription` for `.scanQuotesUnavailable` is a pure function of `scan.warnings` (joins every non-empty warning with the two-space gap), and both bodies decode identical `warnings`, so the two assertions could never both pass.

Resolved in favour of the implementation's joined form — and it is the better behavior: the second warning is the half that tells the owner they are looking at a *stale fallback scan*, so dropping it would leave "This operation was aborted" with no explanation.  The second decode block is now commented to show its purpose (same warnings, no top-level `error`/`code`) rather than reading as an accidental duplicate.

## Verification State
- `xcodebuild test -only-testing:SocraticTradeTests/DeskModelsTests` — **exit 0, zero failures**, 59s.
- Reproduced the original state first: on clean `origin/main` the same command fails at build with the 5 `Encodable` errors.
- Operational note: the first attempt WEDGED for 30 minutes with no log output and no DerivedData activity, sharing the `iPhone 17 Pro` simulator with another agent session.  Re-run on a dedicated simulator (`ST-Monet-Tests`, targeted by UDID) finished in 59 seconds.  Agents running iOS tests concurrently should create and target their own device.

## Next Steps & Blockers
- With the target compiling again, `qa-01` / `qa-02` become actionable: add `xcodebuild test` to CI so a red Swift target cannot sit unnoticed again.  That is the durable fix; this change only makes it possible.
