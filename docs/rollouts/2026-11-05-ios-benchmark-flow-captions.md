# iOS Benchmark Flow Captions (2026-11-05, ST-4589)

## 1. Context And Objective

#5000 aligned the SPY shadow with the account side: a deposit or withdrawal is counted from the start of the day it lands.  The web captions were updated there.  The two iOS captions were split out, because any `ios/` change adds the hosted iOS compile to the merge queue's checks and #5000 was removed from the queue after 60 minutes waiting on that job.

## 2. Changes Made

Two caption strings now say transfers are counted from the start of the day they land, matching the web copy and the benchmark math.

- `ios/SocraticTrade/ResultsView.swift`
- `ios/SocraticTrade/HomeView.swift`
- `STATUS.md`, this note

## 3. Decisions And Trade-Offs

String literals only.  No layout, model or networking change.

## 4. Verification State

Swift is compiled only by the hosted `ios-build` / `verify-ios` job on GitHub-hosted `macos-latest`; nothing was compiled locally.  The result is on the pull request.

## 5. Next Steps And Blockers

If the hosted iOS job again waits longer than the merge queue's 60-minute limit, this pull request will be removed from the queue the same way #5000 was.  That is a runner-capacity or queue-timeout matter, not a problem with the change.

## 6. Zero-Code Findings

None.
