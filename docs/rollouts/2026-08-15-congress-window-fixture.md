# Congress live-flow fixture aged out of the 60-day window

## Context & Objective

`test/web-sources.test.ts` "scrapes, persists, and exposes a usable signal" failed on
`main` immediately after #2720 merged, and on every PR that had merged `origin/main`.
The first assertion (`recordCount >= 1`) still passed; `getSymbolWebSignals(["NVDA"]).congress.buyCount`
was `undefined`.

## Changes Made

- The live-flow fetch stub used hardcoded Senate eFD dates `06/16/2026` (disclosed)
  and `06/10/2026` (traded). Default `WEB_SOURCE_CONGRESS_WINDOW_DAYS` is 60.
  At `2026-08-15T00:13Z`, `Date.now() - 60d` is `2026-06-16T00:13Z`, so
  `Date.parse("2026-06-16")` falls 13 minutes outside the window and the overlay
  is omitted.
- Fixture dates are now relative (`now - 3d` / `now - 7d`) so they stay inside
  the default window.

Touched: `test/web-sources.test.ts`, `docs/EFFORT-LOG.md`.

## Decisions & Trade-offs

Parser unit tests still use the June 2026 literals — they do not go through
`aggregateCongressSignals`. Only the live-flow stub needed to move.

## Verification State

Local: patch is date-math only. CI `verify-hosted` on the next PR push is the
proof (same assertion that failed on main run 31851986924).

## Next Steps & Blockers

Cherry-picked onto the remaining open ST PRs so they do not all fail the same
way. After one of them merges, main is green again.
