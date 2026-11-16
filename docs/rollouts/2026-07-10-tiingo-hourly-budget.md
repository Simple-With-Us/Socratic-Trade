# 2026-07-10 — Tiingo free-tier hourly request budget (MONET)

> **SUPERSEDED (2026-07-10) by `docs/rollouts/2026-07-10-unified-provider-quota.md` (PR #1310).**
> The owner directed that throttling be a single scan-size-agnostic mechanism across ALL providers
> rather than a per-provider bespoke fix ("it needs to be based on not knowing how many tickers will
> be in the scan so it is flexible and all other data provider settings also need to be that way").
> The Tiingo hourly cap is now enforced by the unified `RequestQuota` (tiingo = 50/hour + 1000/day)
> in `src/lib/provider-rate-limit.ts`. The ad-hoc, Tiingo-only design described below was NOT
> implemented as its own code path; this note is kept for the root-cause analysis only.

Owner shared their Tiingo API-usage dashboard: **Hourly Requests at −10 / 50**
(over the cap), Daily 615/1000 (fine), Bandwidth ~0/2 GB (fine). So Tiingo's
403s are the **hourly rate limit (50 requests/hour)** being exceeded — the same
class of problem as Alpha Vantage and Twelve Data, and the app wasn't pacing it.

## Root cause

`TiingoEnrichmentProvider.enrich` fires **3 requests per symbol** (iex quote +
daily meta + news), unpaced, `CONCURRENCY`-wide. A ~30-symbol scan = ~90
requests in seconds, and across hourly multi-account scans it blows straight
past the 50/hour free cap → 403 on the whole call.

## Fix (mirrors the Twelve Data free-tier fix)

`src/lib/data-providers.ts`:
- **Per-credential rolling hourly request budget** (`TIINGO_REQUESTS_PER_HOUR`,
  default 50): a scan queries only as many best-first misses as the remaining
  budget allows (each symbol costs `perSymbol` requests) and defers the rest
  best-effort — never firing past the cap. The budget map is keyed by a cheap
  in-memory fingerprint of the API key (shared `apiKeyFingerprint`, also used by
  the Twelve Data gate), so concurrent-account scans on the same key share one
  budget and a per-user key with its own quota isn't gated by the operator key.
- **`TIINGO_DROP_NEWS`** (default off): drops the redundant 3rd call/symbol
  (Finnhub/Yahoo also carry news), taking each symbol from 3→2 requests and
  stretching coverage from ~16 to ~25 symbols/hour.
- **Negative-cache** (~30 min) for symbols Tiingo returns no usable data for, so
  they rotate out of the front of `misses` instead of burning the tiny hourly
  budget on every scan while other symbols starve. Transient errors are left
  uncached (retry next scan).

Net effect: Tiingo requests stay ≤ 50/hour (default), so it stops 403-ing and
actually returns data for the top ~16 candidates/hour, with the shared 6h
enrichment cache accreting coverage across scans. Like AV/TD, Tiingo is a
supplementary source — the core scan fields come from the paid providers.

## Verification

`npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — recorded
in the PR. New tests (`test/data-providers.test.ts`): hourly budget caps a
30-symbol scan to ≤16 symbols / ≤50 requests with every symbol represented;
the budget is shared per-credential across scans (2nd scan gets only the
remainder); `TIINGO_DROP_NEWS` drops the news call (3→2 req/symbol).

## Follow-ups / owner tunables

- `TIINGO_REQUESTS_PER_HOUR` — raise if a paid Tiingo plan lifts the hourly cap.
- `TIINGO_DROP_NEWS=1` — set to cover ~25 symbols/hour instead of ~16 (trading
  Tiingo sentiment for more price/meta coverage).
- congress.trade 403 (both API + SSE) is a SEPARATE, still-open owner action:
  whitelist the new box IP <HETZNER_OLD_IP_RETIRED> on the congress.trade Cloudflare zone
  (agents are permission-blocked there). See the Hetzner migration rollout note.
