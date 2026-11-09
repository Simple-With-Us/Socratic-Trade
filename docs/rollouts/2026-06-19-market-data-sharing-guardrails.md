# 2026-06-19 - Market-data sharing guardrails

## Summary

- Made OHLC history cache sharing explicit for multi-user/keyed-provider paths.
- Free and env-key/system-key history remains shared globally.
- Saved user-key history is private by default and only joins the shared cache when
  `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`.
- Fixed broker quote source attribution so scan sources derive from actual quote
  providers (`alpaca-quotes`, `robinhood-quotes`, etc.) rather than always appending
  `robinhood-quotes`.
- Made source attribution idempotent so repeated broker quote merges do not duplicate
  the same `+<provider>-quotes` segment.
- Added focused regression coverage for history sharing boundaries and broker quote
  source attribution.

## Why

Market data facts should be shared when they are public or system-entitled because that
improves data quality and avoids duplicate calls. User/account data must remain private.
The prior OHLC cache was symbol-only even when a request used a per-user key, which made
cross-user sharing implicit instead of policy-controlled. The scan source string also
misattributed Alpaca quote merges as Robinhood quote data.

## Files

- `.env.example`
- `README.md`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-11-multi-user.md`
- `docs/rollouts/2026-06-19-market-data-sharing-guardrails.md`
- `src/lib/history.ts`
- `src/lib/market.ts`
- `src/lib/dashboard-ui.ts`
- `test/history.test.ts`
- `test/market.test.ts`

## Verification

- `npm test -- test/history.test.ts test/market.test.ts` - passed, 22 tests across 2 files.
- `git diff --check` - passed.
- `pm2 stop trading-codex` - stopped the Codex dev preview before build checks.
- `npx tsc --noEmit` - passed.
- `npm test` - passed, 231 tests across 30 files.
- `npm run build` - initially failed during trace collection with `ENOENT
  .next/server/instrumentation.js.nft.json`.
- `rm -rf .next && npm run build` - passed from a clean generated artifact tree.
- `pm2 restart trading-codex` - restarted the Codex dev preview.
- `curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:4101/`
  - initially hit cold-start/hung dev compilation, then passed with `200` after
  the preview warmed.
- `curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://127.0.0.1:4101/api/health`
  - initially hit cold-start/hung dev compilation, then passed with `200` after
  the preview warmed.

## Follow-ups

- Add a persistent `market_observations` table with explicit entitlement scopes before
  relying on shared market facts across real hosted users.
- Add consent/UI controls before enabling user-keyed data sharing in multi-user mode.
- Continue the policy/data isolation audit for account snapshots, proposals, scorecards,
  and future learning materialization tables.
