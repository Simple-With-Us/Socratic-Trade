# 2026-07-09 — Enrichment starvation: force-included scan candidates (holdings + event outliers) never enriched

**Agent:** MONET (worktree `bold-lamport-20a8f9`, branch `monet/bold-lamport-20a8f9`)

## Summary

Fixed the enrichment-starvation bug diagnosed earlier today (effort-board row, prod run
2026-07-09T19:41Z: exactly 30 of 42 candidates enriched). `scanMarket` builds
`topCandidates = top-candidateLimit ranked (30) + up to 8 event outliers + ALL held
positions` and passes every symbol to `provider.enrich(...)`, but every enrichment
provider sliced its symbol list to `maxSymbols()` = `DEFAULT_MAX_SYMBOLS = 30`
(first-wins). The force-included extras past index 30 — systematically the owner's HELD
names (AAPL, GOOG, V, KO…) and event outliers — got zero fields from every provider:
blank Fundamentals drawer, neutral-50 factor defaults, and no fundamentals for the
LLM/FCF-veto on exactly the positions the agent owns.

Three changes:

1. **Budget covers the real candidate set** (`src/lib/data-providers.ts`). The
   `DEFAULT_MAX_SYMBOLS = 30` constant is gone; `maxSymbols()` now derives the
   per-provider budget from the same scan-shape knobs the scan itself reads:
   `normalizeMarketScanCandidateLimit(MARKET_SCAN_LIMIT)` +
   `normalizeMarketScanOutlierReserve(MARKET_SCAN_EVENT_RESERVE)` + a
   `HELD_SYMBOL_ALLOWANCE = 12`, capped at the existing `MAX_SYMBOLS_CAP = 50`
   (default: 30 + 8 + 12 → 50). This restores the constant's documented intent
   ("cover the default scan candidate set") structurally instead of hardcoding the
   observed 42. `FMP_MAX_SYMBOLS` remains an absolute operator override (still capped
   at 50). **Semantics change:** `MARKET_SCAN_LIMIT` used to be consumed directly as
   the enrichment budget; it is the *candidate limit*, so the budget now sits above it
   (reserve + held allowance on top) — an operator wanting a hard enrichment cap uses
   `FMP_MAX_SYMBOLS`.
