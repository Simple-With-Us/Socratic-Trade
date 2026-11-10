# 2026-08-04 — UX Wave C speed (C1–C4)

## Context & Objective

Implement **UX Wave C** from `docs/design/ux-improvement-program.md` and
`IMPROVEMENTS-2026-07-07.md`: perceived + real console speed without touching the
money path. Correctness first (especially multi-account snapshot isolation and
FIFO P&L numbers).

Branch: `grok/ux-wave-c-speed`.

## Changes Made

### C1 — Dashboard snapshot short TTL cache
- New `src/lib/dashboard-snapshot-cache.ts`: in-memory Map + single-flight, TTL
  default **10s**, key `(userId, accountNumber)` via `userId\0accountNumber`.
- `getDashboardSnapshot` resolves the active account number for the key, then
  `getOrComputeDashboardSnapshot` → `computeDashboardSnapshot`.
- Invalidation on `setPolicy` (user-wide) and proposal approve/reject routes.
- Tests: key isolation (user × account), TTL expiry, invalidate scopes, single-flight.

### C2 — FIFO P&L compute-once per request
- Export `PnlResult` / `PrefetchedPnl`; `pnlForSource` prefers precomputed P&L.
- Dashboard computes `calculatePnl(liveFills)` + `calculatePnl(paperFills)` once
  and threads into `getPerformanceSummary`, thesis/regime scorecards, and
  `getTaxSummary` (closed/open lots + wash locks).
- Test counter `getCalculatePnlCallCountForTests` proves scorecards skip replay.

### C3 — Scan table virtualization
- `app/console/scan/scan-table.tsx` desktop path uses `TableVirtuoso`
  (`react-virtuoso` already in package.json).
- Sticky symbol column CSS preserved (`STICKY_CELL` / hover wash).
- Viewport height capped (~560px) so ~100 rows virtualize.

### C4 — React.memo + home derives
- `memo(...)` on `PositionsCard`, `EquityChart`, `ScanTable`, `ApprovalCard`.
- Console home wraps pure derives in `useMemo([snapshot])`.

### Files touched
- `src/lib/dashboard-snapshot-cache.ts` (new)
- `src/lib/dashboard.ts`
- `src/lib/performance.ts`
- `src/lib/tax.ts`
- `src/lib/db-profiles.ts`
- `app/api/proposals/[id]/approve/route.ts`
- `app/api/proposals/[id]/reject/route.ts`
- `app/console/scan/scan-table.tsx`
- `app/console/components/positions.tsx`
- `app/console/components/equity-chart.tsx`
- `app/console/components/approval-card.tsx`
- `app/console/page.tsx`
- `test/dashboard-snapshot-cache.test.ts` (new)
- `test/performance-prefetched-pnl.test.ts` (new)
- `test/dashboard-fill-batching.test.ts` (cache reset in afterEach)
- `docs/rollouts/2026-08-04-ux-wave-c-speed.md`
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`

## Decisions & Trade-offs

1. **TTL + invalidate, not write-through**: short soft TTL is the safety net;
   policy + approve/reject invalidate immediately. Strategy-run completion and
   mobile commands still refresh within ~10s if invalidate is missed (acceptable).
2. **syntheticPaperCurve still calls calculatePnl** when no paper portfolio
   snapshots exist — outside the scorecard/tax hot path; not rewritten in this
   wave.
3. **Stream/freshness context split (IMPROVEMENTS #7a)** deferred — memo on
   leaves + useMemo on derives is the C4 acceptance slice without a larger
   console provider refactor.
4. **Mobile scan cards** remain unvirtualized (short lists; desktop was the
   100×13 cell cost).

## Verification State

```bash
# Targeted (ran clean, 13/13)
node_modules/.bin/vitest run \
  test/dashboard-snapshot-cache.test.ts \
  test/performance-prefetched-pnl.test.ts \
  test/dashboard-fill-batching.test.ts
# scan-table-columns also green (6)

# Full land.sh gate (tsc → test → build → PR) — host was under multi-agent
# tsc load; land.sh re-runs the authoritative gate.
bash scripts/land.sh
```

## Next Steps & Blockers

- If parallel Wave C PRs (#2415 C3, #2420 C1/C2, #2423 full) merge first,
  rebase/resolve and re-verify; prefer one coherent Wave C land.
- Optional follow-ups (deferred): invalidate on strategy_run completion /
  mobile command terminal; split stream context; virtualize mobile scan cards;
  syntheticPaperCurve reuse of prefetched closed-lot path.

## Zero-Code Findings

None beyond noting fleet board already had multiple Wave C implementer PRs
in flight — this branch is the full C1–C4 stack for `grok/ux-wave-c-speed`.
