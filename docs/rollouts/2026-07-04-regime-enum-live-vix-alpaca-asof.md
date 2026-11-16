# 2026-07-04 - regime-enum-live-vix-alpaca-asof

## Summary

Wave-1 quick-win lane `claude/w1-regime-data`, three composite-review items (sections D and E of
`20260704compositeexpertreview.md`):

1. **Typed regime enum + numeric severity** (E/high/S) — a new dependency-free module
   `src/lib/market-regime.ts` exports `MarketRegime` (`"crisis" | "risk-off" | "cautious-inverted" |
   "neutral" | "risk-on" | "unknown"`), `MARKET_REGIME_LABELS` (enum -> the exact persisted label
   strings), `MARKET_REGIME_SEVERITY` (numeric severity in `[0,1]`), `classifyMarketRegime`
   (raw macro inputs -> `{regime, severity}`), `regimeFromLabel` (persisted label string -> enum,
   falling back to `"unknown"` for anything non-canonical), and three named gate predicates:
   `isCrisisOrInvertedMarketRegime`, `isEscalationMarketRegime`, `isRiskOffFilterRegime`.
   `src/lib/macro.ts` re-exports all of it; `determineMarketRegime` is now a thin projection —
   `MARKET_REGIME_LABELS[classifyMarketRegime(macro).regime]` — so it still returns the
   byte-identical label strings that get persisted verbatim as `TradeProposal.entryMarketRegime`
   and read back by every learning bucket/scorecard.
   - **Risk-gate call sites deliberately NOT converted (swimlane keepout):** `src/lib/policy.ts`'s
     `isCrisisOrInvertedRegime` (crisis-cap gate) and `src/lib/strategy.ts`'s
     `deterministicBearFilter` `riskOffRegime` keep their original substring checks. Per the
     owner-assigned Fable/Monet swimlane split (Fable=memory/RAG, Monet=risk; #claude-monet-sync
     sync·2), enum adoption INSIDE risk gates belongs to the risk lane — Monet adopts
     `isCrisisOrInvertedMarketRegime`/`isRiskOffFilterRegime` from `./market-regime` in the
     drawdown-advisory re-scope (PR #360). The predicates are exported and pinned by
     `test/market-regime.test.ts`, so adoption is a one-line swap per site. (An earlier draft of
     this lane converted both sites; the conversion was stripped before landing to honor the
     keepout.)
   - `app/console/macro/indicators.ts`'s `regimeInfo` (the console regime card) now classifies via
     `regimeFromLabel` first, falling back to the old substring check only when the enum resolves to
     `"unknown"` (keeps the card's forward-compat degrade-gracefully behavior for any non-canonical
     label an older payload might carry).
   - `src/lib/regime-watch.ts`'s `isEscalationRegime` deliberately stayed a plain substring check —
     see "Deviations" below.
   - The three gate predicates are intentionally NOT identical to each other for the same regime:
     `"cautious-inverted"` trips the crisis cap and escalation, but NOT the bear filter's risk-off
     veto — this reproduces the exact asymmetry the composite review flagged as the string-coupling
     bug ("Cautious (Inverted Curve)" matched the crisis cap's old substring check but not the bear
     filter's old `startsWith` check). The new test file pins this down explicitly per-label.

2. **Live ^VIX overlay off the 24h macro cache** (D/high/S) — `src/lib/macro.ts` adds:
   - `fetchLiveVix(now?)`: a short-TTL (10 min, `LIVE_VIX_TTL_MS`) cached wrapper around the
     existing private `fetchVixFromYahoo()` (key-free Yahoo `^VIX` chart endpoint), in its own
     module-level cache slot (`liveVixCache`) separate from the 24h `sharedMacroCache`/
     `privateMacroCache`. Returns `{ vix: number | null, asOf: string | null }` — `null` on any
     failure, never a fabricated reading.
   - `fetchMacroDataWithLiveVix(userId?)`: overlays the live VIX (and a live `asOf`) onto the
     (possibly 24h-stale) `fetchMacroData` snapshot. Falls back to the cached macro's own VIX when
     the live fetch fails. Promotes an `asOf: "unavailable"` snapshot to a real timestamp when the
     live VIX succeeds (so the regime classifier's early-return "Unknown" branch doesn't fire just
     because the FRED suite is unavailable while a fresh VIX is in hand). Adds `vixAsOf` to the
     returned object.
   - `src/lib/strategy.ts`'s volatility panic auto-brake now calls `fetchMacroDataWithLiveVix`
     instead of bare `fetchMacroData`, and stamps `vixAsOf` on the `policy_violation_vol_panic` audit
     entry and the kill-switch notification payload.
   - `src/lib/regime-watch.ts`'s `checkRegimeFlip` (the regime-flip detector) now calls
     `fetchMacroDataWithLiveVix` instead of `fetchMacroData`, and includes `vixAsOf` on the
     `regime_flip` audit entry.

3. **Per-data-class cache TTLs + asOf on the Alpaca snapshot** (D/high/S) — `src/lib/data-providers.ts`:
   - New `alpacaSnapshotTtlMs()` (default 30s, env `ALPACA_SNAPSHOT_CACHE_TTL_MS`-overridable),
     replacing the blanket 6h `ttlMs()` (`NEWS_CACHE_TTL_MS`) for the
     `AlpacaSnapshotEnrichmentProvider` cache write. Quote-family data (price/bid/ask/volume/vwap)
     no longer rides the fundamentals cache cadence.
   - `parseAlpacaSnapshot` now stamps `asOf` from whichever timestamp backs the winning PRICE field
     (`latestTrade.t` when `latestTrade.p` won, else `dailyBar.t` when `dailyBar.c` won) — it never
     set `asOf` before, so the `maxQuoteAgeSec` staleness gate (`policy.ts`) could not see that a
     snapshot was replayed from a stale cache entry. A missing/unparsable timestamp is omitted, never
     guessed.
   - `alpaca.ts` (the broker-quote gateway, distinct from the enrichment-cascade snapshot provider)
     was checked and needs no change — it has no cache and already stamps `asOf` from the live quote
     timestamp.

## Why

Composite expert review `20260704compositeexpertreview.md` (sections D "Data providers &
connectivity" and E "Decision-making in complex / atypical / unforeseen conditions") flagged three
related gaps: (1) the regime label had no typed representation, so
`isCrisisOrInvertedRegime`/`deterministicBearFilter`/`isEscalationRegime` each independently
substring-matched the label and could silently desync from each other on a relabel with no type
error; (2) the volatility panic brake and regime-flip detector read a 24h-cached macro snapshot for
VIX, so on a crash day they could be up to a day blind; (3) the Alpaca snapshot enrichment provider
shared the 6h fundamentals TTL and never stamped `asOf`, so a real-time price could silently replay
from cache for up to 6h with the staleness gate unable to detect it.

## Files

- `src/lib/market-regime.ts` (new) — typed enum, label map, severity map, classifier, gate
  predicates. Dependency-free by design (no `./db` import) so client-bundled code can import it by
  value.
- `src/lib/macro.ts` — re-exports `market-regime.ts`; `determineMarketRegime` now a projection over
  `classifyMarketRegime`; adds `fetchLiveVix`, `fetchMacroDataWithLiveVix`, `LIVE_VIX_TTL_MS`,
  `liveVixCache`; `clearMacroCacheForTests` now also clears the live-VIX cache.
- `src/lib/policy.ts` — UNTOUCHED in the landed diff (crisis-cap enum adoption stripped per the
  Fable/Monet swimlane keepout; Monet adopts the predicates in PR #360).
- `src/lib/strategy.ts` — `deterministicBearFilter` substring check kept (same keepout; comment at
  the site); the volatility panic brake now reads `fetchMacroDataWithLiveVix` and stamps `vixAsOf`
  on the audit/notification.
- `src/lib/regime-watch.ts` — `checkRegimeFlip` now reads `fetchMacroDataWithLiveVix` and stamps
  `vixAsOf` on the `regime_flip` audit entry; `isEscalationRegime` kept as a documented plain
  substring check (see Deviations).
- `src/lib/data-providers.ts` — `alpacaSnapshotTtlMs()`; `AlpacaSnapshotEnrichmentProvider.enrich`
  cache write now uses it instead of `ttlMs()`; `AlpacaSnapshot` interface gains `t` timestamp
  fields; `parseAlpacaSnapshot` stamps `asOf`.
- `app/console/macro/indicators.ts` — `regimeInfo` now classifies via `regimeFromLabel` first
  (`@/lib/market-regime`), falling back to the prior substring check only for non-canonical labels.
- `test/market-regime.test.ts` (new) — the required unit test asserting each canonical label's
  `{crisisCap, bearRiskOff, escalation}` gate matrix and severity ordering, plus `regimeFromLabel`
  round-trip and fallback behavior, plus `classifyMarketRegime` coverage.
- `test/macro-live-vix.test.ts` (new) — `fetchLiveVix` (success/failure/cache/TTL-expiry) and
  `fetchMacroDataWithLiveVix` (overlay, fallback-on-failure, promoting an unavailable snapshot).
- `test/data-providers.test.ts` — new `asOf stamping` describe block under `parseAlpacaSnapshot`,
  new `alpacaSnapshotTtlMs` describe block, and a new TTL-expiry behavioral test under
  `AlpacaSnapshotEnrichmentProvider` (fake timers, confirms re-fetch past ~30s vs the old 6h).
- `test/regime-watch.test.ts` — every `vi.doMock("../src/lib/macro", ...)` block now also supplies
  `fetchMacroDataWithLiveVix` (mirroring the same resolved macro value), since `checkRegimeFlip` now
  calls it instead of `fetchMacroData`.
- `STATUS.md`, `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md` — updated per the
  handoff protocol.

## Verification

- `npm run lint` — 0 errors (pre-existing grandfathered warning backlog unchanged; no new warnings
  in any touched or new file).
- `npx tsc --noEmit` — clean.
- `npm test` — 247 files / 2401 tests passed (full suite, no `data/app.db` artifact issue
  encountered — tests use temp SQLite files per the repo convention).
- `npm run build` — succeeded; `/console/macro` compiled (confirms the client-bundle import of
  `src/lib/market-regime.ts` from `app/console/macro/indicators.ts` does not pull in server-only
  modules like `better-sqlite3`).

## Follow-ups

- Deferred from the full D317 item scope (per-data-class TTLs for OTHER enrichment tiers, the
  `{provider, asOf}` sources-map extension across slow field families, drilldown age chips, the
  candidate-prompt data-age line, and the corporate-action backfill rule) — my assigned slice was
  narrower ("Per-data-class cache TTLs + asOf on the Alpaca snapshot"); the rest of D317 remains
  open for whichever lane picks it up next.
- Deferred from the full D315 item scope (release-aware macro TTL shortening around CPI/NFP/FOMC) —
  my assigned slice was the live VIX overlay itself; the release-aware TTL is a separate, smaller
  follow-up.
- Deferred from the full E397 item scope (a broader multi-signal regime classifier folding in credit
  spreads/VIX term structure/breadth into severity) — that is a distinct, larger item (E395,
  "Multi-signal regime classifier") explicitly not in this lane's assignment.

## Deviations

- `src/lib/regime-watch.ts`'s `isEscalationRegime` was intentionally left as a plain substring
  check rather than delegating to `isEscalationMarketRegime(regimeFromLabel(label))`.
  `test/regime-watch.test.ts` uses `vi.doMock("../src/lib/macro", ...)` to fully replace the module
  with test-local mocks that supply ONLY `fetchMacroData`/`fetchMacroDataWithLiveVix`/
  `determineMarketRegime` and test-local label strings (e.g. `"Neutral (Moderate)"`, not the real
  `"Neutral (Normal Volatility)"`). Importing the typed helpers into `regime-watch.ts` would make
  them `undefined` under that mock and break the test the moment they're called. This is documented
  inline in `regime-watch.ts`; the canonical typed path (`isEscalationMarketRegime`/
  `regimeFromLabel`) is available in `./macro`/`./market-regime` for any new consumer that doesn't
  need to tolerate a fully-mocked macro module.
- Touched `test/regime-watch.test.ts` and `test/data-providers.test.ts` (test files, not source) to
  keep existing coverage green under the new `fetchMacroDataWithLiveVix` call site and to add
  coverage for the new Alpaca `asOf`/TTL behavior — no other lane's test files were touched.
- No changes needed in `src/lib/alpaca.ts` beyond confirming it doesn't share the bug (see item 3
  above) — left untouched.
