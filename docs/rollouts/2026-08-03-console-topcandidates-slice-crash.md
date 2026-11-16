# Console dashboard crash: `topCandidates.slice` on partial latestScan

## Context & Objective

Owner reported the main console (`/console`) white-screening with:

```
Dashboard error
undefined is not an object (evaluating 'r.topCandidates.slice')
Try again
```

Goal: restore the home dashboard without requiring a data wipe or fresh scan.

## Changes Made

- **Root cause:** `deriveEvidenceRows` in `app/console/page.tsx` treated any truthy
  `snapshot.latestScan` as a full `MarketScan` and called `scan.topCandidates.slice(0, 3)`.
  Persisted audit shapes (`strategy_run.marketScan`, interactive `market_scan` payload) can be
  truthy objects that omit `topCandidates` (or carry incomplete arrays). That threw on render of
  every `ProposalRow`, which Next error-boundaryed as "Dashboard error".
- **Client fix:** new `safeTopCandidates()` helper (`app/console/lib/evidence-rows.ts`) returns
  `[]` when the field is missing/non-array, and only keeps candidates with a non-empty `symbol`.
  Evidence rows also tolerate missing `decision.evidence` / `decision.ragAttributions`.
- **Server fix:** `getDashboardSnapshot` normalizes `newestScan` so `topCandidates`, `warnings`,
  `sectorBySymbol`, and `quotesBySymbol` are always present arrays/objects before exposing
  `latestScan` to the client.
- **Regression test:** `test/console-evidence-rows.test.ts`.

Touched files:

- `app/console/page.tsx`
- `app/console/lib/evidence-rows.ts` (new)
- `src/lib/dashboard.ts`
- `test/console-evidence-rows.test.ts` (new)
- `docs/rollouts/2026-08-03-console-topcandidates-slice-crash.md`
- `STATUS.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Prefer defensive normalization over rejecting partial scans entirely: the scan summary row
  (breadth / source attribution) is still useful when candidates are missing.
- Did not rewrite every other `topCandidates` call site (strategy loop, scan table). The scan
  destination already gates via `asFullMarketScan`; the money-path strategy code always builds a
  full scan in-process. This fix targets the console evidence path that was white-screening prod UI.

## Verification State

```bash
npx tsc --noEmit
npm test -- test/console-evidence-rows.test.ts
npm run lint
npm test
npm run build
```

(Targeted evidence-rows tests green; full gate run before land.)

## Next Steps & Blockers

- After merge: auto-deploy; hard-refresh `/console` and confirm Latest strategy run cards render.
- Optional follow-up: audit whether any `strategy_run` rows are intentionally storing marketScan
  without candidates (payload size) and, if so, document that shape in `MarketScan` comments.

## Zero-Code Findings

None beyond the root-cause analysis above.
