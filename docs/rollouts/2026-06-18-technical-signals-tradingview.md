# 2026-06-18 — Technical signals: TradingView webhook + in-house computed (Phase 10 A2)

## Summary
Added a **technical-signal web source** — the one signal category the stack lacked: bar-
based RSI/MACD/MA-crossover reads (every other signal is a snapshot or cross-sectional
aggregate; there was no OHLC price-history pipeline). It has two interchangeable producers
filling one persisted per-symbol dataset:

- **TradingView (push, trial-window pilot):** a Pine `alert()` POSTs JSON to a new
  receiver route `POST /api/webhooks/tradingview`; the route verifies a shared secret
  (constant-time, fail-closed), optional IP allowlist, dedups, and upserts a record.
- **In-house (pull, free, durable):** `refreshTechnical()` (computed mode) pulls daily
  OHLC from the free Yahoo chart endpoint (Stooq CSV fallback, no key) for the bounded
  scan watchlist and runs `computeTechnicals()`.

Select with `TECHNICAL_SOURCE=tradingview|computed` (default `tradingview`). Downstream is
identical for both: the signal overlays onto the market scan, **lifts the existing
`momentum` factor** (50/50 blend when present), pulls strong bullish names into the event
candidate union (`hasNotableWebSignal`), emits a prompt bulletin, and is captured in the
per-run `CandidateEvidence` digest so signal-efficacy/confidence-calibration measure it.

This advances Phase 10 **A2** — technical signals now join the event union
(`hasNotableWebSignal`); 8-K/earnings/options/analyst-revision sources still pending.

## Why
Evaluation requested: does TradingView/Pine via webhooks add significant advantage? Finding:
yes, but **narrow and additive** — it fills the technical-analysis gap (real-time triggers
+ indicators the snapshot screener can't compute), and is *not* a replacement for the
fundamental/alt-data/LLM engine. User opted to build **both** (tunnel OK, prefers free), so
the inbound ingestion + overlay + scoring + learning were built **producer-agnostic**: run
TradingView during the trial; flip to free `computed` when it ends with zero downstream
rework. See `docs/tradingview-pine-setup.md` for the operator guide + Pine script.

### Deviation from the approved plan (with reason)
The plan's primary option added a dedicated `technical` factor to `ScoringWeights`. On
re-reading the tree, scoring is a **hot, concurrently-edited file** (the `positioning`
factor was just added; new `derived-metrics.ts` / `market-internals.ts` / `macro-metrics.ts`
modules landed since the plan). A 9th weight ripples through `normalizeWeights`, the tuning
LLM schema, the UI editor, every `ScoringWeights` literal, and re-normalizes (shifts) all
existing scores. To avoid colliding with that work, took the plan's **pre-authorized lighter
path**: feed technicals through the existing `momentum` factor (no schema change) + event
union + bulletins + evidence. Same ranking impact, near-zero collision surface. The
dedicated factor remains an easy follow-up once the tree settles.

## Files
New:
- `src/lib/indicators.ts` — pure SMA/EMA/RSI(Wilder)/MACD + `computeTechnicals()` → 0–100
  `technicalScore` + direction + named signals. Trend-dominant; RSI level nudges gated on
  trend (overbought-in-uptrend is continuation, not a fade).
- `src/lib/web-sources/technical.ts` — dataset + both producers (push ingest, computed
  pull), `getTechnicalSignals` (TTL-filtered), `verifyWebhookSecret`, `setTechnicalWatchlist`,
  Yahoo/Stooq OHLC fetch.
- `app/api/webhooks/tradingview/route.ts` — receiver (secret/IP gate, JSON parse, dedup).
- `docs/tradingview-pine-setup.md` — operator guide + Pine script + tunnel/alert steps.
- `test/indicators.test.ts` (8), `test/web-sources-technical.test.ts` (10).

Edited:
- `src/lib/types.ts` — `TechnicalDirection` alias; `MarketQuote` + `CandidateEvidence`
  technical fields.
- `src/lib/web-sources/types.ts` — `SymbolWebSignal.technical`.
- `src/lib/web-sources/index.ts` — register refresh, fold into `getSymbolWebSignals` +
  `getWebSourcesStatus`, re-exports.
- `src/lib/market.ts` — `hasNotableWebSignal` (+technical), overlay sets technical fields +
  provenance, `momentumScore` blends `technicalScore`, watchlist write for computed mode.
- `src/lib/evidence.ts` — carry technical fields into the digest.

## Verification
- `npx tsc --noEmit` → clean.
- `npx vitest run` → **178 passed (24 files)**, including 18 new.
- `npm run build` → compiled successfully; `/api/webhooks/tradingview` present.
- Webhook smoke test (curl, dev server): malformed body → **400**; valid JSON with no
  secret configured → **401** (fail-closed). 200 success/dedup path covered by unit tests.
- **Bug caught by the smoke test** that tsc/vitest/build all missed: `import { timingSafeEqual }
  from "node:crypto"` 500'd under dev webpack (`UnhandledSchemeError` on the `node:` scheme).
  Fixed to `import crypto from "crypto"` (repo convention in `db.ts`/`alpaca.ts`).

## Follow-ups / risks
- **Dedicated `technical` ScoringWeights factor** — deferred (see deviation). Do once the
  scoring subsystem settles, for cleaner per-factor learning attribution.
- **Real-time run trigger** (high-conviction webhook → immediate scoped `runStrategyOnce`)
  — deferred; needs careful policy gating. Today pushed signals are picked up next tick.
- **Yahoo chart endpoint** is unofficial → Stooq fallback + never-fabricate guard already in.
- Computed universe is bounded (scan watchlist, capped `WEB_SOURCE_TECHNICAL_MAX`, default 40)
  — free OHLC endpoints can't cover thousands of names.
- Paper-mode only; no live-trading behavior changed.
