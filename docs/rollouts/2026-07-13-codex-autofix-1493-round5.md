# Codex Autofix Round 5 — PR #1493

**Date:** 2026-07-13
**Branch:** `ag/troubleshoot-sentry`
**PR:** #1493 — Add clearCache option to admin reindex endpoint

## Summary

Addressed 2 P2 Codex findings from the round-4 follow-up review:

1. **Count market cap before skipping cards** — `buildFundamentalsContext` renders a Market Cap line via `data.marketCap`, but the `hasRealField` emptiness guard did not check it. Added `marketCap` to the guard (safe cast since it's on `MarketQuote`, not `SymbolEnrichment`).

2. **Treat empty fundamentals as a skip** — When all providers returned no usable data, the guard returned `{ skipped: true, error: "Empty fundamentals data..." }`. The caller pushes `fundResult.error` to `result.errors`, causing the admin reindex route to report `ok: false` even when the filing reindex itself succeeded. Changed to `{ skipped: true }` without the `error` field, so an empty card silently skips without polluting the error list.

## Change

**File:** `src/lib/web-sources/sec-filings.ts` (function `ingestFundamentalsCard`)

- Added `(data as any).marketCap != null` to the `hasRealField` guard (line 643-645)
- Changed the all-empty return from `{ skipped: true, error: ... }` to `{ skipped: true }` (line 667)

## Verification

```
npx tsc --noEmit  → clean (0 errors)
npm test          → 350 files / 3930 tests passed
npm run build     → compiled successfully
```

## Files Touched

- `src/lib/web-sources/sec-filings.ts` — added marketCap to emptiness guard, removed error from empty-card return
- `STATUS.md` — added round 5 entry
- `docs/rollouts/2026-07-13-codex-autofix-1493-round5.md` — this note

## Resolved Threads

Two P2 threads resolved:
- "Count market cap before skipping cards"
- "Treat empty fundamentals as a skip"
