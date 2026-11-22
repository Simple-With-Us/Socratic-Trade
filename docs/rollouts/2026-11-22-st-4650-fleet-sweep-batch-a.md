# ST-4650 fleet sweep Batch A (2026-11-22, Muse Code MC)

## Context & Objective
Owner-directed fleet-mode sweep: audit ST end to end (trading performance, learning/RAG, website and iOS intuitiveness, everything else), rank findings by value x safety, implement the top verified batches, file the rest.  8-angle read-only audit team plus adversarial critic at c402ecd98; this PR is Batch A (4 commits, one per writer lane).

## Changes Made
- A1 data-cache (be55312d): Finnhub whole-record 6h cache no longer pins live quotes (split cache: fundamentals stripped at 6h, quote fields in a separate ~30s cache, quote-only refetch on fundamentals hits, empty fundamentals negative-cached without suppressing the quote); cascade stale field-cache no longer resurrects quote fields; Yahoo empty results not negative-cached for 6h; cascade keeps fetchedAt/priceDelayLabel; fabricated MOCK_METRICS/getFallbackMetrics deleted (noop provider returns nothing - missing data shows -/n/a, per house rule); quotesBySymbol copies vwap/sizes/OHLC/netChange/delayedFallback; fcfYield mirrors both ways; persisted slow enrichment keeps sharesOutstanding.
  - Files: src/lib/data-providers.ts, src/lib/market.ts, test/data-providers.test.ts, test/market.test.ts
- A2 web-a11y (6d41aa6e): ScanCard star keydown stops propagation (keyboard watch-toggle no longer opens drawer); PAPER/LIVE chip on every ScopeSelector account row (live no longer identified by absence); StateChip aria-label for the <=360px color-only dot; watchlist first-load failure renders error + Retry instead of endless Loading; icon-only buttons named; root error screens stop echoing raw exception text, gain Back to console.
  - Files: app/console/components/chrome.tsx, app/console/scan/scan-table.tsx, app/console/watchlist/page.tsx, app/error.tsx, app/global-error.tsx, test/console-batch-a2-ux.test.ts
- A3 reliability (166c4de3): boot binary download bounded (60s abort + one logged retry); Infisical CLI install version-aware like litestream (persistent BIN_DIR no longer pins a stale CLI); scheduler tick log-and-swallow instead of rethrow into void/setInterval callers (error still recorded); five silent instrumentation catches now warn.
  - Files: scripts/coolify-prod-start.sh, src/lib/scheduler.ts, instrumentation.ts, test/scheduler-tick-reentrancy.test.ts
- A4 learning smalls (bbd72418): outcome daily horizons anchor on the ET market day (marketDateOf) not UTC; rejectProposal counterfactuals opening-side only on the matched draft basis (price+time); pooled deterministic lessons refresh even on per-account signature hit; dead priorDayTradeCount deleted (margin_minimum is the live gate; countDayTradesInLastBusinessDays kept for pdt tests); thesis+regime scorecards share one FIFO replay at clean callers.
  - Files: src/lib/outcome-engine.ts, src/lib/policy.ts, src/lib/post-mortem.ts, src/lib/strategy.ts, src/lib/strategy-execution.ts, test/outcome-engine.test.ts, test/rejected-counterfactual.test.ts, test/post-mortem.test.ts, test/performance-prefetched-pnl.test.ts

## Decisions & Trade-offs
- One PR, four commits (non-overlapping files, bisectable) instead of four PRs: this session cannot create fleet lanes (sandbox has no SSH key; lane/new-worktree guards), so writers ran in host-isolated worktrees and the parent harvested diffs.  Main integration tree untouched.
- Critic-downgraded money-path items deliberately NOT in this PR (evaluateTradeProposal purity, dollar-exit blocking, estimateNotional anchor, SQL notional rewrite): filed as ST-4654 with the audit gap (broker gateway notional unaudited).
- Critic-refuted fix dropped entirely: switching auth rate limits to trustedCloudflareClientIp does not fix spoofing with the origin lock off (recorded in ST-4656).
- A4 item 6 (MAE/MFE fetch swap) skipped by the writer: fetchDailyOHLC is lookback-from-now, not a held-window range fetch.  Filed in ST-4661.
- Existing cached Finnhub rows written before this change may still contain quote fields, but reads strip them defensively and merge only the short-lived quote cache, so they are never replayed stale; no migration needed.
- quotesBySymbol exported (pure helper) solely for direct unit coverage.

## Verification State
- Writers (per batch, targeted): A1 188+67 tests, A2 35 tests, A3 50 tests + bash -n + ASCII byte scan + HTTP retry harness, A4 96+ tests; each npx tsc --noEmit clean.
- Parent on combined tree: npx tsc --noEmit OK; npm run lint 0 errors (893 pre-existing warnings); npx vitest run <17 touched/adjacent files> 407 passed; npm run build exit 0.  Full npm test suite runs in CI verify (serial suite, 90-min job).
- Review-fix verification (Seer/Kody triage on PR #5436): rejectProposal basis suite 38 passed; data-providers+market 189 passed; adjacent enrichment suites 67 passed; tsc OK; eslint on touched files 0 errors.
- No iOS files touched; no local xcodebuild run.  Playwright e2e not run locally (A2 covered by source-level a11y tests following the existing console-a11y pattern); CI e2e/visual baselines may need a look for the new LIVE chip and error copy.

## Next Steps & Blockers
- Land this PR (verify green), then work ST-4651..ST-4661 (filed from the same audit): learning B (4651-4653), money-path careful + broker audit (4654), lease/checksum (4655), auth sunset (4656), iOS (4657), API hardening (4658), web UX incl. owner hotkey decision (4659), docs drift (4660), data/ops (4661).
- ST-4650 stays open as the umbrella until B/C land or are closed as wontfix.

## Zero-Code Findings
- Healthy and verified, no fix needed: FIFO P&L all four OrderSides; duplicate-fill idempotency; no-account refuses (no fake fills); fail-closed middleware + per-user SQL isolation; transactional migrations; enrichment five-site wiring and P/E n/a-vs-dash; SIWA post-ST-4649; zero TODO/FIXME in src/app/ios.
