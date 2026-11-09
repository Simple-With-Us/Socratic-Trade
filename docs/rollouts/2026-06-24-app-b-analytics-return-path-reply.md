# Rollout — App B reply to App A: return-path + analytics ownership (2026-06-24)

## Summary
Authored App B's coordination reply to App A (congress.trade) covering the two
open questions in App A's note + follow-up: (1) the A→B price/spx/ref return-path,
and (2) composite-analytics ownership/transport. Also responded to the PR #46
fundamentals/analyst import ask. New doc: `docs/congress-trade-app-b-reply.md`.
No production code changed this pass — this is a grounded coordination decision
+ paper trail; the two implied implementation follow-ups are scoped, not built.

## Why
The reply had to reflect App B's *actual* code state, not the optimistic framing
of the inbound message. Verified against the codebase:
- **Return-path receiver does not exist.** We have an outbound pusher
  (`congress-share.ts`) and a cache-aside HTTP *reader* (`congress-trade-client.ts`),
  but **no inbound `/securities/import` route** and **no local writable EOD price
  table** (`price_eod`/`spx_eod`/`securities_ref` are App A's). So "send us your
  endpoint" can't be satisfied by a quick mirror — it needs a new route + a local
  EOD cache tier in `fetchDailyOHLC`. Called this out honestly rather than implying
  it's live.
- **Analytics: pull/pull is already the architecture.** `congress-analytics.ts`
  pulls App A's `/api/analytics/*` daily (default-off overlay); App A pulls our
  `/api/market/*`. Accepted App A's ownership split and chose *consume their read
  API* over *have them push aggregates* — lower coupling, each store stays
  authoritative, our consumption is daily so pull latency is moot.
- **Fundamentals/analyst push:** `MarketQuote` carries the fundamentals fields
  (`peRatio/eps/dividendYield/fcfYield/debtToEquity/epsGrowth/52w range`, `beta`)
  and analyst `counts {strongBuy,buy,hold,sell,strongSell}` + `analystRating` — so
  we can fill those. We do **not** source numeric price targets
  (`targetMean/High/Low/Median`), so those will be null. Documented which columns
  we can actually populate so App A keeps them nullable.

## Files
- `docs/congress-trade-app-b-reply.md` (new) — the reply.
- `docs/rollouts/2026-06-24-app-b-analytics-return-path-reply.md` (new) — this note.
- `STATUS.md` — new dated section at top.
- `PLAN.md` — integrations section notes the reply + the two scoped follow-up PRs.

## Verification
No code changed, so the tsc/test/build trio is unaffected by this pass. Verified
claims by reading: `src/lib/congress-share.ts`, `src/lib/congress-trade-client.ts`,
`src/lib/types.ts` (MarketQuote fundamentals/analyst fields), the `app/api/**`
route list (confirmed no `securities/import` receiver exists), and
`docs/congress-trade-{share,consume}.md`.

## Follow-ups (scoped, not built this pass)
1. `feat/securities-import-receiver` — `POST /api/admin/securities/import`
   (bearer `APP_B_INGEST_TOKEN`, default-closed) + a local EOD cache table wired
   as a `fetchDailyOHLC` tier. Unblocks App A's return-path. Contract specified in
   the reply doc §1.3.
2. Extend `congress-share.ts` payload + builders with `fundamentals[]`/`analyst[]`
   (mirror `buildInsiderImport`), riding the existing nightly batch; enable once
   App A's PR #46 migration is applied.

Decision pending owner: whether to build (1) and/or (2) now or treat the reply as
the deliverable. Token handoff for the receiver is out-of-band (secret channel),
never committed.
</content>
