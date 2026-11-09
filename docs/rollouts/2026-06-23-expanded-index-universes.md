# Expanded Index Universes

Date: 2026-06-23  
Branch/worktree: `codex/ui-account-deletion-visual-pass` in `/Users/jay/apps/trading-codex`  
Preview: `codex.jays.services` / pm2 `trading-codex` / port `4101`

## Summary

Added S&P 100, Nasdaq Composite, Russell 2000, NYSE Composite, and FT Wilshire
5000 base universe options. S&P 100 and S&P 500 are mutually exclusive, and
Nasdaq 100 and Nasdaq Composite are mutually exclusive, in both Settings UI and
policy API normalization.

Market Scan now accepts dynamic broad universes in addition to the embedded
static lists. S&P 100 and Russell 2000 load from BlackRock iShares holdings
downloads (`OEF` and `IWM`) and are intersected with the Nasdaq screener. Nasdaq
Composite and NYSE Composite use Nasdaq screener exchange filters. FT Wilshire
5000 uses the free all-screener U.S.-listed universe as a no-license proxy.

## Why

The app previously limited base universe choices to embedded S&P 500, Nasdaq
100, and Dow 30 snapshots. That was too narrow for small-cap and broad-market
discovery, but blindly sending thousands of symbols to enrichment providers or
the LLM would increase latency, cost, provider pressure, and prompt noise.

The implemented shape broadens the pre-rank universe while preserving a bounded
candidate set: scan/rank locally first, then enrich and prompt only the
configured candidate cap (default 30), plus the small event/outlier candidate
reserve.

## Decisions

- Kept exact static lists for the existing embedded universes.
- Used live BlackRock holdings for S&P 100 and Russell 2000 so those lists are
  not hardcoded into the repo.
- Treated FT Wilshire 5000 as an app-level free screener proxy, not a licensed
  exact constituent list.
- Dynamic-universe opening trades must be scan-proven: the symbol has to appear
  in the latest ranked scan data unless it is explicitly allowed through
  Additional Watchlist/static lists.
- Manual chat-draft promotion still blocks non-explicit broad-index-only
  symbols before a scan and now explains that broad indexes are scan-ranked
  first.

## Files

- `src/lib/types.ts`
- `src/lib/index-universes.ts`
- `src/lib/fund-holdings.ts`
- `src/lib/market.ts`
- `src/lib/policy.ts`
- `src/lib/strategy.ts`
- `src/lib/strategy-tuning.ts`
- `app/dashboard-client.tsx`
- `app/api/policy/route.ts`
- `app/api/scan/route.ts`
- `app/api/proposals/from-draft/route.ts`
- `test/index-universes.test.ts`
- `test/fund-holdings.test.ts`
- `test/market-dynamic-universe.test.ts`
- `test/policy.test.ts`
- `PLAN.md`
- `STATUS.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-23-expanded-index-universes.md`

## Verification

- `npx vitest run test/index-universes.test.ts test/fund-holdings.test.ts test/market-dynamic-universe.test.ts test/market-custom-symbol.test.ts test/policy.test.ts` — passed, 55 tests.
- `npx tsc --noEmit` — passed.
- `npm test` — passed, 105 files / 927 tests.
- `npm run build` — passed.
- Live source smoke:
  - `fetchBlackRockHoldingSymbols("sp100")` returned 101 holdings.
  - `fetchBlackRockHoldingSymbols("russell2000")` returned 1901 holdings.
  - `scanMarket(..., ["nyseComposite"])` returned 2714 NYSE quotes.
- `pm2 restart trading-codex` — passed.
- Local `http://127.0.0.1:4101/api/health` returned `200 OK`.
- Public `https://codex.jays.services` returned the expected Cloudflare Access `302`.

## Follow-ups

- If exact licensed FT Wilshire 5000 constituents become available, replace the
  current all-screener proxy and keep the source label honest.
- Consider trimming `/api/scan` response size for very broad universes if UI
  payload size becomes noticeable; the LLM/enrichment cap is already bounded.
