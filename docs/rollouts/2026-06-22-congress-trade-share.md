# 2026-06-22 — Share market data with congress.trade (App A)

Branch: `agent/claude-congress-share` (isolated worktree off `origin/main` —
the `agent/claude` lane was busy on `agent/claude-docs-pr-policy`).

## Summary

Added an outbound, **default-off** integration that forwards the company
reference + daily-close + S&P-500 data this app ("App B") already fetches to
`congress.trade`'s ("App A") idempotent import endpoint
(`POST /api/admin/securities/import`), so App A can avoid spending the shared
daily FMP quota.

Two triggers (per the chosen "scan refs + nightly prices" split):
- **After each scan** — `scanMarket()` fire-and-forgets `shareScanRefs(scan)`,
  forwarding candidate company `refs`, per-symbol throttled (6h default).
- **Nightly batch** — the scheduler tick calls `runCongressDailyShareIfDue()`
  once/UTC-day: collects the union of all users' watchlist + policy-universe
  symbols, fetches their daily closes + `^GSPC`, and POSTs `prices` + `spx` in
  capped chunks.

Manual ops trigger: `POST /api/admin/congress-share` (admin-gated), bypasses the
daily cadence; optional `{ symbols }` for a targeted test.

## Why

Both apps consume FMP under a shared quota; App A is the system-of-record. App B
already holds the reference/price data App A needs (from non-FMP sources), so
forwarding it conserves App A's FMP quota.

**Key correction to the brief:** App B does *not* call FMP `/v3/profile` or
`/v3/historical-price-full` — its only FMP use is fundamentals enrichment
(`ratios-ttm`/`grades-consensus`/insider/senate), which doesn't map to App A's
schema. The shared `refs`/`prices`/`spx` come from the NASDAQ-screener enrichment
(refs: name/sector/industry/marketCap only — no CIK/exchange/country) and the
`fetchDailyOHLC` cascade (Massive→Tradier→Marketstack→Yahoo→Stooq). So the
trigger is a scan hook + nightly batch, not "after each FMP call." See
`docs/congress-trade-share.md`.

## Safety

- Off unless `CONGRESS_TRADE_TOKEN` set **and** `CONGRESS_SHARE_ENABLED` on
  (admin route needs only the token).
- Token is server-only (`process.env`), never sent to the browser; no
  unauthenticated write path.
- Every POST is timeout-bounded + self-guarded — never throws into a scan or
  scheduler tick. Idempotent endpoint + per-UTC-day marker
  (`congress-share:lastDailyRunDate`). Arrays capped to ≤2000 tickers / ≤20000
  closes per call via `chunkPrices()`.

## Files

- `src/lib/congress-share.ts` — new module (config/gating, mappers,
  `shareWithCongressTrade`, `chunkPrices`, `shareScanRefs`, `runCongressDailyShare`,
  `runCongressDailyShareIfDue`, due/throttle helpers).
- `src/lib/market.ts` — import + fire-and-forget `shareScanRefs(scan)` in
  `scanMarket()`.
- `src/lib/scheduler.ts` — import + `runCongressDailyShareIfDue()` in the tick
  (beside filing-ingest/regime checks).
- `app/api/admin/congress-share/route.ts` — new admin trigger route.
- `.env.example` — `CONGRESS_TRADE_TOKEN`, `CONGRESS_TRADE_BASE_URL`,
  `CONGRESS_SHARE_ENABLED` (+ optional tuning vars).
- `test/congress-share.test.ts` — new, 25 cases.
- `docs/congress-trade-share.md` — new design/integration doc.
- `STATUS.md`, `PLAN.md`, this rollout note.

## Verification (all run in this worktree)

- `npx tsc --noEmit` — clean.
- `npm test` — **95 files / 884 tests pass** (includes the 25 new cases). Note:
  the previously-recorded `cache-provenance` flake did not recur here.
- `npm run build` — green (Next.js production build; `/api/admin/congress-share`
  and `/api/scan` compiled).

## Follow-ups / deferred

- `refs` are intentionally partial (no CIK/exchange/country/ipoDate/sicCode) —
  App B doesn't have them. App A can still backfill those via its own FMP key.
- Nightly batch shares `prices`+`spx` only; `refs` rely on the scan hook firing
  (Market Scan tab load or a strategy run). If no scan runs for a long stretch,
  App A won't get fresh refs from us — acceptable for v1.
- Reverse direction (App B reading App A's public `/api/analytics/ticker/{T}`)
  not implemented.
- Optional: surface a dashboard/admin status indicator for last-share time.
