# 2026-06-21 — P1 edge quality: congress windowing, scorecard floor, deterministic Bear veto

## Summary

Three remaining P1 items from the financial expert panel review (see
`docs/reviews/2026-06-21-financial-expert-panel.md`, items 4–6):

1. **P1-4**: Congress/insider windowing on `disclosedAt` (not trade date)
2. **P1-5**: LLM scorecard noise floor raised from ≥2 to ≥5 closed lots
3. **P1-6**: Deterministic Bear veto — the only genuinely model-independent critique stage

## What changed

### P1-4 — Congress disclosedAt windowing (`src/lib/web-sources/congress.ts`, `types.ts`)

**Why it was wrong:** `aggregateCongressSignals` used `tradedAt || disclosedAt` for
the recency cutoff. Congressional trades are disclosed up to 45 days after they
occur; the market can't react until the disclosure lands. Windowing on `tradedAt`
included stale disclosures of recent trades and excluded fresh disclosures of old ones.

**What changed:**
- Recency cutoff now uses `disclosedAt || tradedAt`.
- Sort order now uses `disclosedAt || tradedAt` so `lastDisclosedAt` reflects the
  most recently filed disclosure, not the most recently traded date.
- Added `lastDisclosedAt?: string` field to `CongressSignal`.

**Test coverage:** 2 new tests — one verifying a 90-day-old trade with a 5-day
disclosure is INCLUDED, one verifying a 5-day-old trade with a 90-day disclosure is
EXCLUDED.

### P1-5 — LLM scorecard noise floor (`src/lib/strategy.ts` lines 931–951)

**Why it was wrong:** The three scorecard filters (thesisRegime, sector, factor) that
are passed to the Bull LLM used `trades >= 2`. With 2–4 trades, the Bayesian
shrinkage prior (K=5) dominates the estimate entirely; the bucket adds noise to the
agent's reasoning without improving signal quality.

**What changed:** Raised all three scorecard filters from `trades >= 2` to
`trades >= 5`.

**Note:** The deterministic sizing gate (`minLotsForSizing = 20`) was already in
place and is unchanged — it correctly prevents thin buckets from inflating position
size regardless of scorecard content.

### P1-6 — Deterministic Bear veto (`src/lib/strategy.ts`)

**Why it was needed:** The Bull and Bear LLM agents use the same model with different
system prompts — "one model arguing with itself" (panel's words). This is not a
genuinely independent check.

**What changed:** Added `deterministicBearFilter(proposals, positions, topCandidates,
regime)` — a synchronous, model-free pre-filter that runs BEFORE the Bear LLM and
applies three concrete rules:

| Rule | Action |
|------|--------|
| **No-position-to-exit**: `sell` with no matching long in the live book | Hard veto |
| **Momentum overextension**: `buy` with `momentum > 92` AND `value < 20` | Flag in rationale (non-blocking; forces Bear LLM attention) |
| **Regime contradiction**: `buy` in Crisis/Risk-Off regime AND score < median | Hard veto |

Vetoed proposals are console-logged before the Bear LLM runs — auditable.

**Why this is the right approach over "different model":** No additional API key
required, zero latency cost, never silently fails, and the rules express concrete
domain knowledge (you can't exit a position you don't hold; a below-average name
in elevated VIX is the weakest risk-on entry).

## Files touched

- `src/lib/web-sources/congress.ts` — disclosedAt windowing
- `src/lib/web-sources/types.ts` — `lastDisclosedAt` field on `CongressSignal`
- `src/lib/strategy.ts` — scorecard floor + `deterministicBearFilter` + wiring
- `test/web-sources.test.ts` — +2 congress windowing tests
- `test/deterministic-bear.test.ts` — +14 deterministic Bear veto tests (new file)

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 573 tests, all pass (+16 new)
- Commit: `61b560e`

## Remaining P1/P2 items (unblocked)

See `docs/reviews/2026-06-21-financial-expert-panel.md` items 2, 3:
- Real macro feed or explicit "Unknown" regime (FRED key required)
- Sample-aware confidence calibration (decouple size from confidence in the
  learning loop to avoid circular bias)
