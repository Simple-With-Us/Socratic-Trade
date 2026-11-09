# 2026-06-19 - Webull unofficial market-data bridge

## Summary

Added an opt-in, read-only bridge to the community `tedchou12/webull` Python package
for experimental Webull quote enrichment. The bridge is disabled by default and is
not wired to broker execution, paper trading, or learning fills.
The subprocess call is runtime-only so Next dev/instrumentation bundles do not
statically import `child_process`.
The generated Webull `did.bin` device-id cache is ignored.
Follow-up local setup installed `webull==0.6.1` into the ignored
`.tools/webull-venv` virtualenv and enabled the bridge in private `.env.local`
with `WEBULL_UNOFFICIAL_PYTHON=.tools/webull-venv/bin/python`.

## Why

The user asked whether the unofficial Python method could provide market info. The
decision was to support it only as low-trust quote enrichment, with explicit source
attribution (`webull-unofficial`) and no credential/login path.

## Files

- `src/lib/data-providers.ts`
- `src/lib/market.ts`
- `src/lib/types.ts`
- `scripts/webull_unofficial_quote.py`
- `.env.example`
- `.gitignore`
- `test/data-providers.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/rollouts/2026-06-19-webull-unofficial-market-data.md`

## Verification

- `npx tsc --noEmit` - passed.
- `.tools/webull-venv/bin/python scripts/webull_unofficial_quote.py AAPL` - passed,
  returned an unofficial AAPL quote payload.
- `WEBULL_UNOFFICIAL_ENABLED=on WEBULL_UNOFFICIAL_PYTHON=.tools/webull-venv/bin/python npx tsx -e "..."` -
  passed, verified the TypeScript enrichment provider returned `webull-unofficial+yahoo-finance`
  and stamped Webull quote fields with `webull-unofficial`.
- `npm test` - passed, 210 tests across 28 files.
- `npm run build` - first attempt hit a stale `.next` prerender error
  (`<Html> should not be imported outside of pages/_document`); `rm -rf .next`
  and rerun passed.
- Restarted `npm run dev` and verified `http://localhost:3000` returns `200 OK`.

## Follow-ups

- Keep `WEBULL_UNOFFICIAL_ENABLED=off` by default in committed examples. The local
  private `.env.local` may turn it on after installing `webull` in an ignored
  virtualenv and accepting the unofficial endpoint risk.
- Do not use this bridge for execution or learning-grade fills. Broker-confirmed
  fills should come from Alpaca paper/live or a future official Webull/Schwab adapter.
