# 2026-08-22 — Alpaca Paper Approve greyed after Retry Red Team

## Context & Objective

Owner reported from mobile: pending proposals on Alpaca Paper, Retry Red Team yesterday did not work, and Approve is now greyed.  This restores a clickable owner Approve, makes Retry apply its verdict, and lets that click place an opening on an Exit-only account without caging the owner.

## Changes Made

Production ops snapshot at 2026-08-22 ~12:57Z showed Alpaca Paper (`4f7c96ba-4d47-45cc-abea-6e4f155aee38`, `PA33IDTHMFK9`) in `close_only` / Exit-only / Autopilot.  Recent Paper runs on 2026-08-21 are gather-timeout / stale-run-sweep failures.  Last successful Paper run was 2026-08-20 19:55Z ("Awaiting approval: 3").  Ops audit has no `red_team_retry` kind, so yesterday's hang is not in that snapshot.

Three stacked bugs:

1. Website approval cards share one `busy` flag across Approve / Reject / Retry.  A hung or multi-minute Retry (quote scan + Red LLM) greys Approve for the whole wait, and a leftover tab stays grey.  iOS `canSubmit("proposal.approve")` dies after a 180s stale snapshot or `snapshotLoadFailed`; Retry is a long LLM, then `load()` can miss the 30s mobile timeout.
2. `retryProposalRedTeam` stamped a new verdict and did not apply it (expert review llm-06).  The strategy loop haircuts `approve-at-half`, holds reject / unavailable for one owner decision, and retries now do the same.  A reject keeps the card pending.
3. `freshPlacementBlockReason` blocked buy/short in `close_only` on the human Approve path too (`executeProposal`).  A working button would claim the row as placing, then mark it `blocked`.  Autonomous placement still uses the default fence.

- `src/lib/system-state-placement-guard.ts` — `owner_approval` source: Exit-only openings allowed; halted and liquidating openings still blocked
- `src/lib/strategy-execution.ts` — human placement fence passes `source: "owner_approval"`
- `src/lib/retry-red-team.ts` — apply retry verdict + sizing context; no `strategy.ts` import
- `src/lib/proposal-actions.ts` — `EXIT_ONLY_OWNER_APPROVE_NOTE`
- `app/console/components/approval-card.tsx` — Approve/Reject ignore Retry busy; Exit-only banner
- `app/console/page.tsx` — remount Home live-confirm input after a non-409 failure (DeepSeek P1 cf62f87a)
- `app/console/lib/derive.ts` — Exit-only copy names the owner override
- `ios/SocraticTrade/MobileStore.swift` — Approve available on a stale snapshot when a snapshot is loaded
- `ios/SocraticTrade/ProposalsView.swift` — Exit-only banner
- `ios/SocraticTrade/DeskModels.swift` / `HomeView.swift` / `AgentControlPlan.swift` — matching copy
- `ios/SocraticTradeTests/MobileModelsTests.swift` / `UserFacingCopyTests.swift`
- `test/retry-red-team.test.ts` — haircut + reject-hold
- `test/system-state-placement-guard.test.ts` — new
- `test/proposal-action-state.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-22-alpaca-paper-approve-greyed.md`

## Decisions & Trade-offs

Owner click is the Exit-only override.  The agent still will not open new risk on its own.  Halted still means nothing new leaves, including human Approve.  Winding down stays exits-only on both paths.  Retry-reject does not drop the pending card — the owner is already looking at it.  Did not re-add paper-as-default or a second confirmation ritual.  Did not HOTFIX or bounce Coolify.  Linux Cloud VM cannot compile Swift; `ios-build` on the Mac runner is the Swift gate.

## Verification State

```
npm run lint                          # 0 errors (773 grandfathered warnings)
npx tsc --noEmit                      # clean
npx vitest run test/retry-red-team.test.ts test/system-state-placement-guard.test.ts test/proposal-action-state.test.ts test/mobile-stop-preemption.test.ts
                                      # 13 passed
npm run build                         # Next.js production build succeeded
```

PR #3049 CI: `verify` + `verify-hosted` + `ios-build` (unsigned) SUCCESS (runs 32710040803 / 32710040756).

Production: `scripts/verify-deploy-sha.sh 06a5418b` PASS against live sha `dcfd04d72999cfd39bdf8b7351a2e474806944e1` (2026-08-24).  Re-checked 2026-08-24 23:45Z: still PASS; health ok; schedulerAgeSeconds 50.

Docs handoff #3087 squash `3fcf876e` is on `main` (docs-only; Coolify `watch_paths` omit `docs/**` / `STATUS.md` / `PLAN.md`, so no image deploy expected or needed).

Focused re-run 2026-08-24 23:45Z: `npx vitest run test/retry-red-team.test.ts test/system-state-placement-guard.test.ts test/proposal-action-state.test.ts test/mobile-stop-preemption.test.ts` — 4 files / 13 passed.

## Next Steps & Blockers

None for the website/API fix — live.  Pull to refresh on Proposals if a card still looks stuck from an old tab.  Openings on an Exit-only account show an honest override banner; Paper is `active` again as of the 23:45Z ops snapshot.

Native iOS is **not** on TestFlight from this work.  After #3083, `ios-ship.yml` runs on GitHub-hosted `macos-latest` and every scheduled tick fails: `missing /Users/jay/apps/ios-fleet/ship-testflight.sh` (80 red runs in the last window; latest `32788863155`).  No App Store Connect secrets exist on the ST GitHub repo (ASC stays on the Mac).  Do not `workflow_dispatch` ios-ship from a Cloud agent — it will fail the same way.  Restore fleet-ship tooling + ASC on a runner that can archive, or ship from the Mac: `bash scripts/ios-ship-testflight.sh`.

## Zero-Code Findings

Paper was Exit-only at the original report, not halted; it is `active` / Autopilot in the 2026-08-24 23:45Z snapshot.  The grey Approve on a leftover Retry tab / stale iOS snapshot is the UI lock.  Even a working click would have been blocked at the placement fence before this change.  Ops snapshot `recentAudit` still has no `red_team_retry` rows in the last 40 events (all `strategy_run`).
