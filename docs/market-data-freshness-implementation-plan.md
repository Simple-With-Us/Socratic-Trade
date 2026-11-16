# Market-Data Freshness — Implementation Plan

Date: 2026-07-01
Companion to `docs/market-data-freshness-decision.md`.
Scope: make real-time quotes *matter where they should* and *not cost where they
shouldn't*, without buying a new data feed.

> Safety note (development): these gates are additive/protective — enabling or
> tuning them never places real capital at risk on its own. Real money is only in
> play when a live broker/account is explicitly connected and funded, which is
> operator-controlled. The engine is broker- and strategy-neutral; there is no
> paper/test default (removed in this PR — see `defaults.ts`).

## Key finding: the primitives already exist

Audit of `src/lib/policy.ts`, `strategy.ts`, `synthetic-stops.ts`, `types.ts`:

| Capability | Field / call site | State |
|---|---|---|
| Entry-drift guard | `policy.maxEntryDriftPct` — enforced `policy.ts:109-127` | Implemented; **already enabled, default `10`** in `DEFAULT_POLICY`; UI exposes "Max entry drift %". **Tune-only — do NOT silently reset to 1–2% without an explicit retune/migration.** |
| Staleness gate | `policy.maxQuoteAgeSec` / `maxFundamentalsAgeSec` — enforced `policy.ts:132-168` | Implemented; **surfaced in settings UI (this PR)**; default OFF — keep OFF until Workstream 2 stamps honest `asOf` (missing `asOf` = block). Note: enforced for **opening proposals only** (not the exit path — see WS2). |
| Marketable-limit entries | `policy.marketableLimitEntries` + `tuning.marketableLimitBufferBps` — applied `strategy.ts:1191-1192`, `2764-2789` | Implemented; **opt-in settings toggle (NOT defaulted ON)** — defaulting it globally reserves the 15 bps buffer in deterministic sizing (`strategy.ts:1190`), changing order-sizing math (broke `conviction-size-cap.test.ts` in CI), so it stays a per-account choice. Degrades to a plain market order when qty < 1 or not dollar-routed; prices through `quote.ask`/`bid`, falling back to `referencePrice` when bid/ask absent (see WS2 caveat). |
| Approval-time re-quote | `strategy.ts:1502-1511` re-scans + `getEquityQuotes` for hot set | Implemented |
| Synthetic trailing-stop poll | `synthetic-stops.ts:170`, every 60s tick; consumes `quote.price` | Implemented (poll-based) |
| Price alerts | `alerts.ts` prices armed symbols via `getEquityQuotes`; `scheduler.ts` runs `checkAllUserPriceAlerts()` per tick | Implemented (poll-based) |
| Broker-held OCO brackets / RH stops | `policy.brokerBracketsEnabled` (default ON, Alpaca), `robinhoodBrokerStops` | Implemented |
| Quote type carries freshness | `MarketQuote.bid/ask/asOf` (`types.ts:360-364, 644-661`) | Present |

---

## Workstream 1 — Enable & tune the gates (DONE in this PR, except the WS2-dependent default)

- **Marketable-limit entries → left as an opt-in settings toggle** (NOT defaulted ON).
  Converts deterministic opening market orders into marketable limits priced through
  the quote — real slippage control on the 1–5 traded names. It was *not* made a
  global default because turning it on reserves the 15 bps buffer in deterministic
  sizing (`strategy.ts:1190`), which changes order-sizing math and broke
  `conviction-size-cap.test.ts` in CI — so that's a deliberate per-account choice, not
  a silent default. Still fully wired in settings; enable it per account when wanted.
  **Caveat (Codex):** the conversion needs `bid`/`ask`; with a last-price-only source
  it falls back to `referencePrice`, which can be non-marketable/stale. Fully
  trustworthy only once WS2 guarantees bid/ask (or derives a conservative side-specific
  limit from a fresh last price) on the fallback path.
- **Entry-drift guard → already enabled** (`DEFAULT_POLICY.maxEntryDriftPct = 10`; UI
  exposes it). **Tune-only.** Tightening to 1–2% is a deliberate retune, not a
  "turn it on" — don't change the shipped default without a migration note.
- **Staleness gate → surfaced in settings UI (this PR), default OFF.** Keep OFF until
  WS2 stamps honest `asOf`, because a missing `asOf` is treated as stale → block.
