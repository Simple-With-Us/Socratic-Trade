# 2026-07-02 — /console/scan: Market Scan table + Smart Money (parity-port Wave 2, Claude)

Branch: `claude/console-scan` (cut from `origin/main` @ 48fbe14, i.e. after the Wave-1
foundation PR #321 landed).

## Summary

Built the **Scan destination** of the console parity port: `/console/scan`, the route the
Wave-1 nav already pointed at. One page, two tabs:

1. **Market scan** — a sortable table of the scan's `topCandidates` (Symbol w/ `TickerLogo`
   + `SymbolButton` drilldown, Score, Price, Chg, Vol, P/E, EPS growth, Dividend yield,
   Sentiment, Analyst rating, Congress net, Sector). Every header and cell carries a
   plain-language tooltip; cell tooltips include per-field provenance strictly from
   `quote.sources` (`EnrichmentSources`) via `friendlySource` — never a hardcoded provider —
   plus a "Received …" stamp (scan-level `generatedAt` when the field's own tooltip doesn't
   already carry one). P/E follows the repo rule: `n/a` = `eps <= 0` (real computed
   no-ratio), `—` = data unavailable. A "held" chip marks candidates with
   `positionMarketValue > 0`. Sorting: click headers, missing values last in both
   directions, `aria-sort` set. Mobile: horizontal scroll with a **sticky symbol column**
   whose cell re-derives the row-hover wash (group-hover on an opaque
   `color-mix(--con-fg 6%, --con-surface)` background) so hover stays uniform.
2. **Smart money** — the full cached congressional-trade + insider (Form 4) datasets from
   `snapshot.smartMoney`, with feed metadata (record counts, source labels derived from
   `webSources.*.sources`, fetched-at freshness) from `snapshot.webSources`. Rows use
   `.con-row` hover, BUY/SELL/MIXED chips, `SymbolButton` drilldown, disclosed amount
   bands (congress) / buy-sell transaction counts (insider), UTC-safe date rendering.

