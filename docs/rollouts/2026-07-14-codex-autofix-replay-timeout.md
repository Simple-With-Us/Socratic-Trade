# Codex autofix: Add timeout to usage-monitor replay sends

## Summary

Adds a 30-second AbortSignal timeout to `sendUsageMonitorBatch()` so a hung
POST connection cannot permanently block the replay interval's inFlight guard.

## Why

Codex P2 review finding on PR #1563: the `runUsageMonitorReplay` function
deduplicates concurrent calls through a `replayState.inFlight` promise guard,
which is only cleared when the promise settles. If the POST to the usage
monitor hangs at the network layer (never resolves or rejects), every subsequent
one-minute interval returns the same stuck promise and no further ledger rows
are replayed until the process restarts. The fix wraps the fetch call in an
AbortSignal with a 30-second timeout so that a stalled connection reliably
resolves (via abort rejection) and the inFlight guard is cleared.

## Files

- `src/lib/usage-monitor-push.ts` — `sendUsageMonitorBatch()` now creates its
  own AbortController with a 30s `setTimeout` and passes the signal through to
  the underlying fetch, inlined instead of calling `postBatch()` so the timeout
  applies only to the replay path.

## Verification

```
npx tsc --noEmit        → clean
npm test (replay+push)  → 2 files / 16 tests passed
npm run lint            → 0 errors (455 pre-existing warnings)
npm run build           → clean
```

## Follow-ups

Two other Codex findings on the same PR remain open:
1. **Cursor indexes** (P2): add `(created_at, id)` indexes to `llm_usage` /
   `rag_usage` before production replay activates — performance concern, not a
   correctness bug.
2. **Same-millisecond rows** (P2): a concurrent write landing after the page
   read but before the watermark write, with a lexicographically smaller UUID
   in the same millisecond, could be missed on subsequent passes — architecturally
   significant, maintainer asked for input.
