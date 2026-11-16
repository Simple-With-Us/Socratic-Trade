# 2026-08-16 — Review UX: approve speed, prices, Red Team retry, agent controls, PWA off

## 1. Context & Objective

Owner screenshots: Approve sat on "Sending approve…" forever; T showed $8 notional
instead of proposed vs live price; Red Team timeout had no retry; Home dumped
Start + Stop + Close Only + Wind Down at once (Start dead, Stop live) while the
agent was on and the market was closed.  PWA is not a product surface.

## 2. Changes Made

- Approve no longer runs a full-universe `scanMarket` (NASDAQ screener +
  enrich) under the strategy lock.  It quotes the proposal + held names only.
- Snapshot always stamps proposed price (reference, then limit) and looks up
  live price from held marks, newest scan, then `symbol_field_latest`.
- Website approval cards show Proposed / Now / Target / Delay without expanding.
- Retry Red Team on website + iOS + `proposal.retry_red_team` mobile command
  when the critic failed (not when it was never configured).
- iOS Agent Controls are state-aware: one primary (Start / Resume / Stop),
  not five peers.  Website chrome labels are Start Agent / Resume Agent /
  Stop Agent, with copy that "market closed" is not "agent stopped".
- iOS drops "Sending…" as soon as the queue ACK returns.
- `/mobile` and `mobile.socratictrade.com` redirect to `/console`.  PWA marked
  unused; existing `/mobile` code left in place, not invested in.

### Files

```
src/lib/approval-quote-scan.ts
src/lib/proposal-price-review.ts
src/lib/retry-red-team.ts
src/lib/strategy-execution.ts
src/lib/dashboard.ts
src/lib/mobile-api.ts
app/api/proposals/[id]/retry-red-team/route.ts
app/console/lib/api.ts
app/console/components/approval-card.tsx
app/console/components/chrome.tsx
app/mobile/page.tsx
middleware.ts
ios/SocraticTrade/AgentControlPlan.swift
ios/SocraticTrade/HomeView.swift
ios/SocraticTrade/ProposalsView.swift
ios/SocraticTrade/ProposalPriceReview.swift
ios/SocraticTrade/MobileModels.swift
ios/SocraticTrade/MobileStore.swift
ios/SocraticTrade/AppComponents.swift
ios/SocraticTradeTests/AgentControlPlanTests.swift
test/approval-quote-scan.test.ts
test/proposal-price-review.test.ts
test/retry-red-team.test.ts
test/pwa-retired-redirect.test.ts
test/subdomain-routing.test.ts
plus executeProposal suites mocked onto loadApprovalQuoteScan
STATUS.md
PLAN.md
docs/EFFORT-LOG.md
docs/rollouts/2026-08-16-review-ux-parity.md
```

## 3. Decisions & Trade-offs

- Did not delete the PWA client.  Disabled the entry points so no further
  effort lands there.
- Approval still re-runs policy + broker review + place.  Only the universe
  scan was the accidental minutes-long piece.
- Expert-panel UI notes: match website chrome (one run-state control); always
  show Proposed/Now; Retry only on a failed critic; never show Start as a
  peer of Stop when the agent is already on.

## 4. Verification State

```
./node_modules/.bin/eslint <changed ts/tsx>   # 0 errors (2 pre-existing/style warnings)
./node_modules/.bin/vitest run test/approval-quote-scan.test.ts \
  test/proposal-price-review.test.ts test/retry-red-team.test.ts \
  test/pwa-retired-redirect.test.ts test/subdomain-routing.test.ts \
  test/approval-lock.test.ts
# 5 + 2 files, all green
cd ios && xcodegen generate
```

Full `land.sh` trio (tsc → vitest → next build) runs on land.

## 5. Next Steps & Blockers

- TestFlight after merge so the phone shows prices + retry + new agent card.
- Native iOS still needs a ship; website auto-deploys on merge to `main`.
