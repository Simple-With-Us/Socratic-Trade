# 2026-07-01 — Market-data freshness: real-time vs delayed decision + implementation plan (Claude)

Branch: `claude/stock-data-pricing-comparison-2wzg8u`

## Summary
Docs-only change. Added two design docs capturing a real-time-vs-15-min-delayed
market-data analysis for the trading engine and the concrete work to act on it:
- `docs/market-data-freshness-decision.md` — decision + architecture note.
- `docs/market-data-freshness-implementation-plan.md` — sequenced implementation
  plan (4 workstreams).

No code paths were touched.

## Why
Owner is evaluating a ~$100/mo stock-data budget and whether to add a Twelve Data
plan on top of the FMP (~$30) and Massive/Polygon ($30) subscriptions already
held. The real question is where quote freshness actually changes decisions in
*this* app, given its cadence (buys ~hourly, exits every 60s), and what would have
to change to exploit real-time.

## Key findings (grounded in the code)
- The engine is already "delayed bulk + real-time hot-set on demand": bulk scan
  runs on cached/delayed data; open positions (`synthetic-stops.ts:170`, per 60s
  tick) and approval candidates (`strategy.ts:1502-1511`) are re-quoted on demand
  via `gateway.getEquityQuotes`.
- Real-time matters **only** at the 60s exit layer and at the order-submission
  instant for the 1–5 traded names — both small hot sets already quotable in real
  time for free via the connected broker (and FMP as a paid real-time REST source).
- The primitives to exploit this already exist but are **default-OFF / un-tuned**:
  `maxEntryDriftPct` (`policy.ts:109-127`), `maxQuoteAgeSec`/`maxFundamentalsAgeSec`
  (`policy.ts:132-168`), `marketableLimitEntries` + `tuning.marketableLimitBufferBps`
  (`strategy.ts:1191-1192, 2764-2773`).
- Vendor corrections: Twelve Data tiers are priced by a credits dropdown (Pro base
  is a real $99, not repriced away), but Pro's increment over Grow $29 is
  EU/AU/fixed-income/mutual-fund data — useless for a US-equity engine.
  Massive/Polygon Developer $79 is **15-min delayed**; real-time is $199 (Advanced).
- Decision: **do not add a new data feed.** FMP + broker (free real-time on traded
  names) + Massive (deep history) already cover the need. The lever is config +
  a small hot-set quote-source router + an optional poll→push exit refactor.

## Files
- Added: `docs/market-data-freshness-decision.md`
- Added: `docs/market-data-freshness-implementation-plan.md`
- Added: `docs/rollouts/2026-07-01-market-data-freshness-decision-and-plan.md` (this note)
- Updated: `STATUS.md` (new dated snapshot entry), `PLAN.md` (new deferred workstream)

## Verification
Docs-only; no code paths changed, so the tsc/test/build trio was intentionally not
run (it would be unaffected). If/when the implementation-plan workstreams are
built, the full `npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build`
trio applies before claiming complete.

## Revision (same PR, 2026-07-01) — Codex review fixes + Twelve Data free tier
Addressed two Codex P2 review comments on PR #288 and folded in the owner's
Twelve-Data-free insight (all doc-only):
- **Broker real-time is entitlement-dependent** (decision doc): corrected the
  overstated "broker feeds = free real-time." Alpaca *free* REST (`getLatestQuotes`,
  the path `getEquityQuotes` uses) is 15-min delayed; real-time needs WebSocket or a
  paid feed. Qualified the vendor table, Decision #1, and the exit-layer
  frequency bullet.
- **Router must cover the autonomous run site** (plan doc): added `strategy.ts:217`
  (run-cycle quote merge) to Workstream 2's router scope alongside the approval and
  synthetic-stop sites, with a matching verify case. Without it, autonomous
  Test/delayed-broker entries would keep consuming stale quotes.
- **Twelve Data free Basic as a $0 real-time fallback**: added as an explicit tier in
  the router precedence (`broker real-time → FMP → Twelve Data free → stamped-stale
  DB`), gated to on-demand small-N pre-trade lookups (8 credits/min, 800/day; never
  bulk), with two verify-once notes (genuine US real-time on Basic; per-credit quote
  cost). This is most valuable precisely when the broker entitlement is delayed.

## Revision 2 (same PR, 2026-07-01) — Workstream 1 wired + defaults corrected + Codex round 2
Now includes CODE, not just docs:
- `src/lib/defaults.ts`: removed the paper/test defaults from `DEFAULT_POLICY`
  (`paperMode: true` → `false`; dropped `activeBroker: "test"`). A fresh policy is
  broker-neutral; `activeBroker` is set when a real broker connects (`db-profiles.ts`),
  and `getBrokerGateway` (`broker.ts:12-13`) already resolves undefined → local sim
  safely. Rationale: the seeded `test`/paper literals propagated a false "paper/test
  app by default" assumption.
  - **`marketableLimitEntries` left as an opt-in settings toggle, NOT a global
    default.** An initial commit defaulted it ON, but CI `verify` showed it changes
    deterministic order sizing (reserves the 15 bps buffer, `strategy.ts:1190`) and
    broke `conviction-size-cap.test.ts` (4 assertions, each ~0.15% low). Reverted the
    default; it stays fully wired as a per-account toggle in settings. This is the
    concrete example of why the verify CI gate is the authoritative check here.
- `app/dashboard-client.tsx`: surfaced "Max quote age (sec)" and "Max fundamentals age
  (sec)" as optional settings fields (mirroring the existing `OptionalNumberField`
  pattern), completing "surface the gates in settings." Staleness stays default-OFF
  pending Workstream 2's honest `asOf`.
- Reframed the plan around the operator's principle: **whichever account you're in is
  the account; its broker feed is the quote source of record.** The fallback tiers are
  a Test-account / missing-feed safety net, not a routine path; a delayed live feed
  (Alpaca free REST) is fixed by using a real-time entitlement, not by routing around
  it.
- Folded in 7 Codex P2 review comments (all correct): entry-drift is already enabled
  (tune-only, not "enable"); marketable limits need bid/ask (router must supply or
  derive them); price-alerts (`alerts.ts`) added to router scope; exit path needs an
  explicit age gate before firing stops off a stale DB fallback; Twelve Data Basic is
  pre-trade/single-name only (its 8 credits/min can't serve 5–20-symbol exit polling);
  verification recorded honestly (below).

**Verification blocker (honest):** the full `lint`/`tsc`/`test`/`build` trio could not
run in this cloud env — `node_modules` is absent and the private
`@jaywedgeworth22/congress-trading-shared` git dep 404s, so `npm install` fails here
(same blocker noted in prior rollouts). Changes are type-safe additive edits (two
optional settings fields + three `DEFAULT_POLICY` literals). The `verify` CI gate runs
the full trio with registry access on the PR and gates merge — that is the
authoritative check.

## Follow-ups
- Workstream 1 (enable/tune `maxQuoteAgeSec`, `maxEntryDriftPct`,
  `marketableLimitEntries` + surface in settings UI) — recommended first.
- Workstream 2 (hot-set quote-source router with honest `asOf` + FMP fallback) —
  the one genuine code gap.
- Workstream 3 (poll→push trailing-stop stream) — only if pursuing a streaming
  data plan; build the push path before buying streaming.
- Workstream 4 (intraday entry triggers) — deferred, strategy-level.
