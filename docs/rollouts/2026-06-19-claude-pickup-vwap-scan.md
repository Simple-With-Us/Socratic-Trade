# 2026-06-19 - Claude pickup and Market Scan VWAP

## Summary

- Inspected Claude's latest `agent/claude` work on `main`:
  - SSE dashboard push, order/proposal emits, VWAP chart overlay, Alpaca news
    WebSocket worker, and the default-off event-trigger engine were already
    committed and merged at `4bdcc26`.
- Fast-forwarded the Codex worktree from `16cdc39` to `4bdcc26`.
- Preserved and reapplied the existing Codex UI audit patch, resolving the
  `STATUS.md` conflict by keeping both Claude's streaming entries and the UI
  audit entry.
- Continued Claude's explicit VWAP follow-up by surfacing `price vs VWAP` in
  Market Scan rows.

## Why

Claude had completed and verified the streaming/event-trigger pass, with one
small UI follow-up still listed: surface `vs VWAP` beyond the price chart. The
scan table is where candidates are compared, so the follow-up belongs there and
should use source-provided Massive grouped daily `vw` data without fabricating
values when the feed is absent.

## Files

- `app/api/scan/route.ts`
- `app/dashboard-client.tsx`
- `app/ui/dashboard/utils.tsx`
- `src/lib/market.ts`
- `src/lib/market-signals/massive.ts`
- `src/lib/types.ts`
- `test/market.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/data-architecture-push-vs-poll.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- `docs/rollouts/2026-06-19-claude-pickup-vwap-scan.md`

Preserved/reapplied pre-existing Codex UI audit files remain part of the local
worktree and are documented separately in
`docs/rollouts/2026-06-19-ui-expert-audit-polish.md`.

## Verification

- `npx tsc --noEmit` - passed.
- `npm test` - passed, 240 tests across 31 files.
- `npm run build` - first attempt compiled, then failed collecting page data
  for `/api/audit` / `/api/auth/robinhood/callback` while the Codex PM2 dev
  preview was still running against `.next`.
- `rm -rf .next && npm run build` - with the preview still running, got past
  page-data collection but failed collecting traces with missing
  `.next/server/instrumentation.js.nft.json`.
- `pm2 stop trading-codex` - stopped the Codex preview to avoid `.next` races.
- `rm -rf .next && npm run build` - then failed once with `Unexpected end of
  JSON input` during page-data collection.
- `npm exec -- tsx -e "import { getDashboardSnapshot } from './src/lib/dashboard.ts'; ..."`
  - direct dashboard snapshot render passed, isolating the JSON parse to Next
  build worker/artifact state rather than app data.
- `rm -rf .next && NEXT_PRIVATE_BUILD_WORKER=0 npm run build` - passed.
- `npm run build` - passed afterward with the standard required command.
- `git diff --check` - passed.
- `pm2 restart trading-codex` - restarted the Codex preview.
- `curl -sS -o /tmp/trading-codex-health.txt -w '%{http_code}\n' --max-time 30 http://127.0.0.1:4101/api/health`
  - returned `200`.
- `curl -sS -o /tmp/trading-codex-scan.json -w '%{http_code}\n' --max-time 45 http://127.0.0.1:4101/api/scan`
  - returned `200`.

## Follow-ups

- Phase 1 trigger-engine work remains open: deterministic fill handling and
  regime re-score without LLM spend.
- Alpaca `trade_updates` and quote WebSocket workers remain scoped but not
  implemented.
- Full live-order confirmation tickets for approve/run in live mode remain open
  from the UI audit.
