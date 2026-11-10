# 2026-08-12 — Broker data cascade + Webull/eToro/Public + CopyTrader intel

## Context & Objective

Owner asked whether every connected broker is fully featured, whether Webull and
eToro can be first-class venues, whether eToro CopyTrader can be used to evaluate
(and maybe follow) other people, and to wire Public.com.  Follow-up: use **all**
brokers, including the current ones, as data-cascade sources to lift third-party
spend and improve accuracy, plus an advanced learn/follow framework if official
APIs allow it.

## Changes Made

- History cascade now prefers **connected brokers** (Tradier, Alpaca daily IEX
  bars, Robinhood MCP historicals) **before** Massive / ROIC / Tiingo /
  Marketstack / Yahoo.
- Alpaca daily bars added (`data.alpaca.markets` 1Day, split-adjusted IEX) from
  a connected Alpaca account only — not leftover env paper keys.
- Robinhood fundamentals default **on** when `ROBINHOOD_ADAPTER=mcp` (opt out
  with `ROBINHOOD_ENRICHMENT_ENABLED=off`).  Sector/industry still dropped.
- Quote cascade already walked every connected venue (L1a/L1b).  Unchanged.
- Official **CopyTrader intel**: `src/lib/copy-intel.ts` (score + observe /
  allowlist-follow gates) and `src/lib/etoro-copy.ts` (rankings + live
  portfolio, official `public-api.etoro.com` only).  Default mode is
  **observe**.  Auto-copy of strangers is never on.
- `GET /api/copy-intel/rankings` — observe-only;  empty until eToro is
  connected.
- Registry + connect UI + adapters:
  - **Public.com** — live Individual API gateway (accounts, portfolio,
    positions, quotes, tradability, place, cancel).
  - **eToro** — official API gateway (reads, quotes, eligibility, long open;
    US shorts fail closed).
  - **Webull** — connect-ready, fail-closed until official OpenAPI App Key
    signing is enabled after owner approval.

Owner correction 2026-08-12: **eToro has no API access** (Connect button disabled).
**Webull comes later** (Connect disabled).  **Public is connected but unfunded** —
quotes/history may run; `PUBLIC_EXECUTION_ENABLED` default off parks review/place
and empties the venue-contract sides so the LLM does not propose Public orders.

Touched:

- `src/lib/history.ts`, `test/history.test.ts`
- `src/lib/data-providers.ts`
- `src/lib/copy-intel.ts`, `test/copy-intel.test.ts`
- `src/lib/etoro-copy.ts`, `test/etoro-copy.test.ts`
- `src/lib/etoro.ts`, `src/lib/public-broker.ts`, `src/lib/webull.ts`
- `src/lib/types.ts`, `src/lib/broker.ts`, `src/lib/db-api-keys.ts`
- `src/lib/execution-mode.ts`, `src/lib/dashboard.ts`
- `app/api/connected-accounts/route.ts`
- `app/api/copy-intel/rankings/route.ts`
- `app/console/settings/brokers.tsx`, `app/console/settings/lib.ts`
- `docs/EFFORT-LOG.md`, `STATUS.md`, this note

## Decisions & Trade-offs

- Official APIs only.  `webull-unofficial` stays data-only / default off and is
  never used for execution.
- Copy follow is **allowlist + caps**, default observe.  Official eToro copy
  start exists (`POST /api/v2/trading/copy`) but is not fired from this ship.
- Public is live-only (no sandbox).  eToro Demo maps to paper.  Webull sandbox
  is the right first key, but signing is not enabled until the owner applies.
- eToro sells close a `positionId`, not a symbol.  This ship fail-closes a
  generic `sell` until lot-level close is wired.
- US eToro: long real stocks/ETFs.  Short/CFD/options are not sent.

## Verification State

```bash
./node_modules/.bin/vitest run test/history.test.ts test/copy-intel.test.ts test/etoro-copy.test.ts
# 3 files, 36 passed
```

Full `tsc` in this worktree still reports pre-existing missing
`@jaywedgeworth22/congress-trading-shared` unless that private package is
linked.  Not introduced by this change.

## Follow-up (same branch) — venue contract fences LLM tokens

Account capabilities now carry limits (fractional, sessions, trail, brackets,
option *orders* vs option *positions*, min share/notional, position-id closes).
`deriveVenueContract` merges live broker facts with a verified per-venue profile
and drives:

- Green schema enums (`side`, `type`, `marketHours`)
- Green system prompt (no more hardcoded "Robinhood account")
- Red Team skip: a short on a venue that cannot short is rejected **without**
  an LLM call
- Red Team prompt: do not recommend option hedges when `optionsOrders` is false

Verified venue facts used in the profile:

- Robinhood MCP: buy/sell only (live tool schema).  No shorts.  Options exercise
  only — this app does not place option orders.
- Alpaca: shorts iff `shorting_enabled`.  No options API.
- Tradier: shorts iff margin and not IRA.  Whole shares.  No native trail.
- eToro US: long real stocks/ETFs.  Shorts are CFD; not offered.  Regular hours.
- Public: shorts via SELL+OPEN.  Options exist at venue; not on this schema.
- Webull OpenAPI: shorts, trail, brackets.  Options exist at venue; not on this
  schema until we add option orders.

## Next Steps & Blockers

Owner actions (do **not** mint from an agent):

1. **Public** — Settings → Security → API → one secret into `~/.secrets/` +
   Infisical, then Connect Public.  Live money.
2. **eToro** — Settings → Trading → API Key Management.  If the section is
   missing, US API access is blocked.  Start with Demo + Read.  Probe
   eligibility for AAPL and `GET .../people/{pi}/portfolio/live`.
3. **Webull** — website Developer Tool → paper OpenAPI first (auto-approve),
   then production if you want live.  Official quotes are a **separate paid
   OpenAPI market-data sub**.
4. Enable `allowlist-follow` only after watching observe rankings.  Confirm
   CopyTrader is legal in your US state.

Next code: Webull HMAC-SHA1 signer; eToro position-id sells; Copy follow POST
behind allowlist; wire rankings into Insights.

## Zero-Code Findings

Existing brokers are **not** fully featured as both venue and data source.
Alpaca is the most complete venue (tradability stub, local review, no daily
bars until this change).  Robinhood cannot short/trail/bracket.  Tradier has
no native trail and no enrichment.  Quote cascade already used every
connected broker; history did not, and paid third parties sat in front of
Tradier.
