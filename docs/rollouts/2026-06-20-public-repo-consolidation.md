# Rollout: 2026-06-20 public-repo consolidation

## Summary
Consolidated the public `jaywedgeworth22/public` ("Atlas" BFF) effort into the private `robinhood-agentic-trading` repo: imported design docs, archived reference material, and ported user watchlist + price alerts into the Next.js runtime.

## Why
The public repo explored chat-first assistant patterns (RAG, watchlist, alerts, Test-vs-broker honesty) in a standalone Node BFF. The private dashboard is the canonical product; this rollout merges the valuable runtime gaps and preserves the public work as reference rather than maintaining two divergent apps.

## Files
- `docs/atlas/` — multi-expert analysis + deep dives from public repo
- `docs/atlas-integration-map.md` — feature mapping (ported vs deferred)
- `reference/atlas-public/` — README, MILESTONES, DEPLOY snapshot
- `PROJECT.md` — consolidated milestone tracker
- `src/lib/watchlist.ts`, `src/lib/alerts.ts`
- `src/lib/db.ts` — `user_watchlist`, `price_alerts` tables + accessors
- `src/lib/types.ts` — `PriceAlert`, `WatchlistItem`, `price_alert` notification type
- `src/lib/defaults.ts`, `src/lib/notifications.ts`, `src/lib/scheduler.ts`
- `app/api/watchlist/route.ts`, `app/api/alerts/route.ts`
- `test/watchlist-alerts.test.ts`

## Verification
```bash
npx tsc --noEmit   # clean
npm test           # 39 files, 287 tests passed
npm run build      # clean; /api/watchlist and /api/alerts registered
```

## Follow-ups
- Dashboard UI for watchlist panel + one-click alert creation from watchlist rows
- Optional chat assistant tab using Atlas orchestrator patterns (`docs/atlas-integration-map.md`)
- Fast-forward `agent/antigravity` worktree to `main` (was 17 commits behind at consolidation time)
- Discard or commit stale uncommitted edits in `~/apps/trading-codex` if they duplicate shipped R3 tax work
