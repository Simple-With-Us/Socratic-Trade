# 2026-06-16 - web-sources-and-learning

## Summary

Built a backend **web-sources** subsystem that connects high-value signals with no
reliable free key-based API by reading them server-side, plus finished the deferred
Codex learning-loop items. Branch `web-sources` (off `main`, which now carries the
merged `ui-redesign` work). Paper mode unchanged; everything added is read-only data
ingestion — no trading behavior changed.

Six things shipped:

1. **Enrichment-merge bug fix (the real "finish plumbing" gap).** `scanMarket`'s
   enrichment merge silently dropped `fcfYield`, `debtToEquity`, `epsGrowth`, and
   `senateTrades` — so the Phase-6 scoring/prompt/UI plumbing for those was dead
   (columns always `—`, scoring never fired) even when Yahoo supplied real values.
   Extracted the merge into an exported, exhaustive `applyEnrichment(quote, extra)`
   and added the missing fields; also fixed the `quotesBySymbol` summary projection
   to carry them. Regression-tested.

2. **Congressional-trades connector** (`src/lib/web-sources/congress.ts`). Reads
   the **Senate eFD** disclosure site (authoritative, free, no key) via the
   multi-step Django flow (CSRF → accept terms → PTR search → parse each PTR's
   transaction table), with **Capitol Trades** BFF JSON as a configurable
   secondary. Validated live: scraped 78 real trades end-to-end. Produces per-symbol
   net-buy signals (distinct buy members − sell members) + 1-line bulletins.

3. **SEC EDGAR insider connector** (`src/lib/web-sources/sec.ts`). Reads the
   market-wide current-Form-4 feed, parses each ownership XML, and counts **only
   open-market P/S** transactions (ignores option exercises/grants/tax). Fills the
   `insiderSentiment` field that was dead because the user's FMP key is rate-limited
   (429 "Limit Reach"). Validated against live EDGAR (parser confirmed on real
   filings). Rolling 30-day window.

4. **Framework + wiring** (`src/lib/web-sources/{types,http,index}.ts`). Polite
   cached fetch (UA, timeouts, retry, sequential rate limiter), persistent datasets
   in the SQLite KV (survive restart, refresh ≈daily, never overwrite good data with
   nothing on an outage), and a scheduler hook (`refreshDueWebSources()` runs each
   60s tick but is cadence-gated and fully guarded). The scan overlays signals
   cache-only (no network in the hot path); the Market Scan table gained a
   **Congress** column; the agent prompt gets `smartMoneyEvidence` bulletins with
   front-running guidance; the dashboard snapshot carries `getWebSourcesStatus()`.

5. **SignalSnapshot / EvidenceDigest.** `runStrategyOnce` now writes a
   `signal_snapshot` audit per run capturing, per chosen proposal, the deterministic
   evidence that informed it (factor sub-scores, congress net, insider sentiment,
   bulletins, thesis × regime). Raw rows stay out of the prompt — only compact
   bulletins/digests are sent.

6. **Multi-dimensional learning + 20-lot gate.** Added
   `getThesisRegimeScorecard()` (thesis × regime composite, shrunk) fed to the agent
   as `tradeOutcomesByThesisRegime`, and a phase-7 §3.E **min-20-closed-lot gate**
   in the auto-tuner: factor-weight shifts are withheld (local-rules path emits `{}`;
   LLM path instructed to null all weights) until ≥20 lots have closed, so the tuner
   can't overfit a thin sample.

## Why

The user asked to finish the deferred Codex plan and to connect data sources that
need backend scraping (congressional trades especially — copycat flow follows
disclosures, so getting ahead is the edge). Investigation found: (a) the existing
"plumbed" fundamentals were actually being dropped at the scan merge — a genuine
bug; (b) the only existing senate/insider source (FMP) is paywalled/rate-limited on
the user's plan and returns nothing; (c) the headline free sources the user named
(Capitol Trades) and the community Stock Watcher dumps are down/403, so an
authoritative scrape (Senate eFD, SEC EDGAR) was required, built defensively to
never fabricate.

## Files

- New: `src/lib/web-sources/{types,http,congress,sec,index}.ts`,
  `test/web-sources.test.ts`, `test/web-sources-sec.test.ts`,
  `docs/phase-9-web-sources.md`.
- Edited: `src/lib/market.ts` (applyEnrichment + overlay + summary projection),
  `src/lib/types.ts` (`evidenceBulletins`), `src/lib/strategy.ts` (prompt evidence,
  signal_snapshot, thesis×regime), `src/lib/strategy-tuning.ts` (20-lot gate),
  `src/lib/performance.ts` (`getThesisRegimeScorecard`, `getClosedLotCount`,
  `MIN_CLOSED_LOTS_FOR_WEIGHT_SHIFT`), `src/lib/scheduler.ts` (refresh hook),
  `src/lib/dashboard.ts` + `app/dashboard-types.ts` + `app/dashboard-client.tsx`
  (Congress column + webSources status), `test/market.test.ts`,
  `test/performance.test.ts`, `test/strategy-tuning.test.ts`.

## Verification

```bash
npx tsc --noEmit   # clean
npm test           # 113 passed (16 files; +20 new across web-sources, sec, gate, composite, merge)
npm run build      # succeeds
```

Live end-to-end (real network, throwaway tests, deleted after):
- Senate eFD: scraped **78 real congressional trades** through the production module
  and produced correct per-symbol bulletins.
- SEC EDGAR: parser confirmed on live Form 4 filings (codes M/F/J/A/S/G/P observed;
  open-market P/S correctly isolated — e.g. NTRA sells, VRM buys).

An adversarial multi-agent review (5 dimensions: scraper robustness, data integrity,
integration traps, scheduler/concurrency, learning/prompt) was run before commit.

## Follow-ups

- SEC 8-K material-event bulletins; sector as a 4th learning dimension (needs sector
  on closed lots); House congressional coverage when a stable free feed exists;
  optional paid adapters (Quiver / FMP-paid) behind keys. See
  `docs/phase-9-web-sources.md`.
