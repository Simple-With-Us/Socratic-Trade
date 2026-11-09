# 2026-06-25 — Risk-exit blocked by MAX_SAFE_INTEGER notional sentinel

Branch `agent/claude-exit-notional`.

## Summary
A risk-reducing **SELL** ("Risk-Exit", VZ, 1 share, market, no live quote) was **Blocked** with
`Projected net exposure $-9,007,199,254,740,800.00 exceeds net cap $99,995.36 (100%)` and its value
displayed as `~$9,007,199,254,740,991.00 for 1 shares`. `9007199254740991` is exactly
`Number.MAX_SAFE_INTEGER`. Fixed at the root (side-aware notional estimation), hardened the policy
exposure caps to structurally exempt closes, and guarded the UI so the sentinel can never render.

## Why / root cause
`estimateReviewNotional` (`src/lib/alpaca.ts`) returned `Number.MAX_SAFE_INTEGER` as a
"price-unavailable → treat as over-cap" sentinel **regardless of order side**. That sentinel is only
valid for OPENING orders (block an un-sizable open). For an EXIT it was actively harmful:
- it became the persisted/displayed `estimatedNotional` (→ the ~$9 quadrillion in the UI), and
- it flowed into the net-exposure projection in `src/lib/policy.ts`: `netDelta = -estimatedNotional`,
  so `netProjected = netNow − MAX` overshot through zero to ~−9e15, tripping
  `|netProjected| > netCap && |netProjected| > |netNow|` → the exit was blocked. The block comment
  promised "a risk-reducing close is always allowed", but the guards alone didn't hold against a
  corrupt notional.

## What changed
- **`src/lib/alpaca.ts`** — `estimateReviewNotional` is now side-aware (`input.side`, `input.referencePrice`
  added to the param). Opening orders (buy/short, or unspecified) keep the `MAX_SAFE_INTEGER` over-cap
  sentinel. Exits (sell/cover) with no live/explicit price fall back to the captured entry anchor
  (`referencePrice`), and failing that return `estimatedNotional: 0` with a clear alert — exits are
  notional-exempt, so 0 is safe and never blocks. Caller `reviewEquityOrder` already passes the full
  `EquityOrderInput` (carries side + referencePrice), so no call-site change.
- **`src/lib/policy.ts`** — the whole-portfolio gross/net exposure cap block is now gated on `isOpening`.
  A close (sell/cover) can only move gross/net toward zero, so it is structurally exempt — enforcing the
  documented invariant instead of relying on "further-from-cap" guards that a corrupt notional can defeat.
  `netDelta` simplified to `buy ? +est : -est` (only buy/short reach the block).
  - **Also gated the per-symbol % cap (`maxSymbolExposurePct`) and the sector % cap on `isOpening`** — an
    adversarial review caught that switching un-priced exits from the `MAX_SAFE_INTEGER` sentinel to `0`
    re-broke exits via these caps: `projectedExposurePct` computes `Math.max(0, current − notional)`, so the
    old giant sentinel made it `0` (passed by accident) while `0` makes it `current`. Since
    `maxSymbolExposurePct` is **ON by default (25%)** and an over-cap position is the exact trigger for a
    risk-exit (`strategy.ts`: "SELL/TRIM any position exceeding maxSymbolExposurePct%"), the exit was
    re-blocked by the cap that demanded it. Gating on `isOpening` fixes this **and** a pre-existing latent
    bug where a *normally-priced partial* exit of an over-cap position was already blocked (the sentinel had
    only ever masked the no-quote case). These now match the `isOpening` gate already on
    `maxSymbolExposureNotional`.
- **`app/dashboard-client.tsx`** — `proposalSize()` ignores a sentinel / non-finite `estimatedNotional`
  (≥ `MAX_SAFE_INTEGER`) so the internal "can't size this" flag never renders as a dollar figure, even for
  a blocked opening order.

## Tests
- `test/persistence-hardening.test.ts` — extended `estimateReviewNotional` suite: opening orders still fail
  closed to the sentinel (buy/short/unspecified); exits (sell/cover) return 0 (never the sentinel);
  referencePrice fallback applies to exits only; live quote still wins.
- `test/policy.test.ts` — new regressions: (1) a SELL whose `estimatedNotional` is `Number.MAX_SAFE_INTEGER`
  (the exact screenshot scenario) is NOT blocked by the net/gross cap and is approved; (2) a SELL of an
  already-over-cap position (40% vs 25%) is NOT blocked by the per-symbol % cap — tested with both an
  un-priced exit (`estimatedNotional: 0`) and a normally-priced partial exit; (3) a SELL in an over-cap
  sector is NOT blocked by the sector % cap. Existing opening-side blocks (buy over per-symbol/sector cap)
  stay green.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/policy.test.ts test/persistence-hardening.test.ts` — 56 passed.
- Full `npm test` + `npm run build` via `scripts/land.sh` before PR.

## Follow-ups
- For an exit with truly no price anywhere, the UI now shows the share count without a fabricated cost
  (or `~$0`); a future nicety could surface the position's current market value as the exit estimate.
- The deep-history price backfill to App A (separate task) is running chunked in parallel; unrelated to this fix.