2. **Priority ordering at the enrich call** (`src/lib/market.ts`). The symbol list
   passed to `provider.enrich()` is now ordered `heldExtra → eventExtra → ranked
   top-N`. Providers slice first-wins, so if a budget shortfall ever recurs (e.g. >50
   candidates, or a provider-specific lower budget like Webull's 20), it starves the
   tail of the ranked list — never the names the agent owns or force-included.
   `topCandidates` itself (display/return order) is unchanged and is re-sorted by
   score after enrichment as before.
3. **Tooltip honesty** (`app/console/ui/drilldown-data.ts` `withProvenance`,
   `src/lib/dashboard-ui.ts` `cellTitle`). Both stamped `"Received <time>"`
   (`receivedLabel(asOf)`) even when the field had no recorded source — claiming
   freshness for data no provider returned (a blank cell hovering as "Received
   2:00 PM"). The freshness stamp now rides provenance: no per-field source → neither
   `Source:` nor `Received` is appended.

## Why

Real-money correctness: the starved symbols were systematically the owner's held
positions, so the LLM decided exits/holds with no fundamentals and the FCF veto never
saw FCF data for owned names. The tooltip fix is the "never label absent data as
present" honesty rule applied to freshness stamps.

## Quota safety

`MAX_SYMBOLS_CAP = 50` still bounds worst-case cost (Finnhub free tier 60 calls/min;
the shared per-provider pacer from PR #1087 — `src/lib/provider-rate-limit.ts` — spaces
the extra calls; the 6h enrichment cache means only the first run per TTL window is
heavy). Alpha Vantage (25/day, effectively dead) is governed by its own key-pool/daily-cap
handling; the slice only bounds what's attempted. Webull's separate
`WEBULL_UNOFFICIAL_MAX_SYMBOLS` (default 20) was deliberately left alone — it's an
optional quote-family booster; with the new priority ordering its 20-slice now covers
held + outliers first, which is the desired bias.

## Files

- `src/lib/data-providers.ts` — scan-shape-derived `maxSymbols()`, `HELD_SYMBOL_ALLOWANCE`,
  import of `scan-settings` normalizers; `DEFAULT_MAX_SYMBOLS` removed.
- `src/lib/market.ts` — enrichment call ordered held → outliers → ranked.
- `app/console/ui/drilldown-data.ts` — `withProvenance` gates Source/Received on recorded source.
- `src/lib/dashboard-ui.ts` — `cellTitle` same gating.
- `test/data-providers.test.ts` — new describe "enrichment symbol budget covers the full
  scan candidate set (starvation regression)": 42-symbol prod shape fully covered;
  `MARKET_SCAN_LIMIT=30` no longer collapses the budget; `FMP_MAX_SYMBOLS` override +
  50-cap still enforced.
- `test/console-drilldown.test.ts` — `withProvenance` freshness-gating test.
- `test/dashboard-ui.test.ts` — `cellTitle` freshness-gating test.
- `README.md`, `docs/settings-navigation-redesign/appendix-B-capability-inventory.md` —
  `FMP_MAX_SYMBOLS` docs updated to the new semantics.
- `STATUS.md`, `docs/EFFORT-LOG.md` — protocol updates (made in the landing commit by CLAUDE;
  the MONET session left STATUS.md unedited — gap closed at landing). The live board
  `/Users/jay/apps/TRADING-EFFORT-LOG.md` is owned by the usage-cap pickup session, not this
  landing.

`PLAN.md` and phase docs unchanged — bug fix, no scope/approach change.

## Verification

```bash
npm run lint       # 0 errors (368 grandfathered warnings)
npx tsc --noEmit   # clean
npm test           # 3176 passed / 306 files (includes 5 new tests)
npm run build      # clean
```

Fresh worktree note: `node_modules` was absent; `NODE_AUTH_TOKEN=$(gh auth token) npm ci`
installed clean (known recipe).

## Follow-ups / risks

- The held allowance (12) is a heuristic; a portfolio with >12 held names outside the
  top-38 would starve ranked-tail names (never holdings, thanks to the ordering). If the
  owner's book grows past that, raise `MAX_SYMBOLS_CAP` deliberately (quota review) or
  add a positions-count-aware budget.
- User-settings `marketScanCandidateLimit` (up to 100) can exceed what the cap-50 budget
  covers; ordering guarantees holdings/outliers survive, ranked tail past ~50 stays
  unenriched — inherent to the cost cap, unchanged from before.
- Optional honesty follow-up: an explicit "not returned by any provider in the last
  scan" line on value-less fields (needs value-awareness at the call sites;
  `withProvenance` alone can't distinguish value-present-unsourced fields like
  screener-supplied `volume`).
- Peer PR #1222 (TwelveData window/negative-cache) may also touch
  `src/lib/data-providers.ts`; if it lands first, `land.sh` will require a manual
  review-merge — expected, not a conflict of intent.

## Landing addendum (CLAUDE, 2026-07-09, owner-directed usage-cap pickup)

MONET's session ended with this work uncommitted; CLAUDE committed and landed it verbatim
(design unchanged). Landing steps and verification:

- Committed MONET's tree as-is, then merged `origin/main` (16 commits behind, incl. the
  Drizzle `db-settings` migration #1204 and PR #1222's TwelveData negative-cache — the
  latter touches a different region of `src/lib/data-providers.ts`; git auto-merged
  cleanly and BOTH changes are kept). `npm install` was required post-merge (new
  `drizzle-orm` dependency).
- Focused re-run post-merge: `npx vitest run test/data-providers.test.ts
  test/console-drilldown.test.ts test/dashboard-ui.test.ts` — 132/132 passed.
- Full gate re-run post-merge (`npm run lint`, `npx tsc --noEmit`, `npm test`,
  `npm run build`) — results recorded in the landing PR; landed via `bash scripts/land.sh`
  with `gh pr merge --squash --auto`.

