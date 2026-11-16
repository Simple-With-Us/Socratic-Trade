# 2026-07-03 — Scan price provenance in `mergeQuoteData` + cross-agent effort log

## Summary
Two things in one lane:
1. **`sources.price` provenance fix** (`src/lib/market.ts`) — the last open item of the #327
   scan-data follow-up (task #28). `mergeQuoteData` replaces a row's `price` from a live
   broker/Yahoo quote, but its `refreshSideProvenance` helper only refreshed `bid`/`ask`/`volume`
   provenance — never `price`. So after a merge, `sources.price` still pointed at the SCREENER,
   and the console scan table / drilldown price tooltip (`priceTitle()`, added in #327) attributed
   the shown value to the wrong source. Now `refreshSideProvenance` attributes `price` to the merge
   provider, and the early-return guard honors a price-only merge.
2. **`docs/EFFORT-LOG.md`** (new) — a single cross-agent effort ledger with four states
   (Planned / In Progress / Completed=merged-to-main / Deployed-to-production=owner release), wired
   into the `AGENTS.md` Pre-Commit / Handoff Protocol as a required update for every agent on every
   platform.

## Why
- Price is a **real datum** even when the derived spread is synthetic — the `syntheticBid`/
  `syntheticAsk`/`syntheticSpread` flags describe the price-DERIVED bid/ask only, not the last/mark
  price. So a merged `price` should always carry the actual provider, exactly like `volume` already
  does. Leaving `sources.price` stale made an honest, correctly-sourced price read as coming from
  the delayed screener. Server-side is the clean fix (the #327 client noted this and deferred it to
  the src/lib owner).
- The effort log gives the owner one board to see all in-flight/landed/deployed work across the
  several AI tools touching this repo, and a durable rule so it stays current.

## Files
- `src/lib/market.ts` — `refreshSideProvenance`: add `price?` to the extra type, compute `usedPrice`,
  include it in the early-return guard, set `next.price = extra.provider` when used; comment updated.
- `test/market.test.ts` — 2 new `mergeQuoteData` tests (broker-price attribution on both tiers;
  real price provider even when the spread is synthetic).
- `docs/EFFORT-LOG.md` — new cross-agent effort board.
- `AGENTS.md` — handoff protocol step 2 now requires updating `docs/EFFORT-LOG.md`.
- `STATUS.md`, `docs/rollouts/2026-07-03-mergequote-price-provenance.md` — this note.

## Verification
- `npx vitest run test/market.test.ts` — 22 pass (incl. the 2 new).
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (295 grandfathered warnings).
- `npm test` + `npm run build` — full gate (see commit; run green before push).

## Reconciliation (what "others" landed while this session was away)
Everything from the console-port + tax + backlog discussion is merged: console waves #321–#330,
wash-sale modes #323, IRA disregard #331 (all incl. this session's coordinator review fixes), and
backend backlog #332 (Sentry) / #333 (chat idempotency) / #334 (proposedByModel + macro blank
honesty) / #335 (orders limit/TIF + congress cap + summary factor fields). This `sources.price` fix
was the only concrete open item remaining.

## Follow-ups
- **Blocked on owner:** three sovereign-design decisions (drawdown breakers advisory-vs-hard;
  stop-loss prompt-expected-vs-schema-forced; Manager model tier + budget) gate the next major
  build. Captured in `docs/EFFORT-LOG.md` with recommendations.
- Draft PR #315 (NAV_V2 restructure) is superseded by the console port — owner to close or keep.
- The smart-money cap half of task #28 (disclosure-ordered congress) already landed in #335.
