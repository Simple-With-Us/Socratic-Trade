# 2026-06-24 — congress-share push timeout fix (prod)

Branch: `agent/claude-congress-share-timeout`.

## Incident
After enabling the outbound share in prod (`trading`, port 4000), every push to App A's
`POST /api/admin/securities/import` failed with `"This operation was aborted"` — the 15s
`AbortController` firing because the import POST didn't return in time. Repeated ~every 15s (sequential
chunk POSTs each hitting the wall).

## Diagnosis
- App A is healthy + instant for small bodies: empty `POST .../import` → **401 in 0.06s**. Network/DNS fine.
- So the aborts were **payload-size driven**: the nightly batch bundled the full multi-year price history
  for the universe + all insider/short-volume rows into a few huge POSTs, and App A's per-call work
  (upserts + per-trade performance recompute) exceeded 15s per chunk.

## Fix (`src/lib/congress-share.ts`)
- **Per-symbol close cap:** `CONGRESS_SHARE_MAX_CLOSES_PER_TICKER` (default 260 ≈ 1y) — App A backfills
  deeper history itself; shipping 5y/symbol nightly was the main bloat.
- **Smaller, split POSTs:** send `spx`, `insider` (≤500/POST), `shortVolume` (≤500/POST), and `prices`
  (5,000-close budget, ≤100 tickers/POST) as **independent** bounded requests instead of one bundled
  megabatch — so one oversized dataset can't abort the rest, and each POST bounds App A's per-call work.
- **Timeout 15s → 30s** (`CONGRESS_SHARE_TIMEOUT_MS`).
- Decoupled the universe cap (`maxDailyTickers`, ≤2000) from the per-POST ticker cap (was incorrectly
  reusing the same constant — lowering the per-POST cap would have collapsed the universe to 100).
- Error log now includes per-dataset `sent` counts to pinpoint an oversized dataset.

## Immediate mitigation (no deploy) for the operator
Until this lands, set in `~/apps/trading-live/.env.local` + `pm2 restart trading`:
`CONGRESS_SHARE_MAX_TICKERS=50` and `CONGRESS_SHARE_TIMEOUT_MS=45000` (shrinks payloads/raises the wall),
or `CONGRESS_SHARE_ENABLED=off` to stop the failing pushes. Failures are self-guarded (never broke the
app), so this was degraded-not-down.

## Verification
- `npx tsc --noEmit` clean; `test/congress-share.test.ts` 34 pass (incl. new close-cap + split-POST tests);
  full `npm test` + `npm run build` via `scripts/land.sh`.
- App A latency probe (empty POST) confirmed 401 in 0.06s.

## Files
`src/lib/congress-share.ts`, `.env.example`, `docs/congress-trade-share.md`, `test/congress-share.test.ts`,
this note.

## Follow-ups
- After deploy, watch `pm2 logs trading | grep congress-share` for the new `sent=…` diagnostics; if any
  POST still aborts, lower `CONGRESS_SHARE_MAX_CLOSES_PER_TICKER` further.
- Optional optimization: after initial backfill, send only the latest close per symbol (App A accumulates).