## Owner-ruling revision (MONET, 2026-07-09, session `aapl-fundamentals-missing-e3ea01`, supersedes the budget-derivation semantics above)

After PR #1272 went up, the owner ruled in-session: **no hard enrichment-symbol cap** —
"there doesn't need to be a hard cap at all, or if there is one it should be multiple
hundreds"; more than 50 positions in one account is a supported future. The derivation
above (`candidateLimit + reserve + HELD_SYMBOL_ALLOWANCE`, capped at 50) would silently
re-create the starvation the day the account outgrows it, and a fixed 12-name held
allowance is the same bug at a different number.

Revised semantics (this branch, landed on top of the #1272 content):

- `maxSymbols()` returns `Infinity` unless `FMP_MAX_SYMBOLS` is set — providers enrich
  **every symbol they're asked for**; the scan's candidate list IS the budget.
  `HELD_SYMBOL_ALLOWANCE`, `MAX_SYMBOLS_CAP`, and the scan-settings derivation are gone.
- `FMP_MAX_SYMBOLS` stays as an EXPLICIT operator throttle, now **unclamped** (a
  silently-clamped override is a cage, not a setting — guardrails philosophy).
- `WEBULL_UNOFFICIAL_MAX_SYMBOLS` env override unclamped too (default 20 unchanged);
  `ROBINHOOD_OPTIONS_MAX_SYMBOLS` added for the options tier's own first-N slice
  (default 20 unchanged).
- Quota realities stay where they belong: per-provider pacers (provider-rate-limit.ts),
  TwelveData's credit window + negative cache (#1222), the Alpha Vantage daily key pool,
  and the 6h fundamentals cache. Known trade-off: a cold scan over a large candidate
  list takes longer (finnhub pacer ≈ 1.2s/call × 5 calls/symbol); the strategy path has
  no timeout so it stalls rather than blanks, and the 6h cache makes only the first run
  heavy. The kept enrichment-priority reordering (held + outliers first) also decides
  who wins scarce TwelveData credits.
- Regression tests updated: unclamped override (60 > old cap honored), no-env 120-symbol
  list fully enriched, plus the two #1272 coverage tests unchanged.

## Disposition (MONET, 2026-07-10): PR #1272 closed superseded; codex round-2 findings

Two `chatgpt-codex-connector` threads blocked #1272's armed auto-merge — both REAL:
(1) held names INSIDE the ranked top-N could still starve (round-1's order only
front-loaded `heldExtra`, so a holding ranked inside a large top-N sat behind all the
extras in the first-wins slice); (2) user-policy scan shapes (`scanMarket` options from
the settings UI) bypassed any env-derived budget. Round-2 fixes — a stable-sort
`orderCandidatesForEnrichment` helper (all held → outliers → rest by rank) and a budget
simplified to `min(FMP_MAX_SYMBOLS ?? 50, 50)` — were pushed to the branch (`36d613b8`,
gate green at 3219 tests) and the threads replied-to and resolved. But #1287 had
meanwhile merged this branch's content (at `90c55579`) and revised it per the
owner-ruling section above, which addresses BOTH findings structurally: held-in-top-N
names are hoisted in main's enrichment order, and with no cap at all no scan shape can
be under-covered. That same ruling makes the round-2 cap-50 budget obsolete — a hard
ceiling is exactly what the owner ruled out — so #1272 was closed as superseded
(2026-07-10T05:30Z, closure comment on the PR) rather than conflict-resolved into a
near-empty diff. Nothing from it is lost on main except the deliberately-dropped cap;
the branch survives as `monet/bold-lamport-20a8f9`. Boards: effort row flipped to
✅ Completed-via-#1287 (repo mirror + live board), Planned-section duplicate
annotations consolidated. Deploy: `main@597b991c` (includes #1287) went out under the
ANNOUNCE-THEN-DEPLOY claim of 2026-07-10T05:35Z; the deployer session owns
health-verify and the Deployed flips.
