# Rollout: UX Wave D — mobile/iOS/PWA parity

## Context & Objective

Finish Wave D from `docs/design/ux-improvement-program.md` so phone surfaces match brand
and control-remote IA: brand teal, Home readiness hero, per-proposal command feedback, and
PWA humanized labels. Primary worktree `grok/ux-wave-d-mobile`; useful D4 pieces ported
from sibling `grok/ux-d4-pwa-polish` and tab-switch Review CTA from `grok/ux-d-ios-brand-home`.

## Changes Made

### D1 — Brand teal (not indigo)
- `ios/SocraticTrade/AppComponents.swift` — `AppPalette.accent` uses light `#12616f` / dark
  `#58c7d3` (web `--brand-accent` / `--brand-accent-dark`). Login gradient already used
  `AppPalette.accent`.

### D2 — Home readiness checklist + ready hero
- `ios/SocraticTrade/HomeView.swift` — incomplete setup: checklist hero + Account & Settings
  CTA / universe desk instructions; ready: equity + open P&L + agent state + primary CTA
  (Run once or Review N proposals with tab switch).
- `ios/SocraticTrade/MobileControlView.swift` — `AppTab` shared; `HomeView(selectedTab:)` so
  Review CTA jumps to Proposals.

### D3 — Per-proposal command feedback
- `ios/SocraticTrade/MobileStore.swift` — `ProposalActionFeedback`, `proposalCommandIds`,
  `proposalNotices`, `proposalActionFeedback(proposalId:)`.
- `ios/SocraticTrade/ProposalsView.swift` — card banner sending → queued/running →
  success/fail; Approving…/Rejecting… busy titles; buttons disabled while in flight or settled.
- `app/mobile/mobile-pwa-client.tsx` — on-card status strip for the same lifecycle (parity).

### D4 — PWA polish + iOS label parity
- PWA: humanized `commandLabel`, `strategyAuthorityLabel` (Ask-first / Autopilot), section
  title **Proposals** (not Approvals), control-remote header copy, clearer offline/stale copy.
- iOS: `AppFormat.commandLabel` / `strategyAuthorityLabel` used in Activity, Proposals summary,
  Home, Account settings; Login control-remote framing.

### Files touched
- `ios/SocraticTrade/AppComponents.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/ProposalsView.swift`
- `ios/SocraticTrade/MobileControlView.swift`
- `ios/SocraticTrade/ActivityView.swift`
- `ios/SocraticTrade/LoginView.swift`
- `app/mobile/mobile-pwa-client.tsx`
- `test/mobile-pwa-client.test.tsx`
- `src/lib/web-sources/congress-analytics.ts` (tsc unblock: dual performance shape)
- `docs/rollouts/2026-08-04-ux-wave-d-mobile.md`
- `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`)

## Decisions & Trade-offs

- Combined D1–D4 in one PR for a single iOS claim stream (program preference).
- Did **not** delete `data/rag-universe-manifest.json`; PDF / `pdf_pages/` left untracked.
- Review CTA switches tabs rather than deep-linking into a single proposal (no deep-link API).
- PWA on-card feedback strip was missing failed/success text despite tracking notices — added
  for true parity with iOS D3 acceptance.
- Unrelated tsc fix: `buildMemberSkillScores` now reads `MemberDualPerformance.tradeDate ??
  .performance` (shared package dual-anchor shape) instead of flat fields that no longer typecheck.
- Main Wave D body landed as PR #2424; follow-up on this branch carries the dual-perf tsc fix
  + verified gate receipts after merge with main.

## Verification State

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm run lint          # 0 errors (671 grandfathered warnings)
npx tsc --noEmit      # TSC_EXIT:0
npx vitest run test/mobile-pwa-client.test.tsx test/congress-analytics.test.ts
                      # 26 passed
npm test              # 508 files / 5936 tests passed
npm run build         # BUILD_EXIT:0 (compiled with warnings)
xcodebuild -project "ios/Socratic Trade.xcodeproj" -scheme SocraticTrade \
  -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
                      # ** BUILD SUCCEEDED **
```

## Next Steps & Blockers

1. Land dual-perf follow-up via `scripts/land.sh`; auto-merge when verify green.
2. Optional follow-ups: Live Activities / push (Wave F2), full Coach chat on iOS (F3).
3. Sibling worktrees `grok/ux-d4-pwa-polish` and `grok/ux-d-ios-brand-home` can discard once
   main has absorbed Wave D (#2424).

## Zero-Code Findings

None beyond absorbing sibling partials that had not yet committed.
