# 2026-06-17 — Backend-derived financial metrics for the LLM

## Summary
Added a backend layer that computes standard, decision-relevant financial ratios
which **no provider returns directly** but which are fully derivable from fields we
already fetch, and feeds them to the agent in the per-candidate scan payload. The
LLM no longer has to do error-prone arithmetic on large numbers or unit-mismatched
fields, and we add no new API dependency.

New metrics (all `undefined` → omitted when inputs are missing/not meaningful):
| Key | Formula (unit-correct) | Reads on |
|-----|------------------------|----------|
| `peg`        | `peRatio / (epsGrowth×100)` | valuation vs growth (GARP) |
| `earnYld`    | `eps / price × 100`         | earnings yield; usable when `pe` is n/a (eps ≤ 0) |
| `roe`        | `eps × pbRatio / price × 100` (BVPS = price ÷ P/B) | quality / capital efficiency |
| `payout`     | `dividendYield × price / eps` | dividend sustainability (>100% = at risk) |
| `dollarVolM` | `price × volume / 1e6`      | liquidity for sizing/slippage |
| `spreadBps`  | `(ask − bid) / mid × 1e4`   | execution cost |

## Why
The agent had raw inputs (price, eps, pe, pb, dividendYield, epsGrowth, volume,
bid/ask) but not these derived ratios. LLMs are unreliable at multiplying
large/edge-case numbers and at tracking each field's unit convention, so computing
deterministically in the backend is both cheaper (no extra API) and more accurate.
The 52-week range position (`range52w`) was already derived in `market.ts`, so it
was intentionally NOT duplicated.

## Unit contract (verified, see `derived-metrics.ts` header)
- `dividendYield`, `fcfYield` → already a PERCENT number (2.05 == 2.05%).
- `epsGrowth` → a FRACTION (0.56 == 56% YoY; the UI multiplies by 100).
- `eps`, `price` → dollars; `peRatio`, `pbRatio` → plain ratios.
Confirmed against `src/lib/data-providers.ts` (fcfYield computed as
`(rawFcf/rawMarketCap)*10000/100`) and the dashboard column formatters.

## Files
- `src/lib/derived-metrics.ts` — NEW. `DerivedMetrics` interface + pure, total
  `deriveMetrics(quote)`; guards + rounding; sign-preserving for earnYld/roe.
- `src/lib/strategy.ts` — import `deriveMetrics`; spread `...deriveMetrics(quote)`
  into each `compactMarketScanForPrompt` candidate (single chokepoint feeding both
  the bull-research and approval-review LLM calls); extended the per-candidate
  evidence description in the system context so the model knows what each key means.
- `test/derived-metrics.test.ts` — NEW. 9 unit tests (formulas, unit handling,
  sign preservation, guards, realistic full quote).

## Follow-up 1 — UI surfacing (done)
- `app/dashboard-client.tsx` — added six derived Market Scan columns. **PEG** and
  **ROE** are visible by default; **Earn Yld / Payout / $ Vol / Spread** are
  `defaultHidden` (toggle on via the column gear). To make computed columns
  sortable, `ScanColumn.sortKey` is now optional with a new
  `sortValue?: (q) => …`, and the table sorts by column `id` (helper
  `scanSortValue`) instead of `keyof MarketQuote`. Values are computed per row via
  the shared `deriveMetrics`, so the table, drilldown and LLM never drift.
- `app/ui/symbol-drilldown.tsx` — added a "Derived Metrics" card (6 tiles, tone
  colored, `—` when n/a) and folded PEG/ROE/payout signals into the AI Conviction
  Summary pros/cons.

## Follow-up 2 — evidence persistence (done)
- `src/lib/types.ts` — `CandidateEvidence.derived?: DerivedMetrics` (type-only
  import of `DerivedMetrics`; erased, so no runtime cycle).
- `src/lib/evidence.ts` — `buildCandidateEvidence` now computes `deriveMetrics(q)`
  and attaches it (omitted when empty) to the persisted per-run `signal_snapshot`
  digest for both chosen and skipped candidates, so the learning loop can later
  correlate e.g. low-PEG / high-ROE entries with realized outcomes.
- `test/evidence.test.ts` — +2 tests (derived block captured with inputs; omitted
  when no quote).

## Verification
- `npx tsc --noEmit` → clean (no source errors).
- `npm test` → 20 files, **150 tests** pass (was 139; +9 derived, +2 evidence).
- `npm run build` → compiles, type-checks, 11/11 pages.
- Live end-to-end: `GET /api/scan` candidate **C** (Citigroup) →
  `peg 0.27, earnYld 6.09, roe 7.8, payout 27.6, dollarVolM 1584` — matches the
  formulas. These are the exact values serialized into the LLM message.
- Browser pass (Claude Code preview, 1600×900): Market Scan shows PEG + ROE
  columns (C: PEG 0.27 / ROE 7.8%; INTC ROE −2.8% in red); column gear exposes
  Earn Yld / Payout / $ Vol / Spread; Symbol Drilldown shows the Derived Metrics
  card (INTC: earnYld −0.52%, ROE −2.8%, $13.45B vol, 20.0 bps spread) and the
  conviction summary picks up "Negative return on equity".

## Follow-ups (still open; candidates if wanted)
- Possible additional derivable metrics deferred to keep the payload tight:
  `% from 52w high` (overlaps `range52w`), upside/downside R:R to the 52w band,
  Graham number / margin-of-safety (eps, pb, price).
- Wire the persisted `derived` evidence into an explicit learning signal (e.g. a
  PEG/ROE bucket in the signal-efficacy report) — currently it is captured but not
  yet read back by the tuner.