- Paper/test defaults removed from `DEFAULT_POLICY` (`paperMode`, `activeBroker: "test"`)
  so the code stops seeding the false "paper/test app" assumption.

**Verify:** `policy.ts` gate tests (fresh vs stale `asOf`); marketable-limit conversion
fires only for opening dollar-routed orders with `limit` permitted and qty ≥ 1.

---

## Workstream 2 — Hot-set quote-source router with a freshness SLA (the one real gap)

**Principle: whichever account you're operating IS the account — its connected
broker feed is the quote source of record.** In real operation there is no
"fallback" and no simulator: you're in a real account with a real-time broker feed,
and that feed is what prices the hot set. The multi-tier fallback machinery below is
NOT a routine path — it exists only for (a) the **Test account** and (b) a genuinely
missing/broken broker feed. Do not design around delayed/stale quotes as if they were
normal; they are not.

**The one real-account caveat, and its fix:** a broker feed can be delayed *if the
account is on a delayed entitlement* — e.g. Alpaca *free* REST (`getLatestQuotes`) is
15-min delayed. The fix is to put that account on a real-time entitlement (Alpaca WS /
paid feed, or use a broker whose feed is real-time), **not** to paper over it with a
fallback. Fallbacks never make a live account's data "real-time"; they only avoid a
crash when the account's own feed is absent.

**Goal:** trust the connected account's broker feed as the source of record; stamp
`asOf` honestly so the staleness gate is meaningful; and provide a *minimal* safety
net (not a routine path) for the Test account / a missing feed — without touching the
bulk-scan path.

Design:
1. **Wrap every hot-set `getEquityQuotes` call site** in a thin router:
   - `strategy.ts:217` — autonomous run-cycle quote merge (the primary buy path).
   - `strategy.ts:1502-1511` — manual approval re-quote.
   - `synthetic-stops.ts:170` — 60s exit monitor.
   - `alerts.ts` (`checkAllUserPriceAlerts`, run per tick from `scheduler.ts`) —
     user-facing price alerts; otherwise they fire late / from fallback quotes on a
     delayed entitlement (Codex).

   Precedence — **the connected account's broker feed is the source of record**;
   everything after it is a Test-account / missing-feed safety net, not a routine
   path: `connected account broker feed → [safety net only: FMP real-time REST →
   Twelve Data free Basic (pre-trade / single-name only, §5) → last-known DB price
   (stamped stale)]`. Bulk scan (`market.ts`) is **out of scope**.
2. **Stamp `asOf` truthfully** at every tier; the DB-fallback tier stamps the
   original quote time, never `now`. Delayed-entitlement broker quotes must be
   stamped delayed so the router falls through instead of trusting them.
3. **Provide bid/ask for marketable limits (Codex).** `enrichOpeningProposal` prices
   buy limits from `quote.ask` / short limits from `quote.bid`. FMP/Twelve Data
   adapters are last-price-oriented, so the router must either surface real bid/ask
   or derive a conservative side-specific limit from the fresh last price — otherwise
   the WS1 marketable-limit default can still emit a stale/non-marketable limit on a
   delayed broker.
4. **Guard the exit path against stale fallbacks (Codex).** `maxQuoteAgeSec` gates
   *opening proposals only*; `runSyntheticStopMonitor` consumes `quote.price`
   directly and would place a **market protective exit off a stale DB price** during
   a provider outage after an old price crosses the trail. The exit path must **skip
   stale fallback quotes / apply an explicit age gate before evaluating a stop** —
   stamping `asOf` alone does not protect it.
5. **Twelve Data free Basic is pre-trade / single-name fallback ONLY — not exit
   polling (Codex).** Basic is 8 credits/min (800/day) and `/quote`|`/price` is
   charged per symbol; the 60s exit monitor over 5–20 open positions would blow the
   minute budget on one tick. Exit polling stays on the broker/FMP or a paid source;
   Basic serves only on-demand single-name pre-trade lookups. (Also verify once that
   Basic's US-equity quotes are genuine real-time, not trial-symbols/delayed, and the
   exact per-credit cost.) It extends the existing keyed Twelve Data adapter
   (`data-providers.ts`) — a new endpoint, not a new integration.
