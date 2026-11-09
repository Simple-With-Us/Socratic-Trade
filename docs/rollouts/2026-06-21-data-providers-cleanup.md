# 2026-06-21 — Minor cleanup: data-providers alias + db.ts notional comments

## Summary

Small, self-contained cleanup with zero behavior change:

1. Removed the unused export `export const fallbackProvider = mockEnrichmentProvider;`
   from `src/lib/data-providers.ts`. `noopProvider` (the other alias for
   `mockEnrichmentProvider`) was kept because it is referenced by
   `test/data-providers.test.ts`.
2. Added two one-line clarifying comments in `src/lib/db.ts` (in
   `dailyExecutionStats` and `notionalInLastMinutes`) noting that the notional
   caps intentionally count only OPENING trades (buy/short); closing trades
   (sell/cover) are risk-reducing and therefore exempt (notional = 0).
   Comments only — no logic changed.

## Why

- `fallbackProvider` was dead code: `git grep -n "fallbackProvider"` confirmed it
  was referenced only on its own definition line and nowhere else. Removing it
  reduces a misleadingly-named public alias (see the AGENTS.md guidance that real
  data must never be labeled "fallback"/"mock" in user-facing contexts).
- The `: 0` branch for sell/cover sides in the notional helpers is intentional
  (closing trades reduce risk and shouldn't consume opening-notional caps), but
  it was unexplained and easy to mistake for a bug. The comments make the intent
  explicit for the next agent touching risk/notional accounting (AGENTS.md
  flags `src/lib/db.ts` daily-notional tracking as high-risk for short/cover).

## Files

- `src/lib/data-providers.ts` — removed the `fallbackProvider` export line.
- `src/lib/db.ts` — added a clarifying comment in `dailyExecutionStats` and in
  `notionalInLastMinutes`.
- `STATUS.md` — added a dated entry at the top of `## Active Focus`.
- `docs/rollouts/2026-06-21-data-providers-cleanup.md` — this note.

## Verification

Run in the `claude/minor-cleanups-data-providers` worktree:

```bash
git grep -n "fallbackProvider"   # only the definition line; nothing else -> safe to remove
npx tsc --noEmit                 # exit 0, no errors
npm test                         # 47 files, 371 tests passed
npm run build                    # exit 0, build OK
```

Results:

- `git grep -n "fallbackProvider"` before the edit: a single hit at
  `src/lib/data-providers.ts:249` (its own definition). No other references.
- `npx tsc --noEmit`: clean (exit 0).
- `npm test`: 47 test files passed, 371 tests passed.
- `npm run build`: succeeded (exit 0).

## Follow-ups

- None. Scope was deliberately limited to the two named files plus docs; no
  changes to policy.ts, trade-proposal/revalidation/expiry logic, or UI.