**Refresh**: "Refresh scan" calls `GET /api/scan` (the route is a GET, not a POST — it runs
a fresh read-only scan server-side) with a spinner/busy state, success toast (candidates,
scanned symbols, elapsed seconds) or failure toast + a muted inline notice that never
contradicts a populated table (the last good scan stays up). The page auto-fetches once on
mount (matching legacy `MarketScanView`), and the table always shows the **newest** of
{page's own refresh, `snapshot.latestStrategyRun.marketScan`} by `generatedAt`, labeled
with an honest freshness chip ("fresh" vs "last run", "· cached" when applicable).
`MarketScan.source` is displayed as derived from the `+`-joined string
(`formatSourceList`), with the raw string verbatim in the tooltip. Scan warnings render as
a warn-toned notice. Empty states: no scan yet → explanation + "Run scan" button; scan ran
but zero candidates → universe guidance. Light + dark come free from `--con-*` tokens.

## Why

Wave-2 of the multi-agent legacy→console parity port (see
`docs/rollouts/2026-07-02-console-port-foundation.md`). Scan/Smart-Money existed only in
the legacy dashboard (`MarketScanView` / `SmartMoneyView` in `app/dashboard-client.tsx`);
the console nav already linked `/console/scan` as a dead route. Improvements over legacy:
honest newest-scan selection (a strategy run finishing after a manual refresh wins),
missing-last sorting in both directions, sticky identity column on mobile, smart-money
amount bands + insider tx counts surfaced, and toast-based refresh feedback.

## Files

- `app/console/scan/page.tsx` (NEW) — page, tabs, header, refresh action, empty/error states.
- `app/console/scan/scan-table.tsx` (NEW) — sortable table, sticky symbol column, tooltip stamping.
- `app/console/scan/columns.tsx` (NEW) — column defs, per-field provenance tooltips, P/E rule,
  sentiment/rating chips (reuses `sentimentTitle`/`ratingTitle`/`friendlySource`/`receivedLabel`
  from `src/lib/dashboard-ui.ts` — imported, not modified).
- `app/console/scan/smart-money.tsx` (NEW) — congress + insider cards.
- `app/console/scan/use-live-scan.ts` (NEW) — GET /api/scan hook (abortable, supersede-safe,
  discriminated refresh outcome, `newestScan`).
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-scan.md` — handoff docs.

Deliberately untouched (parallel-agent collision constraints): `app/console/console.css`,
`app/console/components/nav.tsx`, `app/console/lib/api.ts`, all other console destinations,
and everything under `src/lib/`.

## Verification

Run in this worktree (fresh `npm ci`, 754 packages):

```bash
npx tsc --noEmit    # clean
npm run lint        # exit 0 — 0 errors; only 2 warnings in new files, both the
                    # grandfathered react-hooks/set-state-in-effect fetch-on-mount idiom
                    # (same pattern as app/console/lib/useConsoleData.tsx)
npm test            # 2241 tests / 234 files, all pass
npm run build       # ok; /console/scan present in the route list (static)
```

Runtime smoke test (production `next start` on a scratch port): `/console/scan` → 200 and
renders the console shell; `GET /api/scan` → real payload (`source:
"nasdaq-delayed-screener+yahoo-finance+congress+congress.trade+finra"`, 501 quotes, 38
candidates incl. 8 outliers, per-field `sources` populated) — confirms the table's field
mapping against live data. Note for other agents: ports 3123 etc. may be occupied by
OTHER worktrees' smoke servers — first attempt on 3123 accidentally hit a sibling agent's
server (hence its 404 for this route); re-ran on a unique port and killed only my PID.

## Post-review pass (same day): merge from main + all 4 Codex findings fixed

PR #327 went `mergeable_state: dirty` when #322 (settings expansions) landed — merged
`origin/main` cleanly (STATUS.md/PLAN.md auto-merged, both sides kept newest-first),
re-ran the full quartet, pushed. Codex then left 4 review findings; each was **verified
against the real code first** and all 4 were valid:

1. **(P1) Stale live scan across account switches** — the page stays mounted when the
   chrome switches the active account, and `/api/scan` runs against the SERVER's current
   active policy, so a retained `live.scan` from the previous account kept winning the
   newest-scan comparison (wrong universe + wrong "held" chips). Fix: `useLiveScan` now
   takes a `scopeKey` (`activeConnectedAccount(snapshot)?.id + policy.accountNumber`);
   on a scope CHANGE (first observation is only recorded — the mount fetch already ran
   under the same server-side scope) it drops the scan and refetches.
2. **(P2) Partial historical run scans could crash** — `latestStrategyRun` is built from
   the raw `strategy_run` audit payload without validation; `src/lib/dashboard.ts` has
   `fullMarketScan()` for exactly this but applies it only to `scanForInternals`, not the
   snapshot field. Fix: new client-side mirror `asFullMarketScan()` (non-empty
   `topCandidates`, string `generatedAt`, first candidate has string `symbol` + numeric
   `price`/`intradayChangePct`; normalizes a missing `warnings` array) gates the run scan;
   plus defensive `typeof` guards on the Score cell and a symbol-shape row filter in the
   table.
3. **(P2) Price provenance misattribution** — verified in `src/lib/market.ts`:
   `mergeQuoteData` can replace `price` and updates quote-level `provider`/`asOf` but NOT
   `sources.price` (its `refreshSideProvenance` refreshes only bid/ask/volume), so
   `sources.price` alone misattributes a merged live price. Client-side fix (src/lib is
   another agent's): new `priceTitle()` names the single provider when quote-level
   `provider` and `sources.price` agree or only one exists, and names BOTH
   ("X + Y (merged quote + enrichment)") when they differ — the pipeline doesn't record
   which value survived, so no single winner is guessed.
4. **(P2) Silent smart-money truncation** — the snapshot slices congress to 12 / insider
   to 8 (`src/lib/dashboard.ts`) while `webSources.recordCount` reports the full feed.
   Fix: subtitles now read "latest 12 of 47 on file" whenever `recordCount` exceeds the
   rendered list, with the cap explained in the tooltip. A fuller (paginated) view stays a
   follow-up below.

Verification after the pass: `npx tsc --noEmit` clean; `npm run lint` exit 0 (same 2
grandfathered warnings); `npm test` 2241/2241; `npm run build` ok. Each PR thread got a
reply describing the fix and was resolved.

### Later Codex rounds (4 more P2s), all verified and handled

5. **(P2) Shorts not marked held** — verified: `marketValue = quantity × mark`
   (`src/lib/dashboard.ts:373`, Alpaca `market_value` likewise), so a short position has a
   NEGATIVE `positionMarketValue` and the old `> 0` check hid its chip. Fix: any non-zero
   finite value now marks the row — positive renders the accent "held" chip, negative a
   warn-toned "short" chip with an honest tooltip (absolute value + why it's negative).
6. **(P2) Congress card order** — verified: the snapshot sorts (and caps) congress rows by
   `tradedAt` while the card is about disclosure recency. Client-side fix: the capped
   subset is re-sorted by `disclosedAt ?? tradedAt` desc and the card tooltip now says
   "most recently disclosed first (trade date shown on each row)". The server's 12-row cap
   itself is still trade-date ordered — changing that lives in `src/lib/dashboard.ts`
   (another lane) and is a follow-up below.
7. **(P2) Zero-candidate scans wrongly discarded** — the first `asFullMarketScan()` cut
   required a NON-empty `topCandidates`, so a valid scan that legitimately returned zero
   candidates (empty universe / no provider quotes) was treated as "no scan" instead of
   rendering the explicit zero-candidates state. Fixed: an empty array is accepted when
   the scan otherwise has the full shape (string `generatedAt`, array `topCandidates`,
   normalized `warnings`); the first-candidate shape check applies only when candidates
   exist — the compact prompt shape (`compactMarketScanForPrompt`, `{sym, px, ...}` keys)
   is still rejected, so the original crash finding stays fixed. The candidates meta line
   also became defensive about missing `returnedQuotes`/`scannedSymbols` counters.
8. **(P2) Drilldown resolves from the run-captured scan only** — confirmed (it was already
   flagged in this note's follow-ups). Initially answered as a cross-lane follow-up; then
   the parallel drilldown PR landed on main WITH the optional `quote` override prop on
   `SymbolButton`/`SymbolDrilldownSheet`, so after merging main this branch ADOPTED it:
   the scan table's symbol column now passes the row's own `MarketQuote` into
   `SymbolButton`, making the drilldown render the same scan the table shows. Fully
   closed — removed from follow-ups.

## Follow-ups

- A fuller Smart Money view (pagination or a dedicated endpoint beyond the snapshot's
  12/8 caps) — the caps are now labeled honestly but the full cached feed is still only
  server-side. Also: the server's congress cap slices by TRADE date
  (`src/lib/dashboard.ts`); switching the cap to disclosure date belongs to the src/lib
  lane.
- ~~Drilldown stale-vs-live quotes~~ — DONE: the drilldown PR landed the `quote` override
  prop on `SymbolButton` and the scan table now passes each row's quote through (see
  finding 8 above).
- Column show/hide + persisted order (legacy `SCAN_COLS_KEY` chooser) was intentionally
  dropped for a curated 12-column set; add back if the owner misses it.
- Legacy derived columns (PEG, vs VWAP, spread bps, Graham MoS, …) from
  `src/lib/derived-metrics.ts` are not in the console table yet — candidates for a
  "more columns" follow-up.
- `/api/scan` is rate-limited (30/min/user); the hook surfaces the server's 429 message.