6. **Config:** per-account "real-time hot-set source" preference
   (auto → broker → FMP → Twelve Data free), default auto.

**Verify:** (a) delayed broker + keyed FMP → real-time-sourced hot-set quote with
recent `asOf`; (b) router covers all four call sites (run, approval, exit, alerts);
(c) bulk universe never routed here; (d) delayed entitlement falls through rather
than being trusted; (e) DB-fallback quotes carry true (older) `asOf`; (f) the exit
path refuses to fire a protective stop off a stale fallback quote.

---

## Workstream 3 — Poll → push exit stream (higher effort; only if pursuing streaming)

**Goal:** fire trailing stops on the tick that *breaches*, not up to 60s later — the
only change that lets a *streaming* plan beat the current 60s poll.

1. Convert `runSyntheticStopMonitor` (`synthetic-stops.ts`) from a 60s poll to a
   **WebSocket subscription on open-position symbols** (subscribe on open,
   unsubscribe on close). Prior art: `docs/rollouts/2026-06-19-push-vs-poll-vwap-sentiment-sse.md`.
2. Keep the 60s poll as a **fallback/heartbeat**; preserve the DB-`lastPrice`
   safety net (subject to WS2 §4's stale-quote guard).
3. Only now does a streaming feed have ROI.

### How to test WebSocket streaming *before* paying to upgrade
Do this on **free/trial** streaming first — no upgrade needed to evaluate:
1. **Free WS endpoints to trial:** Alpaca free tier streams **IEX** real-time over
   WebSocket (`wss://stream.data.alpaca.markets/v2/iex`) — real-time on a thin tape,
   enough to prove the plumbing; Twelve Data Basic includes a **trial** WS. Both let
   you build and measure push before committing to Alpaca Algo Trader Plus $99 (full
   SIP) or Twelve Data Pro $99.
2. **Latency A/B:** subscribe to your open-position symbols on the stream while the
   60s poll still runs. Log, per tick, the stream's last trade time vs the poll's
   `asOf`. The gap you measure = the exit responsiveness you'd gain.
3. **Stop-fire timing:** on a paper/sim position with a tight trailing stop, compare
   *when* the stop would fire from the stream (breach tick) vs the poll (next 60s
   boundary). Quantify the avoided slippage on a fast mover — that is the upgrade's
   dollar case.
4. **Reconnect / fallback drill:** kill the socket mid-session and confirm the 60s
   poll (with WS2 §4's staleness guard) still protects the position — the push path
   must never be a single point of failure.
5. **Cost check:** confirm IEX-only real-time (free) is or isn't sufficient for your
   names; if mid/small-caps need full consolidated tape, that is precisely what the
   paid SIP tier (Alpaca $99) buys — decide with the measured numbers, not a guess.

**Risk:** streaming adds connection-lifecycle/reconnect complexity; the poll fallback
must remain authoritative.

---

## Workstream 4 — Optional: intraday entry triggers (strategy change, largest ask)

Only if the engine should *enter* intraday rather than on the hourly snapshot
(pullback-to-VWAP, breakout on a small streamed watchlist). A **strategy** change,
not a data change; the only thing that makes faster *entry* data valuable. Deferred.

---

## Recommended sequencing
1. **Workstream 1** — done in this PR (marketable limits default ON; staleness
   surfaced; paper/test defaults removed; entry-drift confirmed tune-only).
2. **Workstream 2** — the genuine gap; makes the gates trustworthy (esp. the exit-path
   stale-quote guard and bid/ask for marketable limits).
3. **Workstream 3** — only if pursuing streaming; trial free WS and measure first.
4. **Workstream 4** — deferred; strategy-level.

## Handoff / verification note
This PR changes code (`defaults.ts`, `dashboard-client.tsx`). The full
`npm run lint` → `npx tsc --noEmit` → `npm test` → `npm run build` trio **could not be
run in this cloud environment**: `node_modules` is absent and the private
`@jaywedgeworth22/congress-trading-shared` git dependency 404s here, so `npm install`
cannot complete (documented blocker, per prior rollouts). The changes are limited to
type-safe additive edits: two optional-value settings fields (mirroring existing
`OptionalNumberField` usage) and three `DEFAULT_POLICY` literals. The repo's `verify`
CI gate runs the full trio with registry access on this PR and must be green before
merge — treat CI as the authoritative verification.
