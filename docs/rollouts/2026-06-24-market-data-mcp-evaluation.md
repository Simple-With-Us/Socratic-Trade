# Market Data MCP Evaluation

Date: 2026-06-24

## Summary

Added a market-data provider evaluation covering MCP suitability, cost, and
integration priority for FMP, Alpha Vantage, Twelve Data, Tiingo, Intrinio,
EODHD, FinancialData.net, Nasdaq Data Link, Tastytrade, Pyth, Databento,
Unusual Whales, Trading Volatility, and a generic Yahoo-backed MCP server.

## Why

The app already has a direct, typed, cached, and source-attributed market-data
path. MCP is useful for provider discovery, interactive research, and
LLM-assisted deep dives, but the autonomous scan/scoring path should keep using
direct REST/WebSocket adapters with explicit cache scope, provenance, and
rate-limit behavior.

The main recommendation is to benchmark the Intrinio trial before paying
$150/month, add Tiingo as a low-cost direct adapter if the key is active, and
consider FinancialData.net or EODHD as cheaper broad alternatives if Intrinio is
too expensive or licensing does not fit.

During landing, `origin/main` advanced with PR #113. The overlapping roadmap,
status, and Phase 4 docs were manually merged so the current scan/universe
updates from `origin/main` and this MCP/provider evaluation are both preserved.

## Files

- `STATUS.md`
- `PLAN.md`
- `docs/data-provider-mcp-evaluation.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/rollouts/2026-06-24-market-data-mcp-evaluation.md`

## Verification

- `perl -ne 'print "$ARGV:$.: trailing whitespace\n" if /[ \t]$/; print "$ARGV:$.: tab indentation\n" if /^\t/' docs/data-provider-mcp-evaluation.md docs/rollouts/2026-06-24-market-data-mcp-evaluation.md`
- `npx tsc --noEmit`
- `npm test -- --run` - 99 files / 908 tests passed
- `npm run build`
- Post-`origin/main` merge: `npx tsc --noEmit`
- Post-`origin/main` merge: `npm test -- --run` - 107 files / 936 tests passed
- Post-`origin/main` merge: `npm run build`

Notable setup failure:

- The first `npx tsc --noEmit` attempt failed because this temporary worktree had
  no installed dependencies and `npx` resolved the placeholder `tsc` package.
  `npm ci` installed dependencies cleanly; rerunning `npx tsc --noEmit` then
  passed.

## Follow-ups

- If proceeding, add `tiingo` and `intrinio` to the API-key catalog and
  provider alias maps.
- Build direct Tiingo and Intrinio probes before adding either source to the
  scan cascade.
- Use the Intrinio trial to compare quotes, historical OHLC, fundamentals,
  analyst/estimate data, ETF data, options data, rate limits, entitlement errors,
  and licensing against the current provider stack.
- Keep MCP use optional and advisory unless app-side MCP calls are normalized
  through the same source-attributed cache path as direct providers.
