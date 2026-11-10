# 2026-08-03 — iOS / mobile account switch: immediate `account.activate`

## Context & Objective

Owner reported that the mobile iOS app (native Account & Settings sheet) does not switch accounts well: tapping **Use** on a non-active account (e.g. Roth IRA) left a spinner while **Sandbox** stayed Active on Home, with **Stale 14 minutes ago** and **2 queued · 1 running** on the agent card.

Goal: make connected-account switching reliable on iOS and the mobile PWA even while a strategy run is in flight or the snapshot is stale.

## Changes Made

Root cause: `account.activate` was a normal queued mobile command. The sequential worker processes one command at a time globally; a long `strategy.run_once` left `account.activate` (and the iOS `Use` busy spinner) waiting for the full run. Separately, both iOS and PWA gated account switch on **fresh** snapshot data (`canSubmit` / `canSubmit === fresh`), so a stale Home screen also blocked switching.

1. **Server — immediate path for `account.activate`**
   - Extended the immediate mobile command set (already used by stop/close_only/liquidating) to include `account.activate`.
   - `POST /api/mobile/commands` now runs it via `executeMobileCommandImmediately` in the same request (pure active-pointer flip; no broker I/O).
   - Still view-only: does not mutate per-account strategy run-state (PR #7 invariant preserved).

2. **iOS**
   - `MobileStore.canSubmit("account.activate")` allowed whenever any snapshot is loaded (including stale).
   - Busy spinner cleared from the terminal POST response **before** snapshot reload (immediate commands no longer look stuck during a slow `/api/mobile/snapshot`).
   - Account row **Use** button more visible (`borderedProminent` + disabled opacity).

3. **Mobile PWA**
   - New `canSubmitAccountSwitch` in `getMobileCommandAvailability` — available whenever online + loaded + idle, even if freshness is stale/refreshing/unknown.
   - Header account `<select>` uses that flag; no-ops when re-selecting the already-active id.

### Files touched

- `src/lib/mobile-api.ts`
- `app/api/mobile/commands/route.ts`
- `ios/SocraticTrade/MobileStore.swift`
- `ios/SocraticTrade/HomeView.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `app/mobile/mobile-pwa-client.tsx`
- `test/mobile-view-scope.test.ts`
- `test/mobile-pwa-client.test.tsx`
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Immediate set is intentionally small: protective state + account pointer only. Watchlist/alerts/policy still use the sequential worker (they can be slower and are not as user-critical mid-run).
- Account switch remains **metadata-only** (active pointer). Per-account systemState / arming is unchanged — matching console `POST /api/connected-accounts/:id/activate`.
- Native iOS App Store build still needs a separate Xcode ship for the Swift UI/busy fixes; **server-side immediate activate helps any already-installed client** the moment prod deploys (POST returns `succeeded` instead of `queued`).

## Verification State

```bash
npm rebuild better-sqlite3   # worktree node ABI drift
npx vitest run test/mobile-view-scope.test.ts test/mobile-pwa-client.test.tsx test/mobile-stop-preemption.test.ts
# 16/16 passed
npx tsc --noEmit
```

Full `npm test` / `npm run build` via `scripts/land.sh` before merge.

## Next Steps & Blockers

- Land + auto-deploy; retest on phone: Account & Settings → Use on a non-active account while a run is active — spinner should clear in ~1s and Active badge should move.
- Optional follow-up: ship a native App Store build with the Swift client polish; not required for the server fix to take effect.
- Optional: if global mobile command queue still starves non-immediate actions under multi-user load, consider per-user workers (out of scope here).

## Zero-Code Findings

N/A — code fix.
