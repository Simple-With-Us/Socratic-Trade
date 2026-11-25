# 2026-11-24 — ST-4670 iOS Proposals: safety-warning parity, triage filter/sort, risk/reward ladder, detail label wrap

Lane: `zc/4670-ios-proposals-safety-triage` (base `bca770f1e`).  Child of ST-4668.  iOS-only; no server, approve/confirm-flow, alert, or order-placement change.

## 1. Context & Objective

The web approval card (`app/console/components/approval-card.tsx`) surfaces decision-critical safety warnings that the iOS pending-proposal card neither decoded nor showed, and the queue had no triage controls.  This lands the four ST-4670 items: safety-warning parity, a persisted filter/sort bar, a visual risk/reward ladder, and an adaptive DetailLine label column.

## 2. Changes Made

Safety warnings now decode additively (all optional, tolerant of absence) and render in the card's existing warning styles: a `stopPlan: "none"` no-stop warning with the model rationale, a `holdReason` pill using the web `HOLD_REASON_LABELS` vocabulary, a "Why your approval is required" block for `humanReviewReasons`, a muted "Data Adjustments" receipt list, the `decision.washSale.note` annotation, an exit estimated P/L line derived from the matched held position (web `estimatedClosingPnl` parity, including the sign-agreement, cost-equals-price no-quote, and oversize-cap guards), and an expiry countdown from `policy.proposalExpiryMinutes`.  The queue gains a chip filter row (All / Needs Review / Red Rejected / Ready) plus a sort Menu (Newest / Oldest / Confidence) persisted with `@AppStorage` keys `proposals.filter.v1` and `proposals.sort.v1`.  The ladder maps stop/entry/target into trade-favorable space so a long reads stop-left/target-right and a short mirrors it, with the mark colored by fill drift in the card's Delay-row vocabulary.  DetailLine labels keep a 58 pt minimum but size to their text on one line.

Files touched:
- `ios/SocraticTrade/MobileModels.swift` — additive decode: `Proposal.stopPlan/holdReason/humanReviewReasons/dataAdjustments`, `PendingProposal.decision`, new `ProposalStopPlan`, `HumanReviewReasonReceipt`, `ProposalDecisionSummary` structs, `PolicySummary.proposalExpiryMinutes` (property, CodingKeys, init, decode, `.default`).
- `ios/SocraticTrade/ProposalPriceReview.swift` — `import SwiftUI`; new `ProposalISODate`, `ExitPnlEstimate`, `ProposalSafetyMath` (expiryNote, exitEstimatedPnl, holdReasonLabel), `RiskRewardLadderMath` (pure position math), `ProposalRiskRewardLadder` view.
- `ios/SocraticTrade/ProposalsView.swift` — `ProposalTriageFilter`/`ProposalSortOrder` enums, `matchesProposalFilter`/`sortedProposals` helpers, `ProposalTriageBar`, `@AppStorage` persistence, card wiring for all warnings + ladder + exit P/L + expiry, adaptive `DetailLine`.
- `ios/SocraticTradeTests/ProposalPriceReviewTests.swift` — ladder math (long/short/degenerate/all-equal/missing/mark drift), expiry countdown with injected clock, exit P/L parity cases, hold-reason labels.
- `ios/SocraticTradeTests/MobileModelsTests.swift` — new `ProposalSafetyDecodeTests` class: present/absent decode of every new field, policy expiry decode.
- `ios/SocraticTradeTests/ProposalTriageTests.swift` — new file: filter buckets, sort orders, nil-last and id tie-break determinism.
- `STATUS.md`, this rollout note.

## 3. Decisions & Trade-offs

- Wire keys are camelCase, matching the server JSON and this file's existing convention (the task brief said snake_case, but `/api/mobile/snapshot` serializes camelCase and every existing CodingKeys case here is camelCase; snake_case keys would never decode).
- `PendingProposal` carries no status field — `listPendingProposals` returns only `status = 'proposed'` rows — so the triage buckets derive from the decoded decision receipts (holds, human-review reasons, Red verdict) instead of a nonexistent status enum.  Buckets may overlap by design; "Ready" excludes both.
- The ladder's mark color follows the card's existing `delayAdvantage` fill vocabulary (a buy below its proposed entry is favorable), not trade-direction drift, so the ladder never contradicts the Delay row.  Positions still use trade-direction space so stop sits left of entry for longs.
- `proposalExpiryMinutes` is NOT in the mobile payload today (the route's policy block omits it); the iOS side decodes and renders it additively and omits the line when absent.  No server field was invented.
- DetailLine uses `minWidth: 58` + `fixedSize(horizontal: true)` + `lineLimit(1)`: short labels keep the old aligned column, long labels ("Proposed by", "Est. P/L if filled") read on one line and push only their own value right.  A full Grid rewrite was rejected as a larger change than the item needs.
- Sort comparators break ties on proposal id and sort nil dates/scores last so the queue never shuffles between renders.
- The expiry line is computed at render time (the snapshot refreshes every 30 s); the pure helper takes an injected `now` so tests never touch a live clock.

## 4. Verification State

Swift was NOT compiled locally and no XCTest was executed locally — this is a Linux seat with no Xcode.  The hosted `verify-ios` job (`.github/workflows/ios-build.yml`, GitHub-hosted `macos-latest`) is the compile and XCTest gate after the lead pushes.

```bash
# Not run on this seat (no Swift toolchain):
# xcodebuild / xcrun simctl — forbidden locally per repo rules
# Hosted gate: verify-ios on the PR

# Run here:
grep -c $'\xc2\xa0' docs/rollouts/2026-11-24-zc-ios-proposals-safety-triage.md   # non-zero
grep -c $'\xc2\xa0' STATUS.md                                                    # non-zero
```

Every new user-facing string is a single sentence (em-dash clauses, no multi-sentence literals), avoids the `UserFacingCopyTests` forbidden tokens, and uses Title Case for headings/chip labels and sentence case for values.  Existing `ProposalPriceReview` memberwise initializer is unchanged, so the pre-existing tests keep compiling.

## 5. Next Steps & Blockers

Lead push note:  ST-4669 (#5473) merged Thu, Nov 25, 8:43 AM CT, so the iOS CI slot was free; origin/main was merged into this lane the same morning (27 files, no conflicts), and the lead pushed with this rollout amendment as the tip so the Kody re-review has a real commit (merge-tipped heads report no changed files).
- `verify-ios` must compile and pass the new tests; no local Swift verification was possible.
- Not on the mobile payload today: `policy.proposalExpiryMinutes` (the route's policy block at `app/api/mobile/snapshot/route.ts` omits it).  On the payload today: `proposal.stopPlan`, `proposal.holdReason`, `proposal.humanReviewReasons`, `proposal.dataAdjustments`, `decision.washSale.note`, and `positions` — the route passes `snapshot.pendingProposals` and `snapshot.positions` through unmodified.
- Server follow-up (separate issue, out of scope here): serialize `proposalExpiryMinutes` in the mobile policy block so the countdown activates.

## 6. Zero-Code Findings

None.
