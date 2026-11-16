# Capability & Platform Expansion — Program Plan (Phase 1)

**Owner directive:** 2026-07-12. **Source:** Phase-1 multi-agent workflow output
(`w76an10kd`) — four recon lanes, four design lanes, two adversarial feasibility
verifications, and a synthesized program. This document renders that workflow's
`.result.program` (plan / packages / sequencing / owner decisions / dissent) plus
the four per-lane `.result.designs` and the two `.result.feasibility` verdicts as
full-fidelity markdown — nothing summarized away from the package specs.

**Status:** Phase 1 (recon + design + feasibility + synthesis) complete. Phase 0
of execution — Wave 0 doc truth-fix — lands with this document. Everything
downstream is **planned, not started**; no capability package below has landed
code yet except where explicitly noted.

**Companion docs:** `docs/EFFORT-LOG.md` (program row + Wave-0 sub-items),
`docs/rollouts/2026-07-12-capability-program-phase1.md` (this phase's rollout
note), `STATUS.md` (iOS truth-fix corrections applied 2026-07-12).

---

## 0. Executive Summary

Seven workstreams, synthesized from four recon lanes, four design lanes, and two
adversarial feasibility verifications. Everything lands dormant/default-off
(auto-deploy is on: merge == live), gated per-account by capability+policy double
gates following the proven short-selling pattern.

---

## 1. Program Plan — Seven Workstreams

### 1. iOS App — honest reset, then a real build

There is no functioning iOS app to "improve": what exists is a 465-line SwiftUI
scaffold (`ios/SocraticTrade/`) with no `.xcodeproj`, no auth, one screen,
functionally unchanged since 2026-07-01 — and status docs in four places falsely
claim a verified `xcodebuild` with tabbed views. Antigravity (AG) has an active
claim on `ios/SocraticTrade/**` for a native rebuild (SwiftUI +
`ASWebAuthenticationSession`). Plan: fix the doc overclaims immediately; AG owns
the Swift side; this program contributes the server-side contract AG needs
(mobile session/API-token auth endpoints, stable JSON DTOs, push later),
following the Congress.Trade pattern of a real checked-in Xcode project
(`xcodegen project.yml`). Explicit sync points (auth flow, data model, API
versioning) prevent an iOS/web fork.

### 2. Web App (desktop + mobile) — consistency, not redesign

Verified findings: `/console/usage` renders the legacy design system inside the
console (visible "wrong app" jump); the new `ios-components.tsx` mixes the two
token systems (`con-*` vs legacy) inside single components, so theme toggles
half-apply; and three pushed commits on `ag/theme-selector` (mobile tabs menu,
iOS-native settings migration, theme selector) have no PR vehicle. Plan: PR the
orphaned commits, port Usage onto `con-*` tokens, fix the token-mixing pattern in
`ios-components.tsx`, then burn down the remainder of the 15-item audit.

### 3. Trading Framework — from "built-but-unwired" to "wired-but-uncalibrated"

The theme has shifted from "built-but-unwired" to "wired-but-uncalibrated." Two
high-leverage fixes: (a) Red Team evidence-parity gap — the adversary reviewer
never sees `ragContext`/`learnedContext` that the Bull's thesis was built on,
despite the code comment declaring evidence parity the point; small fix, real-
money impact. (b) Live execution-quality telemetry — every execution knob
(marketable-limit buffer, impact coefficient, ADV cap) is an uncalibrated guess
because realized decision-to-fill slippage is never measured on live fills; the
`referencePrice`/fill join already exists in the DB. Plus: triage the 15 open
Codex P2 threads left on the Tradier re-land (#1425) and 6 architectural threads
from the reconcile work (#1397).

### 4. Shorts + Leverage (per-account opt-in)

Shorts are ~92% built and verified (four-sided `OrderSide`, double-gated proposal
generation, mandatory stops, notional/exposure caps); the missing base layer is
broker margin truth. Plan is the P0–P9 package train: foundation types
(all-optional, undefined = exact status quo), broker-truth parsing (Alpaca
multiplier/margin telemetry currently thrown away; Tradier `/balances` richness
deliberately unread today; Robinhood honest-undefined), then short-side
buying-power in the sizer (today a short can be sized past affordability),
leverage policy (`marginTradingEnabled`, `maxLeverageRatio`, maintenance buffer
alerts, `marginCallAction` notify→propose_derisk→auto_derisk), HTB/shortability
enrichment, UI, and the probable Tradier "pdt" account-type classification bug
(fail-closed but silently strips shorting from the most active accounts — verify
with live token first).

### 5. Options Groundwork

A dormant substrate mirroring the shorts pattern: OCC instrument model with
strict round-trip parsing (rejecting non-standard contracts honestly rather than
mis-multiplying), BTO/STC/STO/BTC intent model mapped onto the existing 4-value
`OrderSide` so no downstream consumer needs a 5th case, Tradier-first broker
surface (its option sides are the intent model verbatim, chains+greeks on the
same token, sandbox includes options paper), chain/greeks data cascade, then
policy gates and strategist integration. Single-leg first; `legs[]`
future-proofed so spreads are a data-shape non-event. Nothing user-visible until
`optionsTradingEnabled` AND broker capability are both true.

### 6. Kalshi

Two decoupled surfaces. K1 (ship first, low risk): public no-key REST
event-market probabilities (Fed, CPI, recession, shutdown) injected as a distinct
`eventMarkets` evidence block for the strategist — verified accurate against
current docs with small corrections (prices are integer cents by default, not
dollar strings; demo base includes `/trade-api/v2`; prod API keys require full
KYC). K2 (trading, flag-gated, demo-env-first-capable): RSA-PSS-signed gateway
with a genuinely open design question — Kalshi's order model (`action`
buy/sell × `side` yes/no on binary contracts) does not map onto the equity
`OrderSide` union and must be designed explicitly before the gateway PR.

### 7. eToro

Feasible with a blocking gate. The API is real (launched 2025-10-29, self-serve
keys, demo mirror, real order execution) but eToro's own launch press release
says "available to select users" with broader rollout "coming months," and
roughly half the specific endpoints the design cited could not be corroborated
(cancel, order lookup, SL/TP edit, eligibility, costs) while the close-position
flow is documented differently (v1 per-position endpoint). Plan: a 5-minute
owner Day-0 probe (log in, check Settings > Trading > API Key Management, mint a
DEMO key, curl smoke) is the blocking prerequisite; if absent, join the waitlist
and park the lane. If present: read-only gateway from verified-in-portal schemas
only, then execution with frontier review.

---

## 2. Program-Level Owner Decisions

1. **LEVERAGE OFF-STATE SEMANTICS** (most consequential): when
   `marginTradingEnabled` is OFF/unset on a margin account, keep status quo
   (broker buying power is the only ceiling — which already silently permits
   ~2x today; zero behavior change) or clamp openings to ~cash ("off means
   unlevered" — honest but a real behavior change that could reject trades that
   pass today). Recommendation: status quo for the migration, revisit after
   telemetry ships.
2. Default `maxLeverageRatio` when an account flips `marginTradingEnabled` ON —
   recommend 1.5x (brokers allow 2.0x Reg-T overnight); owner-adjustable/removable
   afterward.
3. iOS direction: confirm the native rebuild AG started is the wanted path
   (commit a real xcodegen `.xcodeproj`, Congress.Trade pattern) vs retiring
   `ios/` as reference-only; and approve the auth approach
   (`ASWebAuthenticationSession` + scoped API tokens).
4. Options: (a) confirm Tradier-first (recommended with confidence — native
   BTO/STC/STO/BTC sides, chains+greeks on the existing token, sandbox has
   options); (b) is sell-to-open (naked/covered short options) in scope for v1
   or buy-side + covered only; (c) which account gets options enabled first.
5. Kalshi: (a) is event-contract TRADING wanted now, or K1 data only
   ("possibly" in the directive — K2 is fully separable); (b) demo-connect-first
   as integration verification (recommended; demo is separate credentials, maps
   to environment=paper — an account is an account, not a safety ritual) vs
   straight to live; (c) note prod API keys require completed KYC (name/DOB/SSN/
   ID) — owner onboarding action; (d) curated series list sign-off and whether
   the elections category toggle starts on.
6. eToro Day-0 probe (BLOCKING, ~5 min, owner-only): log into eToro, check
   Settings > Trading > API Key Management, mint a DEMO key. Agents cannot
   create the account or accept eToro's terms. If the section is absent:
   waitlist and park the lane. Also: scope call — US equities (overlaps
   Alpaca/Tradier) vs its differentiators (crypto/social data); and
   marketable-order policy given eToro has no true limit order.
7. Tradier live-token session (unblocks three packages): validate OTOCO
   leg-class shape, GTC cross-session visibility, and the probable "pdt"
   account-type capability misclassification.
8. Slippage telemetry follow-on: approve advisory-only now, with buffer
   auto-tune as a later explicit opt-in.

---

## 3. Sequencing — Waves

WAVES (respecting keepouts, `types.ts` serialization, and auto-deploy). Auto-
deploy consequence baked in: every merge deploys to prod immediately, so every
package is dormant (optional fields, undefined = status quo, no package flips a
flag; owner enables per account in the UI). Box builds serialize
(`concurrent_builds=1`) — space main merges hours apart, never burst.

**ACTIVE KEEPOUTS** (from the live board, 2026-07-12): AG owns
`ios/SocraticTrade/**` (native rebuild) — no CLAUDE edits there, coordinate via
#ag***-s**c. CODEX owns the notification system. CLAUDE in-progress claims block
`strategy.ts` (PR #1371 stop-plans + ~54-site attribution sweep),
`broker-protective-stops.ts`, `synthetic-stops.ts`, `data-providers.ts` (FMP
quota PR), and `tradier.ts` (adapter live-token validation pending). Any package
touching those files queues behind the claim or claims a file-disjoint sub-row on
the effort board first.

- **WAVE 0** (now, parallel, conflict-free): D1 doc truth-fix; D2 orphan-commit
  PR; eToro PR0 owner probe (owner action — agents must not create the account
  or accept ToS); K1 fetcher module (new file, no shared-file contact); K2-pre
  Kalshi order-model design memo; escalate Tradier live-token validation
  (unblocks SL-P1/P1b and the O3 sandbox path).
- **WAVE 1** (types foundation, STRICTLY SERIALIZED — SL-P0 → O1 → O2 all touch
  `src/lib/types.ts`; land one, rebase the next): SL-P0, then O1, then O2. Also
  W1 and W2 (web, disjoint) in parallel.
- **WAVE 2** (after `tradier.ts` keepout clears + #1371 lands): SL-P1 broker
  truth; SL-P1b pdt verify; F1 Red Team parity (`strategy.ts` now free); F2
  slippage telemetry; K1 `strategy.ts` injection (small, sequenced after F1 to
  avoid `strategy.ts` collisions); SL-P6 enrichment (after `data-providers.ts`
  FMP PR merges); W3 audit burn-down.
- **WAVE 3**: SL-P2 sizer (F review); O3 + O4 in parallel (disjoint); SL-P7 UI;
  F3 Tradier debt triage; I1 mobile auth contract (design sync with AG first).
- **WAVE 4**: SL-P4 leverage policy; SL-P5 margin-call watcher; O5 policy gates;
  K2a gateway (demo-verified; gated on K2-pre memo + owner KYC status for prod);
  ET1+ET2 if PR0 passed.
- **WAVE 5**: SL-P8/P9; O6 strategist+UI; K2b/K2c; ET3 execution (F review,
  demo-verified); I3 push (behind CODEX notification work).

**LANDING DISCIPLINE:** one PR per package via `scripts/land.sh`; merge with
`gh pr merge --squash --auto` behind the verify gate; after each merge run the
`deploy-verify` skill (auto-deploy fires immediately); space merges to respect
the single-build box; `types.ts` and `strategy.ts` packages never in flight
concurrently; every money-path package (SL-P2/P4/P5, O3/O5/O6 placement,
K2a-c, ET3) gets adversarial verify beyond green tests — this practice already
caught real money-path bugs the suite missed.

---

## 4. Package Train (program-level roll-up, all lanes)

Legend: size S/M/L; tier H=Haiku (mechanical), S=Sonnet (default impl),
F=Frontier (money-path-subtle / critical verify). All money-touching packages
get adversarial review beyond green tests (this caught real bugs in the Tradier
program). Every package lands via `scripts/land.sh` with lint+tsc+test+build
green, dormant, default-off.

### DOCS/TRUTH (Wave 0)

- **D1 Status-doc truth fix** (S, H): correct iOS overclaims in `STATUS.md:29`,
  `docs/EFFORT-LOG.md:516`, `/Users/jay/apps/TRADING-EFFORT-LOG.md:236+:1329`
  ("xcodegen/xcodebuild verified/tabbed views" — all false); also correct the
  memory-board mislabel of PR #1389 (it was FMP quota metering, not a
  capability foundation PR). Tests: none. No flags. *(This document + the
  STATUS.md/docs/EFFORT-LOG.md edits landing alongside it constitute D1's repo
  portion; the memory-board and live-board corrections are noted as a
  follow-up — see the rollout note.)*
- **D2 Orphan-commit PR** (S, H): open a PR for the 3 pushed commits on
  `ag/theme-selector` (`104f5ec0`/`78f6854a`/`880b626a`) so they have a merge
  vehicle. Review: normal.

### SHORTS+LEVERAGE (design lane P0–P9)

- **SL-P0 Foundation types+defaults** (S, H with F spot-check on defaults):
  `types.ts` + `defaults.ts` only — policy fields (`marginTradingEnabled`,
  `maxLeverageRatio`, `maintenanceBufferPct`, `marginCallAction`, `htbPolicy`),
  `AccountCapabilities` (`multiplier`, `dayTradeBuyingPowerSupported`,
  `capabilitiesRefreshedAt`), Portfolio margin telemetry fields,
  `SymbolEnrichment` `shortable`/`easyToBorrow`. All optional; undefined = exact
  status quo. Tests: defaults-unchanged snapshot, tsc across suite. Zero
  runtime change. LANDS FIRST — every other `types.ts` consumer rebases on it.
- **SL-P1 Broker truth** (M, S impl + F review — feeds sizing): `alpaca.ts`
  (multiplier→marginEnabled fix + margin telemetry), `tradier.ts`
  (`fed_call`/`maintenance_call`/`short_market_value`; currently
  fetched-and-discarded), `robinhood.ts` (honest undefined), capability
  refresh-on-fetch. Tests REQUIRED: fixture parse per broker incl. multiplier
  1/2/4, Tradier IRA-margin-no-short pinned, legacy rows parse. KEEPOUT:
  `tradier.ts` has pending live-token validation from the adapter rounds —
  sequence behind it.
- **SL-P1b Tradier "pdt" account-type verify+fix** (S, S; needs owner live
  token): confirm whether `capsFromProfile` misclassifies PDT-designated margin
  accounts as non-margin (silently stripping shorting); fix with fixture test.
- **SL-P2 Short-side buying power in sizer** (M, F — money-path): extend
  `openingRiskCapacity`'s BP cap (`strategy.ts:2813-2815` is buy-only) to
  shorts, Reg-T-aware once `BrokerMargin` exists. Tests: sizing table across
  long/short × cash/margin. Gated: only bites when `shortSellingEnabled`.
- **SL-P4 Leverage policy enforcement** (M, F): `maxLeverageRatio` cap on
  opening sides when `marginTradingEnabled=true`; `maintenanceBufferPct`
  advisory alerts; `htbPolicy` gate on short opens. Advisory-first per owner
  guardrail philosophy (adjustable, override-able, never a cage).
- **SL-P5 Margin-call watcher + derisk pipeline** (M, F): `marginCallAction`
  notify (default) / propose_derisk (feeds NORMAL pipeline: policy→red
  team→approval) / auto_derisk (explicit opt-in). Tests: state machine per
  action mode.
- **SL-P6 Shortability/HTB enrichment** (M, S): `shortable`/`easyToBorrow`
  through the six-point enrichment wiring trap (`SymbolEnrichment`,
  `EnrichmentSourcedField`, `takeScalar`, `EMPTY_SOURCED`,
  `MarketQuote`/`Summary`, `market.ts` merge). Tests: field-propagation.
- **SL-P7 Margin telemetry UI** (S/M, S): dashboard/console surfacing of
  multiplier, excess liquidity, calls; `con-*` tokens only. Tests: render.
- **SL-P8 Ops snapshot + docs** (S, H). **SL-P9 Strategist prompt awareness of
  leverage state** (S, S impl + F prompt review).

### OPTIONS (design lane O1–O6)

- **O1 Instrument model** (S, S — parsing subtlety warrants Sonnet despite
  mechanical shape): `src/lib/options-symbols.ts` (OCC round-trip
  `toOccSymbol`/`parseOccSymbol`, `isOccSymbol` centralizing
  `tradier.ts:497`'s inline regex, `occRootForUnderlying` BRK-B↔BRKB), types.ts
  additions. Tests REQUIRED: round-trip property tests + rejection of
  adjusted/non-standard (multiplier≠100). Dormant pure lib.
- **O2 Order model + intent mapping** (M, S impl + F review of
  `intentToOrderSide`): optional `TradeProposal`/`EquityOrderInput` fields
  (`assetClass`, `optionContract`, `positionIntent`, `legs[]` with >1
  rejected), BTO→buy/STC→sell/STO→short/BTC→cover mapping so
  policy/db-execution/performance/red-team side-switches keep working. Tests:
  `validateOptionOrderInput` matrix. Dormant: no producer sets
  `assetClass=option`.
- **O3 Broker surface** (M/L, S impl + F review on the placement path):
  optional `BrokerGateway` methods, Tradier chains/expirations/positions/
  place/cancel/review, Alpaca `optionsLevel` capability honesty. Verify against
  Tradier SANDBOX before merge; the #1425 GTC-visibility debt applies. Dormant:
  nothing calls in prod paths.
- **O4 Data plumbing** (M, S): `options-data.ts` chain/greeks/IV cascade
  Tradier→Alpaca→Yahoo with `logApiHealth`+TTL. Parallel with O3.
- **O5 Policy gates + risk** (M, F): `optionsTradingEnabled` double gate,
  per-account notional/exposure caps, mandatory-risk semantics. Default off.
- **O6 Strategist integration + UI** (M/L, F prompt + S UI): LLM schema
  restricted to allowed intents, limits priced off chain mid (advisory-warn
  market orders, never block).

### KALSHI (K1 data first; K2 trading gated)

- **K1 Event-market evidence** (S/M, S): `src/lib/market-signals/kalshi.ts` —
  public `GET /markets?series_ticker&status=open`, curated series config
  (Fed/CPI/recession/shutdown; elections behind toggle), `impliedProb` from
  integer-CENTS `yes_bid`/`yes_ask` mid (verifier correction — not dollar
  strings), 15-30min success-only TTL; separate `eventMarkets` prompt block +
  one `strategy-prompts.ts` guidance line. Tests: mocked-fetch shape/pruning/
  cache. KEEPOUT: the `strategy.ts` injection point waits behind PR #1371 +
  attribution sweep; land the fetcher module first, injection second. K1b
  console tile (S, S, optional) via `con-*` composite recipe.
- **K2-pre Order-model design memo** (S, F — design-heavy): resolve the
  verified-open gap of mapping `action(buy/sell)`×`side(yes/no)` binary
  contracts onto/beside `OrderSide` before any gateway code. BLOCKS K2a.
- **K2a Gateway + connect** (M/L, S impl + F review): `src/lib/kalshi.ts`
  RSA-PSS signer (`KALSHI-ACCESS-*` headers, timestamp+method+path),
  env-scoped demo/prod bases incl. `/trade-api/v2` path, subaccount 0 only
  (1-63 are institution-gated), `AccountCapabilities.eventContracts`, connect
  UI (PEM via secret-file handoff, never chat). Demo-env verify before merge.
  Note: PROD keys require completed KYC — sequencing fact for the owner.
- **K2b Policy + event sleeve** (M, F): `eventContractsEnabled` double gate,
  `maxEventOrderNotional`/`maxEventExposureNotional`, no-op wash-sale/sector/
  stops for the sleeve, strategist event-sleeve prompt fed by K1. **K2c**
  execution+UI (M, F on placement).

### ETORO (all gated on PR0)

- **PR0 Owner Day-0 probe** (owner-only, no code): check Settings > Trading >
  API Key Management; mint DEMO Read+Write key; curl smoke
  `GET /api/v1/trading/info/demo/pnl` with 3 headers; also check whether
  `builders.etoro.com` app-registration implies a second approval tier. If
  absent → waitlist, park lane.
- **ET1 Schema verification pass** (S, S; requires authenticated portal access
  post-probe): confirm/refute the five unverified endpoints (cancel,
  orders:lookup, PATCH SL/TP, eligibility, costs), the v1 vs v2 close-position
  shape, and real rate-limit tiers, from the live OpenAPI spec — adapter code
  trusts only portal-verified schemas.
- **ET2 Registry + read-only gateway** (M, S): "etoro" in both unions,
  `resolveGateway`, execution-mode, `src/lib/etoro.ts` read methods +
  instrument-ID cache + rate limiter (assume 60/60s info tier until verified),
  recorded-fixture tests mirroring `test/tradier.test.ts`. Zero new npm deps
  (plain fetch, repo convention).
- **ET3 Execution** (M/L, F — money path): order placement with close via the
  documented v1 `market-close-orders/positions/{id}` endpoint (per verifier),
  partial-close allocation, marketable-limit policy per owner decision,
  demo-env verified before real.

### FRAMEWORK

- **F1 Red Team evidence parity** (S, S impl + F review): add
  `retrievedFinancialContext` + `learnedContext` to `adversaryContext`
  (`strategy.ts:3785-3801`) and `RedTeamReviewContext` (`red-team.ts:71-88`) +
  prompt line. Tests: context-assembly assertion. KEEPOUT: behind
  #1371/attribution sweep on `strategy.ts`.
- **F2 Live slippage telemetry** (M, S impl + F on the recommendation logic):
  per-fill slippage record (bps vs persisted `referencePrice`) aggregated per
  liquidity-bucket/order-type/broker; surface + advisory buffer recommendation;
  auto-tune later as separate opt-in.
- **F3 Tradier debt triage** (M, S): the 15 open Codex P2 threads from #1425
  (delayed-close sizing, GTC visibility across sessions, fractional rejects) +
  6 architectural threads from #1397, batched via the codex-triage pattern.

### WEB CONSOLE

- **W1 `/console/usage` con-\* port** (S/M, S): rewrite `llm-usage-client`
  onto console tokens. **W2** `ios-components.tsx` token unification (S, S
  impl + F pattern sign-off since it sets the precedent for all settings
  pages): `con-*` only inside console components; document the rule in
  `console.css` header. **W3** Audit burn-down (M, S): remaining items of the
  15-item list, sliced file-disjoint.

### iOS (AG-owned lane; this program's server-side contributions only)

- **I1 Mobile auth contract** (M, F design + S impl): session/API-token
  endpoints for `ASWebAuthenticationSession`, scoped tokens, DTO versioning —
  coordinated with AG via #ag***-s**c before code. **I2** Xcode project
  decision support (S, H): if owner confirms native, adopt the Congress.Trade
  checked-in xcodegen pattern (AG executes). **I3** Push notification plumbing
  (M, S, later — behind CODEX notification-truth work).

Every package: run `npm run lint`, `npx tsc --noEmit`, `npm test`,
`npm run build` before `land.sh`; commit msgs reference docs updated;
effort-board rows Planned→In Progress→Completed per row.

---

## 5. Dissent — Where the Evidence Contradicts the Directive's Framing

Four places the evidence contradicts the directive's framing, stated plainly:

1. **"Improve the drafted iOS app"** — there is no app to improve. The scaffold
   has no Xcode project, no auth, one screen, and hasn't gained a line of
   functional code since 2026-07-01; the status docs claiming a verified build
   are false and are being corrected. This is a ground-up build (already
   started in AG's lane), and it should be planned and resourced as one.
2. **"eToro as a fully supported broker"** cannot be committed to today.
   eToro's own launch press release — not just a stale marketing page — says
   the API is available to "select users" with broader rollout "planned in the
   coming months"; the design's original caveat undersold this. Additionally,
   about half the specific trading endpoints the design cited are
   unverifiable from any public source (cancel, order lookup, SL/TP edit,
   eligibility, costs) while the documented close-position flow contradicts
   the design's version. The lane is genuinely promising but is gated on a
   5-minute owner probe with a real park-the-lane outcome; "fully supported"
   is a conditional milestone, not a plannable certainty.
3. **"Add leverage trading"** mischaracterizes the status quo: margin accounts
   can already lever to ~2x silently because broker buying power is the only
   ceiling. What this program actually adds is honesty and control — margin
   telemetry, an owner-set cap, maintenance alerts, and call handling. The one
   real decision (what OFF means) is Owner Decision #1.
4. **Kalshi "possibly event-contract trading"** hides a real design gap the
   verifier confirmed: Kalshi's order model (buy/sell × yes/no binary
   contracts) does not map onto the equity `OrderSide` union, and prod keys
   require full KYC. The data surface (K1) is low-risk and immediately
   valuable; trading (K2) needs a design memo and an owner onboarding step
   before any gateway code. Treat them as separate commitments.

**Minor record correction:** memory labels PR #1389 a capability-program
foundation PR; it was actually FMP quota metering — the board note should be
fixed so future planning doesn't build on the mislabel.

---

## 6. Per-Lane Design Deep-Dives

### 6.1 Short-Selling + Leverage

#### Current State (verified baseline at HEAD `104f5ec0`, all recon claims spot-checked)

**SHORTS (~92% built, recon accurate):**
- Types/flags: `OrderSide=buy|sell|short|cover`; per-account policy blob in
  `account_strategy_state` (`src/lib/db-profiles.ts:314`) already carries
  `policy.shortSellingEnabled` (`types.ts:956`), `maxShortOrderNotional`
  (`:959`), `maxShortExposurePct` (`:961`), `riskRules.shortStopLossPct`
  (`:600`, default 8 at `defaults.ts:44`).
- Double gate works: `allowedProposalSides` requires policy flag AND
  `account.capabilities.shortSelling` (`strategy-risk.ts:91-94`); LLM schema
  enum restricted (`strategy.ts:3469-3471`); prompt short/cover prose +
  mandatory-stop + directional bracket language exists
  (`strategy-prompts.ts:104-106, 149`).
- `policy.ts` gates verified: opening flag+capability, mandatory stop,
  per-order cap, short-aware headroom, cover-exceeds-shorts, projected
  short-exposure cap, gross/net exposure with correct short sign,
  risk-reducing covers always allowed (`429-431`), covers wash-sale exempt.
- Daily notional handles all 4 sides (`db-execution.ts:64-100` opening=
  buy|short; `:121-167` PDT day-trade pairing). `AGENTS.md`
  "maybe-incomplete" note is stale.
- Synthetic stops support shorts (low-watermark trail, cover exit;
  `synthetic-stops.ts:400-521`) and proactive short exits use
  `shortStopLossPct` (`strategy.ts:4284-4343`).
- Guardrails console UI ALREADY has 4 short fields
  (`app/console/guardrails/field-defs.ts:103-106`) with the `ADVISORY_NOTE`
  convention.

**VERIFIED GAP (exists today): orphaned-short protection.**
`synthetic-stops.ts:426` (`if (isShort && !policy.shortSellingEnabled)
continue;`) plus `strategy.ts:4341` and `:4447` skip risk management of
EXISTING short positions when the opening flag is later toggled off —
contradicts `policy.ts:429-431` (risk-reducing covers always allowed). Toggle
shorting off with an open short → no trailing registration, no proactive
stop-exit proposals for it.

**CAPABILITIES:** `AccountCapabilities` exists (`types.ts:141-180`) with
`shortSelling`, `marginEnabled`, `marginRequirementPct`, `optionsLevel`,
`accountType`; booleans default false by doctrine. Detection: Alpaca
`alpaca.ts:268-278` (`shorting_enabled`; `marginEnabled` HEURISTIC =
`shortSelling || rawAccountType==="MARGIN"` — does not read `multiplier`);
Tradier `tradier.ts:212-234` (`type==="margin"`; correctly denies shorting on
IRA-typed-margin); Robinhood `robinhood.ts:205-223, :751-755`
(`shortSelling` always false — MCP `review_equity_order` prohibits it;
`marginEnabled` from type string).

**LEVERAGE (~0% built):** no leverage/maxLeverage policy field anywhere. BUT
implicit leverage exists TODAY: the only sizing ceiling is broker-reported
`buyingPower` (`policy.ts:545-554`), and on a margin account Alpaca/Tradier
report ~2x equity — the app can already deploy 2x silently. Tradier
`getBalances` conservatively uses overnight margin `stock_buying_power`
min'd with pdt intraday (`tradier.ts:392-441`). `Portfolio` type
(`types.ts:685`) has only `buyingPower`/`cash` — no `maintenanceMargin`,
`shortMarketValue`, `multiplier`, excess liquidity. No margin monitoring:
`scheduler.ts` runs a 60s tick with `runSyntheticStopMonitor` per
(user,account) + re-entrancy guards — the natural hook point.

**BORROW/HTB:** nothing — no shortable/easy_to_borrow enrichment field;
`robinhood.ts:916` explicitly ignores borrow/locate params. `shortFloat`
already reaches the prompt (`strategy-prompts.ts:151`).

**PR archaeology confirmed:** Tradier adapter is ON MAIN (#1380 closed→
re-landed as #1425, merged 2026-07-11); inline broker-truth reconcile on main
(#1382→#1397). Open Tradier P2 debt relevant here: `GET /orders` returns
current-session orders only (prior-session GTC covers invisible to reconcile)
and market-order sizing from delayed closes.

#### Design

**A. Per-account capability model (extend, don't rebuild).**
`AccountCapabilities` + per-(user,account) policy blob already give the exact
"each optional per account per user" shape. Changes:
1. New capability fields (all optional, absent=unknown): `multiplier?: number`
   (broker-reported equity multiplier: Alpaca `account.multiplier` 1/2/4;
   Tradier inferred 2 for margin type; Robinhood undefined),
   `dayTradeBuyingPowerSupported?: boolean`. Fix Alpaca `marginEnabled` to
   derive from `multiplier > 1` (authoritative) with the current heuristic as
   fallback — today a margin-enabled-but-shorting-disabled non-"MARGIN"-labeled
   account can misreport.
2. Capability refresh: capabilities are frozen at connect today. Refresh the
   stored blob opportunistically inside each adapter's existing account/
   balance fetch (no new API calls) so an owner enabling margin/shorting at
   the broker propagates without reconnecting. Store `capabilitiesRefreshedAt`.
3. Broker reality matrix (encoded in adapters, surfaced in UI): Robinhood —
   shorting never (MCP prohibits), margin implicit/not app-controllable →
   treat as no-leverage lane, `capabilities.marginEnabled` display-only;
   Alpaca — shorting via `shorting_enabled`, RegT 2x via `multiplier`, full
   margin telemetry available; Tradier — shorting only on non-IRA margin
   accounts (already correct), balances expose `fed_call`/`maintenance_call`
   directly. Per-symbol shortability is NOT an account capability — it's
   enrichment (see D).

**B. Per-account policy fields** (all NEW fields optional; undefined = exact
status quo):
- `marginTradingEnabled?: boolean` — master leverage opt-in per account.
  Default off.
- `maxLeverageRatio?: number` — cap on projected post-trade gross exposure /
  equity for OPENING sides. Only enforced when `marginTradingEnabled ===
  true`. Owner-adjustable, removable (undefined = broker BP is the only
  ceiling — the status quo).
- `maintenanceBufferPct?: number` — alert when broker-reported excess
  liquidity (equity − maintenance requirement) falls below this % of equity.
  Advisory alert only.
- `marginCallAction?: "notify" | "propose_derisk" | "auto_derisk"` — default
  "notify". `propose_derisk` feeds risk-reducing sell/cover proposals through
  the NORMAL pipeline (policy → red team → approval per authority mode);
  `auto_derisk` is explicit owner opt-in.
- `htbPolicy?: "etb_only" | "allow"` — short-open gate against the enrichment
  `easyToBorrow` flag; default `etb_only` when shorting is on; owner can set
  "allow". Advisory-reject with honest reason string, like every other policy
  gate.

All live in the same per-account policy JSON blob — no schema migration.
Guardrail philosophy preserved: every new gate is an owner preference with an
off-switch (undefined), rejections carry honest reasons, nothing blocks the
owner's own manual actions.

**C. Margin / buying-power engine** (new `src/lib/margin.ts`, pure functions).
Broker-reported buying power stays the single source of truth (existing
`policy.ts:545` stance). The engine adds honesty + projection, never a
parallel ledger:
1. Extend `Portfolio` (all optional): `longMarketValue`, `shortMarketValue`,
   `maintenanceMargin`, `initialMargin`, `excessLiquidity`, `multiplier`,
   `dayTradeBuyingPower`, `brokerCall?: "maintenance"|"fed"`. Alpaca: parse
   from the account endpoint (`long_market_value`, `short_market_value`,
   `maintenance_margin`, `initial_margin`, `sma`, `regt_buying_power`,
   `daytrading_buying_power`, `multiplier`). Tradier: `total_equity`,
   `market_value`, `margin.fed_call`, `margin.maintenance_call`. Robinhood:
   leave undefined. UI shows "-" when absent per repo convention — computed
   values are labeled computed, broker values labeled broker-reported, never
   conflated.
2. Pure math: `leverageRatio(p) = (long + |short|) / equity`;
   `projectedLeverageAfter(p, side, notional)`; `regTInitialEstimate` (50%
   long; short = 150% incl. proceeds); `maintenanceEstimate` (25% long /
   greater of 30%·|short| and $5/share short) — used ONLY for projections and
   labels when the broker doesn't report; broker numbers always win.
3. `policy.ts` additions (opening sides only): when `marginTradingEnabled &&
   maxLeverageRatio` set → reject openings whose projected leverage exceeds
   the cap (reason string includes the numbers). Existing broker-BP check
   remains the floor for everyone. When `marginTradingEnabled` is falsy:
   NOTHING changes — no clamp, no prompt block (zero-behavior-change; see
   ownerDecision #2 for the alternative).
4. Margin monitor (new `src/lib/margin-monitor.ts`, wired into
   `scheduler.ts`'s 60s tick beside `runSyntheticStopMonitor`, same
   per-(user,account) re-entrancy pattern; evaluate every tick but
   rate-limit notifications). Alert ladder via existing `db-notifications`:
   INFO leverage drifted above cap (fills/price moves), WARN excess liquidity
   < `maintenanceBufferPct`, CRITICAL broker-reported call (Tradier
   `maintenance_call`/`fed_call` > 0; Alpaca `maintenance_margin` > equity).
   CRITICAL surfaces even when the feature is disabled (it's real account
   state, not a feature — ownerDecision #8). `marginCallAction` drives what
   happens next; default is notify-only. Everything logged/audited.

**D. Strategy integration (Green proposer + Red team).**
1. Prompt `marginContext` block (emitted ONLY when `marginTradingEnabled`):
   equity, cash, buying power, current leverage, the cap, approximate broker
   margin-interest hurdle (ownerDecision #9), regime guidance ("size beyond
   cash only on high-conviction setups; expected return must clear the
   interest hurdle; prefer delevering in high-VIX/risk-off regimes"). Mirrors
   the existing `shortAllowed` prose pattern (`strategy-prompts.ts:56,
   104-106`) — a `marginAllowed` param on the same interface.
2. Short intelligence: add `shortable` + `easyToBorrow` to enrichment from
   Alpaca's assets endpoint, wired through ALL SIX points of the
   data-providers trap (`SymbolEnrichment`, `EnrichmentSourcedField`,
   `takeScalar`, `EMPTY_SOURCED`, `MarketQuote`/`MarketQuoteSummary`,
   `market.ts` merge). Prompt additions: only propose shorts on shortable
   names; HTB per `htbPolicy`; existing `shortFloat` squeeze guidance (`:151,
   :157`) already covers crowding — extend with "avoid shorting into binary
   events; high shortFloat = crowded short, squeeze fuel".
3. Sizing under margin: prompt states short capacity = min(buying-power-
   derived, `maxShortExposurePct`, leverage-cap projection) and that a short
   consumes ~150% RegT initial; backend policy gates remain the enforcement.
4. Red Team: shorts already flow to the reviewer (`side: "buy"|"short"`,
   `strategy-prompts.ts:174-175`). Add reviewer guidance for short-specific
   failure modes (squeeze, borrow recall, event risk) and for leveraged
   sizing (a levered buy is a bigger claim than the same-notional cash buy).
   `deterministicBearFilter`/`preVeto` rules unchanged — they already see
   short openings.
5. Schema: no new proposal fields required (bracket fields are side-aware
   already). Offline eval: extend `scripts/eval` strategy dataset with short +
   levered scenarios so prompt changes are scored, per the existing
   `STRATEGY_PROMPT_VERSION` discipline (bump it).

**E. Risk surfaces.**
1. FIX the verified orphaned-short gap: manage any existing short position
   regardless of `policy.shortSellingEnabled` — the flag gates OPENING only.
   Change `synthetic-stops.ts:426` to register trailing protection for shorts
   whenever the position exists, and drop/invert the gates at
   `strategy.ts:4341` and `:4447` so proactive cover-exit proposals generate
   for orphaned shorts (they are risk-reducing; policy already always allows
   them). This is a correctness fix under "harden correctness."
2. Short exits: `shortStopLossPct` mandatory-stop regime already enforced;
   covers exempt from wash-sale and daily-notional; cover paths verified
   through `executeProposal` + synthetic stops. Verify Tradier wire sides
   `sell_short`/`buy_to_cover` in the just-landed adapter with explicit tests
   (whole-share-only constraint interacts with cover sizing).
3. Tradier GTC-invisibility interplay (open P2 debt): the synthetic-stop
   coverage check reads open orders; a prior-session GTC cover invisible to
   `GET /orders` could cause a duplicate cover. Margin/short work must
   include a test pinning this and a mitigation (query order by stored id, or
   tag Tradier coverage as unknown → skip re-fire rather than double-place).
4. Leverage drift: the monitor (C4) treats an over-cap state from price moves
   as INFO/WARN + optional `propose_derisk` — never silent auto-liquidation.
5. Daily notional/PDT: already 4-side correct; leverage adds no change
   (opening notional counts, closes exempt). v1 sizes to OVERNIGHT buying
   power always (ownerDecision #6) — the Tradier adapter already does this
   conservatively.

**F. UI (console).**
1. Guardrails page: append to `field-defs.ts` a "Leverage" group next to the
   existing short group — `marginTradingEnabled` (bool, looserWhen on, hint
   "Also requires a margin account at the broker"), `maxLeverageRatio`
   (number, looserWhen up), `maintenanceBufferPct`, `htbPolicy` (enum),
   `marginCallAction` (enum). Reuse `ADVISORY_NOTE`.
2. Account capability badges (`settings/brokers.tsx` already reads
   capabilities): "Shorting available/not offered at this broker", "Margin
   2x", "IRA — cannot short", "Robinhood — shorting not supported". When a
   policy toggle is ON but the broker capability is false, show WHY the
   feature is inert (the double gate made visible).
3. Honest margin display on the account/dashboard surface: broker-reported
   buying power, excess liquidity, maintenance call state; computed leverage
   ratio explicitly labeled computed; "-"/n/a when the broker doesn't report
   — never a fabricated number (repo doctrine). Short positions render with
   negative qty and correct P&L (already handled in `performance.ts`).

**G. Migration / flags — zero behavior change until enabled.**
- Every new policy/capability/Portfolio field is optional; undefined
  reproduces today's behavior bit-for-bit (existing tests must pass untouched
  except where they pin the orphaned-short gap, which is an intentional
  correctness fix).
- No SQL migration for policy/capabilities (JSON blobs). If margin telemetry
  is persisted onto `PortfolioSnapshot`, add nullable columns via `db.ts`
  `migrate()` + CRUD in the owning `db-*` module per the barrel rule; optional
  in v1.
- The prompt gains `marginContext` ONLY when `marginTradingEnabled === true`;
  `allowedProposalSides` logic unchanged; monitor emits nothing for disabled
  accounts except broker-reported calls (per ownerDecision #8).
- Capability-blob additions default false/undefined per the existing "never
  accidentally grant" doctrine (`types.ts:133-135`).

#### Packages (P0–P9)

File-disjoint packages (each = one branch, one PR via `scripts/land.sh`;
lint+tsc+test+build gate; conflicts avoided by landing P0 types first). Order:
P0 → {P1, P6, P7} → P2 → {P4, P5} → P8 → P9.

- **P0** (S) FOUNDATION TYPES+DEFAULTS — files: `src/lib/types.ts`,
  `src/lib/defaults.ts`. Adds ALL new optional fields in one place (policy:
  `marginTradingEnabled`, `maxLeverageRatio`, `maintenanceBufferPct`,
  `marginCallAction`, `htbPolicy`; `AccountCapabilities`: `multiplier`,
  `dayTradeBuyingPowerSupported`, `capabilitiesRefreshedAt`; Portfolio:
  `longMarketValue`/`shortMarketValue`/`maintenanceMargin`/`initialMargin`/
  `excessLiquidity`/`multiplier`/`dayTradeBuyingPower`/`brokerCall`;
  `SymbolEnrichment`/`MarketQuote`/`MarketQuoteSummary`: `shortable`,
  `easyToBorrow` — the union + type side of the six-point trap). Tests:
  defaults unchanged snapshot; tsc across suite; NO behavior tests (nothing
  reads the fields yet). Zero runtime change.
- **P1** (M) BROKER TRUTH — files: `src/lib/alpaca.ts`, `src/lib/tradier.ts`,
  `src/lib/robinhood.ts` (+ `test/broker-capabilities.test.ts` NEW, existing
  adapter tests). Parse Alpaca multiplier→marginEnabled fix + margin
  telemetry into Portfolio; Tradier `fed_call`/`maintenance_call`/
  `short_market_value`; capability refresh-on-fetch with `refreshedAt`;
  Robinhood undefined-honest. Tests REQUIRED: fixture parse per broker incl.
  Alpaca multiplier 1/2/4, Tradier IRA-margin-no-short (pin existing
  behavior), Tradier call fields, Robinhood all-undefined; legacy rows with
  absent fields still parse (booleans false). KEEPOUT: sequence behind the
  Tradier follow-up lane.
- **P2** (M) MARGIN ENGINE + POLICY GATES — files: `src/lib/margin.ts` (NEW),
  `src/lib/policy.ts` (+ `test/margin.test.ts` NEW, test/policy tests). Pure
  RegT math + projections; leverage-cap opening gate; `htbPolicy` gate (reads
  `quote.easyToBorrow` when present, no-ops when absent). Tests REQUIRED:
  leverage math for all four sides incl. mixed long/short books; undefined
  flags = existing policy suite passes byte-identical reasons; cap-reject
  reason strings; cover/sell never blocked by leverage cap; `htbPolicy`
  `etb_only` rejects HTB short & "allow" passes; missing enrichment = no-op.
- **P4** (M) MARGIN MONITOR — files: `src/lib/margin-monitor.ts` (NEW),
  `src/lib/scheduler.ts` (+ `test/margin-monitor.test.ts` NEW). Tick wiring
  beside `runSyntheticStopMonitor` with same re-entrancy/lease pattern; alert
  ladder; notification rate-limit; `marginCallAction` routing (notify +
  propose_derisk in v1; auto_derisk only if ownerDecision #4 says build it).
  Tests REQUIRED: threshold triggers (INFO/WARN/CRITICAL), disabled-account
  emits nothing except broker-reported call, dedup across ticks,
  propose_derisk emits pipeline proposals not orders, temp-SQLite pattern.
- **P5** (L) STRATEGY INTEGRATION + ORPHAN-FIX (strategy side) — files:
  `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`,
  `src/lib/strategy-risk.ts`, `scripts/eval/*` (+ prompt/composition tests,
  `test/run-strategy-offline.test.ts` additions). `marginContext` prompt
  block gated on `marginTradingEnabled`; short borrow/squeeze prose;
  sizing-under-margin guidance; Red Team short/leverage review guidance;
  `STRATEGY_PROMPT_VERSION` bump; FIX `strategy.ts:4341`+`:4447` so proactive
  cover-exits generate for orphaned shorts. Tests REQUIRED: prompt
  contains/omits `marginContext` by flag; `allowedProposalSides` regression
  (double gate unchanged); orphaned-short proactive exit generated with flag
  off; offline eval scenarios for short + levered proposals; eval score
  no-regression. KEEPOUT: `strategy.ts` busy (PR #1371 + attribution sweep) —
  land after.
- **P6** (S) ENRICHMENT SHORTABLE/ETB — files: `src/lib/data-providers.ts`,
  `src/lib/market.ts`. Alpaca assets shortable/easy_to_borrow through
  `takeScalar` + `EMPTY_SOURCED` + merge (types landed in P0). Tests
  REQUIRED: cascade wiring test proving the field reaches `MarketQuote` with
  source attribution; absent-provider yields undefined not false. KEEPOUT:
  `data-providers.ts` busy (FMP quota lane) — land after.
- **P7** (S) ORPHAN-FIX (stops side) — files: `src/lib/synthetic-stops.ts`
  (+ its tests). Change line 426: gate short trailing registration on
  position existence, not `policy.shortSellingEnabled`. Tests REQUIRED:
  flag-off + open short still registers low-watermark trail and fires a
  cover; flag gates only new OPENINGS; Tradier GTC-invisible-cover scenario
  pinned (no duplicate cover when coverage is unknowable). KEEPOUT:
  `synthetic-stops.ts` busy (stop-plans lane) — land after.
- **P8** (M) CONSOLE UI — files: `app/console/guardrails/field-defs.ts`,
  `app/console/settings/brokers.tsx`, dashboard margin-display component (new
  file under `app/console` or existing account panel). Leverage guardrail
  group; capability badges incl. inert-toggle explanation; honest margin
  panel (broker vs computed labeling, "-" for unreported). Tests REQUIRED:
  field-def unit tests (kinds/looserWhen/hints), badge-logic tests for the
  reality matrix (RH never-short, Tradier IRA, Alpaca 2x), display shows "-"
  not 0/fake for missing broker fields.
- **P9** (S) DOCS+ROLLOUT — files: `docs/short-leverage-design.md` (this
  design), `docs/broker-capability-plan.md` addendum, `STATUS.md`,
  EFFORT-LOG mirrors, `docs/rollouts/` note per protocol. No tests.

#### Owner Decisions (lane-level)

1. Default `maxLeverageRatio` when an account turns `marginTradingEnabled` ON
   (recommend 1.5x; brokers allow 2.0x RegT overnight). Owner-adjustable/
   removable afterward.
2. Semantics when `marginTradingEnabled` is OFF/unset on a margin account: (a)
   status quo — broker buying power remains the only ceiling, which ALREADY
   permits ~2x silently today (recommended: zero behavior change, matches the
   stated migration requirement), or (b) clamp openings to ~cash when the
   flag is off (more honest "off means unlevered" but a REAL behavior change
   that could reject trades that pass today). This is the single most
   consequential call in the program.
3. HTB policy default when shorting is enabled: `etb_only` (recommended) vs
   `allow`. Also: Alpaca's API exposes the `easy_to_borrow` boolean but NOT
   borrow fee rates on the standard plan — a `maxBorrowFeePct` tolerance is
   not implementable from free data in v1; accept ETB-flag-only or fund a
   locate-data source.
4. `marginCallAction` ceiling for v1: notify + propose_derisk (recommended),
   or also build auto_derisk (auto-executes covers/sells to restore buffer —
   owner opt-in but real money movement without a human in the loop beyond
   the standing setting).
5. `maintenanceBufferPct` default (recommend 10% of equity).
6. Overnight-vs-intraday leverage: v1 sizes all openings to OVERNIGHT buying
   power (recommended; the 60s scheduler is not an intraday engine and
   Tradier parsing already does this). Alternative: allow daytrade BP
   intraday with forced end-of-day delever — much more machinery.
7. Optional `maxShortHoldDays` advisory (shorts pay borrow over time) —
   include in v1 or skip.
8. Should broker-reported maintenance/fed calls alert even on accounts with
   the margin feature OFF? (Recommend yes — it's real account state, not a
   feature; strictly-no-new-surfaces alternative is honest too.)
9. Margin-interest hurdle in the proposer prompt: annotate approximate
   per-broker rates (needs manual upkeep as rates move) vs a qualitative
   "margin costs interest" line only (recommended).
10. Robinhood: treat as a permanent no-leverage, no-short lane (recommended —
    the MCP transport can't express short/margin intent and prohibits short
    sells) vs surface RH Gold margin as display-only.
11. Whether the orphaned-short protection fix (P5/P7) should land AHEAD of
    the rest as an independent correctness fix — recommend yes, it is a live
    gap today for any account that ever shorts.

#### Risks

1. Keepout collisions: `strategy.ts`, `synthetic-stops.ts`,
   `tradier.ts`/`broker*.ts`, `data-providers.ts` are all under ACTIVE
   in-progress claims by other CLAUDE lanes (PR #1371 stop-plans, attribution
   sweep, Tradier follow-ups, FMP quota). P5/P6/P7/P1 must sequence behind
   those merges or be executed inside the same lane; reserve on the effort
   board first.
2. Implicit-leverage surprise (exists today): margin accounts already trade
   to ~2x broker BP with no cap or disclosure. Until ownerDecision #2 is
   made, the app's "leverage OFF" is not actually unlevered — the design
   makes it honest but the OFF-semantics call gates that.
3. Orphaned-short gap is live NOW (`synthetic-stops.ts:426`,
   `strategy.ts:4341`/`:4447`): any open short loses proactive protection if
   the flag is toggled off. Ship the fix early (ownerDecision #11).
4. Tradier GTC invisibility (open Codex P2 debt): `GET /orders` shows
   current-session orders only — a resting prior-session GTC cover is
   invisible to the synthetic-stop coverage check, risking a DUPLICATE cover
   order on a short. Must be pinned by tests in P7 and mitigated (order-by-id
   lookup or fail-safe skip) before enabling shorts on Tradier.
5. Delayed-close sizing (another open Tradier P2): sizing market orders from
   delayed closes is amplified at 2x leverage and on hard-to-borrow shorts;
   consider requiring fresh quotes for levered/short openings.
6. Broker heterogeneity: Robinhood reports no margin telemetry — every margin
   surface must degrade to "-"/undefined honestly (repo doctrine: never
   fabricate numbers); computed RegT estimates must never be labeled
   broker-reported.
7. Short squeeze/borrow recall risk is not deterministically guardable — per
   owner philosophy it is handled as prompt/Red-Team intelligence + stops,
   not pseudo-math vetoes; residual tail risk is accepted and should be
   stated in docs.
8. Monitor noise: a 60s margin monitor without notification dedup will spam
   WARN during volatile days — rate-limiting is a required test in P4, not a
   nice-to-have.
9. Scheduler load: margin monitor adds broker balance calls per (user,
   account) per tick; piggyback on fetches the tick already performs or run
   at reduced cadence to avoid broker rate limits.
10. Philosophy regression watch: every new gate (leverage cap, `htbPolicy`)
    must ship with its off-switch and honest reason strings; reviewers should
    reject any package that reintroduces hard blocks or are-you-sure
    ceremony (repo's re-paternalization trap).

---

### 6.2 Options Groundwork

#### Current State (verified against main, branch `ag/update-shared-v1.6.0-retry`, clean, post-#1425 merge)

**ALREADY BUILT (reuse, don't rebuild):**
- Capability flags EXIST: `AccountCapabilities.optionsTrading: boolean` +
  `optionsLevel?: 0|1|2|3|4` (`src/lib/types.ts:151-158`, tiers documented:
  1=covered calls/CSPs, 2=long calls/puts, 3=spreads, 4=naked). Populated
  today by Tradier from `account.option_level` (`src/lib/tradier.ts:216-231`)
  and Robinhood MCP (`src/lib/robinhood.ts:198-220`). Alpaca hardcodes
  `optionsTrading: false` (`src/lib/alpaca.ts:275`) even though Alpaca's
  account API reports `options_approved_level`/`options_trading_level` — a
  cheap honest fix.
- Portfolio math already options-aware: `Portfolio.optionMarketValue`
  (`types.ts:690`) is composed into `accountEquity()`
  (`src/lib/risk-breaker.ts:32-34`); Tradier computes NET long−short option
  value with an explicit double-count fix (`tradier.ts:439-449`); Robinhood
  parses it; Alpaca hardcodes 0.
- OCC symbol handling partially exists inline: `tradier.ts:485-498` filters
  OCC option positions out of `getEquityPositions` with regex
  `/\d{6}[CP]\d{8}$/` (21-char OCC, e.g. `DELL140118C00015000`) — the single
  source of OCC knowledge in the repo, currently uncentralized.
- Chain-derived IV plumbing exists: `src/lib/robinhood-options.ts`
  (env-gated `ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED`, 6h TTL, per-user token,
  fail-closed) feeds `MarketQuote.nearTheMoneyIv` + `putCallRatio` through
  the full enrichment cascade (`data-providers.ts` `takeScalar` sites,
  `market.ts` merge, `types.ts` `SourcedField` union), and `strategy.ts:3909`
  already injects `iv: quote.nearTheMoneyIv` into the LLM candidate context.
- The gating template is proven: short-selling double gate
  (`policy.shortSellingEnabled && capabilities.shortSelling`) at
  `policy.ts:432-455` with mandatory-stop semantics, per-order notional cap,
  risk-reducing-exits-always-allowed rule (`policy.ts:429-431`), LLM schema
  side restriction (`strategy.ts:3469-3471` via `strategy-risk.ts:91-94`
  `allowedProposalSides`), 4-side daily-notional tracking
  (`db-execution.ts:65-72`).
- Scheduler substrate ready: `src/lib/scheduler.ts` 60s single-leader tick
  already runs synthetic-stops, stale-limit alerts, broker health, fill
  reconcile; a `due_jobs` table exists in `db.ts` `migrate()`;
  broker-truth-first reconcile landed (#1397, `f25e485e`).

**NOT BUILT (the actual gaps):** `BrokerGateway` is equities-only BY DESIGN
(`types.ts:1855-1877`; `broker-capability-plan.md` §2 calls it a deliberate
scope boundary); no `OptionContract` type; no `positionIntent`/`legs` on
`TradeProposal`/`EquityOrderInput`; `fill_events` + `calculatePnl`
(`src/lib/performance.ts:435`) have no multiplier/asset-class concept — an
option fill recorded today would be silently mis-booked as 100× too small; no
expiry/assignment lifecycle; no options chain provider cascade
(`robinhood-options.ts` is single-source, signal-extraction only, not a
chain API).

#### Design

Minimal-but-complete options substrate, mirroring the proven short-selling
program shape (capability flag + policy opt-in double gate, sides restricted
at LLM schema, mandatory-risk semantics, everything dormant until two
switches flip).

**(1) INSTRUMENT MODEL** — new `src/lib/options-symbols.ts` (pure lib). Types
in `types.ts`: `OptionRight = "call"|"put"`; `OptionContract { underlying:
string /* canonical hyphenated, via normalizeSymbol */; expiry: string /*
YYYY-MM-DD */; strike: number; right: OptionRight; multiplier: number /* 100;
non-standard rejected in v1 */ }`. Functions: `toOccSymbol(c)` /
`parseOccSymbol(s)` (compact OSI: ROOT + YYMMDD + C/P + 8-digit strike×1000;
strict round-trip property tests), `isOccSymbol(s)` (centralizes
`tradier.ts:497`'s inline regex, tradier.ts imports it, single source of
truth), `occRootForUnderlying(sym)` (share-class edge: canonical BRK-B ↔ OCC
root BRKB — must be symmetric with `fromTradierSymbol`/`toAlpacaSymbol`
conventions in `money.ts`). v1 REJECTS adjusted/non-standard contracts
(digit-suffixed roots like AAPL1, multiplier≠100) with an honest
`OrderValidationError` — never silently mis-multiply.

**(2) ORDER MODEL** — single-leg first, legs future-proofed. `types.ts`:
`PositionIntent = "buy_to_open"|"sell_to_close"|"sell_to_open"|"buy_to_close"`
(BTO/STC/STO/BTC — maps 1:1 onto Tradier's native option sides). Add OPTIONAL
fields to `TradeProposal` + `EquityOrderInput`: `assetClass?:
"equity"|"option"` (absent = equity — optional so ZERO existing constructors/
test fixtures change; deliberately avoids the `TradeProposal`-non-optional-
field trap in CLAUDE.md), `optionContract?: OptionContract`, `positionIntent?:
PositionIntent`, `legs?: OptionLeg[]` where `OptionLeg { contract;
positionIntent; ratioQty: number }` — v1 validation rejects `legs.length>1` so
spreads later are a data-shape non-event, not a migration. Canonical
intent↔side mapping (`intentToOrderSide`: BTO→buy, STC→sell, STO→short,
BTC→cover) so every downstream consumer that switches on the 4-value
`OrderSide` (policy exposure signs, db-execution daily-notional, performance
lot matching, Red Team risk-adding-opening classifier) keeps working without
a 5th case. `validateOptionOrderInput()`: integer contracts ≥1, no
`dollarAmount` sizing, future expiry, contract↔occ consistency; market orders
on options are ADVISORY-warned not blocked (owner philosophy: guardrails are
preferences), but the strategist prompt later mandates limits priced off
chain mid (addresses the #1380 delayed-close-sizing debt, which is worse for
options spreads).

**(3) DATA PLUMBING** — new `src/lib/options-data.ts`: `OptionChainProvider`
interface (`getExpirations`, `getChain(underlying, expiry) →
OptionQuote[]`) + a small cascade mirroring `CascadingEnrichmentProvider`'s
first-non-null + `logApiHealth` pattern (new service names so the admin
connections page sees it). `OptionQuote { contract; bid?; ask?; last?;
volume?; openInterest?; iv?; greeks?: {delta,gamma,theta,vega,rho};
underlyingPrice?; asOf; provider }` — missing greeks stay undefined, never
fabricated (repo rule). Provider truth: TRADIER — first-class: `GET
/v1/markets/options/expirations` + `/chains?greeks=true` returns full
greeks+IV (ORATS-supplied, ~hourly refresh) on the SAME single bearer token
already integrated; sandbox includes options with delayed data. ALPACA —
options market data at `/v1beta1/options` (snapshots include greeks+IV); free
"indicative" feed vs paid OPRA subscription for real-time — defer the spend
decision. YAHOO — free options endpoint (`query2 .../v7/finance/options/
{symbol}?date=...`) gives per-contract IV/OI/volume/bid/ask but NO greeks;
reuse the existing crumb machinery (`data-providers.ts:1833`) as the keyless
floor, mirroring the equity-cascade philosophy. ROBINHOOD MCP —
`get_option_chains` exists (`broker-capability-plan.md` §4) but poll-only;
keep `robinhood-options.ts` as-is and optionally re-point it to the cascade
later. NOTE: all three external API shapes stated from research/training
knowledge — re-verify against current docs at implementation time
(`broker-capability-plan.md`'s own caveat).

**(4) BROKER SURFACE + CAPABILITY FLAGS** — extend `BrokerGateway` with
OPTIONAL methods (precedent: `ordersListIncludesTerminal?`), so all existing
gateways compile untouched and absent-method = unsupported = fail closed:
`getOptionPositions?`, `getOptionOrders?`, `reviewOptionOrder?`,
`placeOptionOrder?(input & {refId})`, `cancelOptionOrder?`. New
`OptionPosition { contract; quantity /* signed; negative = short */;
averageCost /* per-share premium */; marketValue }` and `OptionOrderInput {
accountNumber; contract; positionIntent; quantity; type; limitPrice?;
timeInForce; refId }`. Tradier implementation: `class=option,
option_symbol=toOccSymbol, side=positionIntent verbatim, duration=day|gtc`;
positions parsed via `parseOccSymbol` (the rows `getEquityPositions` already
filters OUT become `getOptionPositions`' input — zero new API calls). Alpaca
capability fix ships here too: parse `options_approved_level`/
`options_trading_level` into capabilities (replacing the hardcoded false) —
read-only honesty, no Alpaca order path yet. `optionsLevel` semantics
(already documented at `types.ts:151-158`) become load-bearing: intents
permitted = level≥1 → STO-covered (CC/CSP), level≥2 → BTO/STC, level≥3 →
multi-leg (future), level 4 → naked STO (no integrated broker offers it;
always reject).

**(5) POSITION/P&L + LIFECYCLE** — `fill_events` gains nullable columns via
the ALTER-if-missing migrate pattern (`db.ts`): `asset_class`, `occ_symbol`,
`underlying`, `expiry`, `strike`, `right`, `multiplier`, `position_intent`;
CRUD in `db-fills.ts`. `calculatePnl` (`performance.ts`): options lots keyed
by `occ_symbol` (never merged with underlying's equity lots); P&L = (exit −
entry premium) × qty × multiplier, sign by intent (STO opens a credit lot;
BTC closes it); existing equity paths byte-identical when the new columns
are null. Expiry/assignment/exercise are SCHEDULER concerns riding the
existing 60s tick + `due_jobs`: (a) expiry sweep — T+1 after expiry, resolve
any still-open option lot from broker truth (positions gone + Tradier/Alpaca
account-activity records): expired-worthless → synthetic closing fill at 0;
(b) assignment/exercise → paired synthetic fills (option closed at
0/intrinsic + equity fill at strike, qty×multiplier) so the equity book and
the option book both stay true, with audit events + new
`NotificationEventTypes` "option_expiry"/"option_assignment"; (c) T−N
pre-expiry close: `policy.optionsCloseBeforeExpiryDays` (default 1) generates
close proposals through the NORMAL authority flow (decide executes, propose
queues a card) — advisory default, owner-adjustable, per the guardrails
philosophy.

**(6) RISK HOOKS** — `policy.ts` gate cloned from the short template
(`432-455`): opening intents (BTO/STO) require
`policy.optionsTradingEnabled === true && capabilities.optionsTrading ===
true` AND the intent permitted by `optionsLevel`; closing intents (STC/BTC)
ALWAYS allowed even if options were since disabled (mirror of
`policy.ts:429-431` — never trap exposure). STO additionally requires
coverage — shares ≥ qty×multiplier (covered call) or cash ≥
strike×qty×multiplier (CSP) — computed from the broker positions/portfolio,
else reject (this IS the level-1 definition, and it's also the correctness
boundary: we never model margin ourselves; short-option margin beyond
covered/CSP is broker math, fail closed). Stop semantics: long options are
DEFINED-RISK — max loss = premium paid — so StopPlan "none" on a long option
is auto-annotated "defined-risk: max loss = premium" and needs no rationale;
premium-based synthetic stop (`stopLossPct` applied to option MARK vs entry
premium, using the O4 quote cascade) is the optional tighter stop, monitored
by the synthetic-stops loop (broker-held stops on options deliberately NOT
used in v1 — illiquid stop triggers on wide spreads); short options
(covered/CSP) inherit the mandatory-stop-or-explicit-plan rule from shorts.
Buying-power effect: long debit counts full premium notional against
`maxOrderNotional`/`maxDailyNotional` (`db-execution` opening test extends to
`side==buy||short||intent BTO/STO` via the O2 mapping); STO counts assignment
notional (strike×qty×multiplier) toward symbol/gross exposure caps keyed to
the UNDERLYING so an option position can't dodge the underlying's
concentration cap; new `policy.optionsMaxOrderNotional?` +
`policy.optionsMaxExposurePct?` mirror the short caps. Wash-sale v1: option
fills EXCLUDED from the lockout computation with an honest annotation
(substantially-identical analysis deferred; owner default is disregard
anyway).

**(7) LLM SEAMS ONLY (explicitly NOT building the strategy):** (a)
`strategy-risk.ts:91-94`'s `allowedProposalSides` gains a parallel
`allowedOptionIntents` computed under the same double gate — empty today, so
the JSON schema/prompt never mention options until flags flip (exact mirror
of `strategy.ts:3469-3471`); (b) proposal schema gains the O2 optional
fields, exposed only when `allowedOptionIntents` is non-empty; (c)
`strategy-prompts.ts` gets a conditional options section stub (renders
nothing when disabled); (d) a typed `optionsContext` slot in the
candidate-context builder next to the existing `iv:` injection at
`strategy.ts:3909` — shape defined (near-the-money chain summary: ATM IV,
expected move, top-OI strikes), value stays undefined in v1; (e) Red Team
coverage is FREE: it runs on every risk-adding opening and the intent→side
mapping makes BTO/STO classify as openings — add one regression test
asserting that, don't build anything; (f) counterfactual/outcome plumbing
untouched (`occ_symbol` on fills is enough for later scorecards). Out of
scope, named to stay out: spread construction, IV-rank/term-structure
analytics, options eval datasets, an options screener.

#### Packages (O1–O7)

Six packages, strictly sequenced so each lands green (lint+tsc+test+build)
and DORMANT — nothing user-visible or behavior-changing until
`policy.optionsTradingEnabled` (default off) AND broker
`capabilities.optionsTrading` are both true, and no package flips either.

- **O1** — instrument model (S, small-tier mechanical + strong tests):
  `options-symbols.ts` (`OptionContract`, `toOccSymbol`/`parseOccSymbol`/
  `isOccSymbol`/`occRootForUnderlying`, round-trip + rejection tests),
  `types.ts` additions, `tradier.ts` imports `isOccSymbol` replacing its
  inline regex (behavior-identical refactor, covered by existing tests). No
  dependencies. Dormant: pure lib.
- **O2** — order model + intent mapping (M, mid-tier): optional
  `TradeProposal`/`EquityOrderInput` fields, `PositionIntent`,
  `intentToOrderSide`, `validateOptionOrderInput`, `legs[]` with >1 rejected.
  Depends on O1. Dormant: no producer sets `assetClass="option"`.
- **O3** — broker surface: gateway methods + Tradier impl + Alpaca
  `optionsLevel` parsing (M/L, mid-tier with frontier-tier review on the
  placement path): optional `BrokerGateway` methods, Tradier
  chains/expirations/positions/place/cancel/review, Alpaca capability
  honesty fix. Depends on O1+O2. Parallelizable with O4. Dormant: methods
  exist, nothing calls them in prod paths; verify against Tradier SANDBOX
  before merge (sandbox has options; note the #1380 GTC-visibility debt
  applies).
- **O4** — data plumbing: chain/greeks/IV cascade (M, mid-tier):
  `options-data.ts`, `OptionQuote`, Tradier→Alpaca→Yahoo cascade with
  `logApiHealth` + TTL cache (6h precedent), optional admin probe route.
  Depends on O1 only. Parallelizable with O3. Dormant: no production caller.
- **O5** — policy + risk gates (M, FRONTIER-tier — money-path-subtle): the
  double gate, intent-by-`optionsLevel`, STO coverage requirement,
  closes-always-allowed, premium-stop semantics, exposure caps keyed to
  underlying, `db-execution` daily-notional extension, new policy fields +
  `defaults.ts` + settings UI toggle group cloned from the short-selling
  settings work. Depends on O2+O3 types; COORDINATE with workstream 4 (same
  files: `policy.ts`, `strategy-risk.ts`, `types.ts` policy block). Dormant:
  default off; exhaustive fixture tests both sides of every gate.
- **O6** — P&L accounting + lifecycle scheduler (M/L, FRONTIER-tier verify —
  sign/multiplier arithmetic is the subtlest money path): `fill_events`
  columns, `db-fills` CRUD, `calculatePnl` option lots, expiry sweep +
  assignment/exercise synthetic fills + T−N close proposals on the scheduler
  tick, new notification event types. Depends on O2+O3+O5. Dormant: every
  sweep no-ops with zero option fills; equity paths proven byte-identical by
  the existing 723-test suite.
- **O7** — LLM seams (S, mid-tier): `allowedOptionIntents`, conditional
  schema/prompt stubs, `optionsContext` typed slot, Red-Team-covers-options
  regression test. Depends on O5. Dormant: intents list empty until flags
  flip. After O7, "turning options on" is purely: owner flips the settings
  toggle on an account whose broker reports `optionsTrading` — no further
  code.

Order: O1 → O2 → (O3 ∥ O4) → O5 → O6 → O7. Per fleet model economics: O1/O7
small-to-mid tier, O2/O3/O4 mid tier, O5/O6 frontier-tier design/verify
(adversarial-verify caught real money-path bugs green tests missed in this
program before — repeat that on O5/O6).

#### Owner Decisions (lane-level)

1. WHICH BROKER FIRST — recommend TRADIER, with confidence: (a) its option
   order sides ARE the BTO/STC/STO/BTC model verbatim (no mapping
   ambiguity); (b) chains+greeks+IV (ORATS) come on the same single bearer
   token already integrated in `src/lib/tradier.ts` — no new credential or
   vendor; (c) free sandbox INCLUDES options paper trading (Alpaca paper
   does too, but Robinhood has no paper at all); (d) multileg order class
   exists for the spreads future; (e) the OCC position filter already in
   `tradier.ts` means half the read path is pre-paved. Alpaca is the clear
   #2 (capability parsing ships in O3 regardless; its mleg support and
   options snapshots are good, but real-time options data needs a paid OPRA
   subscription — the free indicative feed may be fine, owner call on spend
   when it matters). Robinhood MCP last: single-leg only, poll-only,
   live-money-only. Owner input needed: confirm the Tradier account's actual
   approval level (sandbox for dev, but production level caps what ships
   live) and whether Alpaca should get an order path at all in this program
   or stay read-only.
2. OPTIONS-LEVEL GATING SEMANTICS — decide between (a) strict: app attempts
   only what broker-reported `optionsLevel` permits, fail-closed when
   undefined (recommended default), vs (b) owner-overridable: a
   `policy.optionsLevelOverride` knob per the "guardrails are adjustable
   preferences" philosophy — override only widens what the app ATTEMPTS;
   the broker still enforces its own approval at placement, so this is
   honesty-preserving. Recommendation: ship (a) in O5, add (b) only if the
   owner hits a real false-negative (e.g. broker reports level stale after
   an upgrade).
3. PRE-EXPIRY AUTO-CLOSE DEFAULT — recommend ON at T−1 day through the
   normal authority flow (decide-mode executes the close, propose-mode
   queues a card). Owner may prefer OFF (let ITM options exercise into
   stock deliberately). This is a `defaults.ts` one-liner either way.
4. DATA SPEND — Alpaca OPRA real-time options feed subscription: defer;
   revisit only if Tradier's ORATS-hourly greeks prove too stale for the
   strategy layer (they won't for swing horizons).

#### Risks

1. P&L SIGN/MULTIPLIER ARITHMETIC (O6) is the highest-subtlety money path:
   credit-open lots (STO) interacting with the existing 4-side FIFO matcher
   in `performance.ts:435` — a sign error overstates or understates realized
   P&L silently and feeds the learning loop bad outcomes. Mitigate:
   frontier-tier adversarial verify, property tests (open+close at same
   premium ⇒ exactly $0 across all 4 intents × long/short), and keep option
   lots keyed by `occ_symbol` so they can never cross-match equity lots.
2. WORKSTREAM COLLISION: O5/O7 touch `policy.ts`, `strategy-risk.ts`, and
   the `types.ts` policy block — the same files workstream 4 (short/
   leverage) is actively editing. `land.sh`'s same-files-touched refusal
   will fire; sequence O5 after workstream 4's policy PRs merge, or claim
   the fileset on the effort board first.
3. OCC EDGE CASES: share-class roots (BRK-B → BRKB), digit-suffixed adjusted
   roots (AAPL1, multiplier≠100), 5-6 char roots. v1 policy is REJECT
   non-standard loudly, but `occRootForUnderlying` symmetry with `money.ts`
   conversions must be tested against real Tradier sandbox chains, not just
   fixtures.
4. STALE-QUOTE SIZING: the open #1380 Codex debt ("don't size market orders
   from delayed closes") is amplified for options (wide spreads, delayed
   sandbox data). v1 mitigation: strategist mandate for limit orders at
   chain mid; do not treat a Yahoo/delayed chain quote as executable.
5. BROKER-TRUTH GAPS: Tradier `GET /orders` returns current-session orders
   only (open #1380 thread) — the O6 expiry/assignment sweeps must lean on
   positions + account activities, never the orders list, or reconcile will
   hallucinate "never placed".
6. EXTERNAL API DRIFT: Tradier/Alpaca/Yahoo options endpoint shapes stated
   from research; `broker-capability-plan.md`'s own rule applies —
   re-verify against live docs/sandbox at implementation time before
   trusting field names.
7. WASH-SALE HONESTY: excluding options from the lockout is a documented v1
   simplification, not a claim of correctness — annotate it in the tax
   settings help text so the owner knows options trades don't feed the
   wash-sale guard.
8. SCOPE CREEP GUARD: O7 defines seams only; if a package starts
   implementing IV-rank analytics or spread builders, it has left the
   groundwork mandate — park it and note it in the rollout doc.

---

### 6.3 Kalshi

#### Current State

Repo: zero Kalshi references anywhere in `src/` or `docs/` (grepped
case-insensitive) — greenfield. Relevant verified architecture: (1)
`src/lib/market-signals/` is a directory of keyless, failure-tolerant
market-wide signal fetchers (`cboe.ts`, `cftc.ts`, `famafrench.ts`,
`massive.ts`) merged by `index.ts` into a flat `MarketSignals` bundle, cached
1h success-only, consumed by `dashboard.ts:478` and `strategy.ts:561/3225`,
and injected into the LLM prompt at `strategy.ts:3328` with reading guidance
in `strategy-prompts.ts:156` — this is the exact template for Kalshi data.
(2) Macro/regime pipeline: `macro.ts` `fetchMacroData` (24h cache,
blank-never-fabricated convention) -> `determineMarketRegime`/
`classifyMarketRegime` (`market-regime.ts`, deterministic) ->
`entryMarketRegime` stamped on every proposal (`types.ts:1104`) and
regime-conditioned learning (`regimeOutcomes`/`comboOutcomes` in prompts).
(3) Broker layer: `BrokerGateway` is an equity-shaped 9-method interface
(`types.ts:1855-1877`); registry in `broker.ts` `resolveGateway` keyed on
`policy.activeBroker` union `"alpaca"|"alpaca-mcp"|"robinhood"|"test"|
"tradier"` (`types.ts:950`) and `ConnectedAccount.broker` (`types.ts:652`,
comment explicitly invites new venues); `AccountCapabilities`
(`types.ts:141`) has per-venue booleans (`shortSelling`, `optionsTrading`,
`futuresTrading`, `cryptoTrading`) but no event-contracts flag yet;
`environment "paper"|"live"` drives `execution-mode.ts`; Tradier adapter
(`src/lib/tradier.ts`, merged via PR #1425 on 2026-07-11 — recon evidence
spot-verified) is the current best hand-rolled-REST adapter template,
including its "base URL derived from environment so tokens can never cross"
pattern. (4) `ConnectedAccount` stores `apiKey`/`apiSecret` (encrypted at
rest post-IDOR hardening) — sufficient for Kalshi key-id + RSA PEM. (5)
`OrderSide = buy|sell|short|cover` with all four sides live through
policy/execution (short/leverage recon confirms).

Kalshi API (verified against docs.kalshi.com 2026-07-12): prod REST
`https://external-api.kalshi.com/trade-api/v2`, prod WS
`wss://external-api-ws.kalshi.com/trade-api/ws/v2`, demo REST
`https://external-api.demo.kalshi.co/trade-api/v2` (credentials NOT shared
between envs); auth = API Key ID + RSA-PSS/SHA-256 signature (salt = digest
length) over `timestamp_ms + METHOD + path-without-query`, headers
`KALSHI-ACCESS-KEY` / `KALSHI-ACCESS-TIMESTAMP` / `KALSHI-ACCESS-SIGNATURE`
— Node `crypto.sign` with `RSA_PKCS1_PSS_PADDING` handles this, no SDK
needed. Market-data reads (`GET /markets`, `/events`, `/series`, orderbook,
trades) are PUBLIC — no auth, no account, no KYC needed for the data
package. Rate limits: token buckets, most requests cost 10 tokens; Basic
tier (automatic at signup) = 200 read/100 write tokens/sec (~20 read / ~10
write req/s) — ample. IMPORTANT API-churn finding: Kalshi is mid-migration
to a v2 order API (`POST /portfolio/events/orders`) that replaced the legacy
`action=buy/sell` + `side=yes/no` + integer-cents shape with `side=bid|ask`
(YES-leg perspective), fixed-point dollar strings (up to 6dp), fractional
contract counts (0-2dp), subaccounts 0-63, TIF
`fill_or_kill|good_till_canceled|immediate_or_cancel`, optional
`expiration_time` (GTT), `post_only`, `reduce_only`,
`cancel_order_on_pause`, order groups, and `client_order_id` for idempotency;
legacy `/portfolio/orders` "will be deprecated no earlier than May 6, 2026"
(already past) — build v2 only; most third-party guides still document the
legacy shapes. Positions: `GET /portfolio/positions`, `position_fp` signed
(negative = NO contracts, positive = YES) — maps cleanly onto long/short
quantity semantics. Limit orders only in v2 (market orders emulated as
marketable IOC limits). Trading hours: nearly 24/7 with a scheduled
maintenance window Thursdays 3:00-5:00 AM ET; per-market `close_time`
varies; `GET /exchange/schedule` + `/exchange/status` are queryable. Fees
(schedule effective 2026-07-07): taker = `0.07 x C x (1-C)` per contract
rounded up (max 1.75c at 50c), maker = 25% of taker, no settlement fee.
Regulatory: CFTC-regulated Designated Contract Market with its own
clearinghouse; US persons OK (18+, KYC with government ID, non-PO-box US
address); customer funds in segregated accounts at qualified US banks (CFTC
customer-funds regime, not SIPC). Kalshi also has a separate Perps (margin
perpetual futures) API — explicitly out of scope here.

#### Design

TWO-SURFACE DESIGN — data as regime evidence first, trading as a
flag-gated broker adapter second.

**(1) DATA INTEGRATION — "eventMarkets" as macro/regime evidence for the LLM
strategist.**

Fit question answered: Kalshi does NOT belong in the
`SymbolEnrichment`/`data-providers.ts` cascade. That cascade is per-equity-
symbol (price/PE/sector per ticker); Kalshi carries market-level
probabilities about macro events, not attributes of equity symbols, and
Kalshi's single-name company markets are too sparse to enrich a scan
universe. Forcing it into `CascadingEnrichmentProvider` would touch the
6-place per-field wiring trap for zero benefit. The correct home is the
market-signals surface, which exists precisely for "market-wide
regime/sentiment signals from free, no-key sources."

Design: new module `src/lib/market-signals/kalshi.ts` exporting
`fetchKalshiEventSignals(): Promise<KalshiEventSignals | undefined>`. Public
REST only (no keys, no account): `GET {base}/markets?series_ticker=X&status=
open` (public, paginated, prices as fixed-point dollar strings — see
Feasibility Corrections below re: integer cents). A small config table of
curated series (owner-tunable constant): Fed decision / rate path,
CPI/inflation, NBER recession, GDP, payrolls/jobless, government shutdown /
debt ceiling, and broad index year-end/range markets; elections category
behind an owner toggle. For each series: pick the near/most-liquid open
markets, compute `impliedProb = mid(yes_bid, yes_ask)` (fall back to
`last_price` when the book is empty), and carry `title`, `closeTime`,
`volume24h`, `openInterest` as liquidity/confidence context. Output shape
(structured, not flat scalars): `{ asOf, categories: Array<{ category,
series, markets: Array<{ ticker, title, impliedProb, closeTime, volume24h,
openInterest }> }> }` plus a few derived headline scalars the prompt can
lean on (e.g. `fedCutProbNextMeeting`, `recessionProbThisYear`). Wire-up:
merge as a separate top-level prompt block `eventMarkets` next to
`marketSignals` at `strategy.ts:~3328` (do NOT flatten into `MarketSignals`
— different cadence and richer shape), with one guidance line in
`strategy-prompts.ts:~156` telling the strategist to read these as
real-money-implied probabilities for regime/risk posture (e.g. rising
recession prob + widening HY spread = de-risk; Fed-cut repricing =
duration/growth tilt) and to weight by liquidity (open interest), never as
single-name triggers. Caching: module-local 15-30 min success-only TTL
(event probs move faster than the 1h Cboe/CFTC bundle) following the
`massive.ts` pattern — kept out of `index.ts`'s 1h base cache; failure drops
the block entirely (repo rule: never fabricate, never label synthetic data
as real). Deliberately NOT wired into `determineMarketRegime`/
`classifyMarketRegime`: the deterministic regime classifier stays on
measured macro data; Kalshi is advisory LLM evidence (consistent with the
owner's "guardrails advisory / no pseudo-math" ruling). Telemetry via
`recordProviderCall` like other providers. Optional follow-up: a console
dashboard tile (`dashboard.ts` `getMarketSignals` pattern + `con-*`
composite) and a regime-watch hook — both separable. WebSocket explicitly
deferred: REST polling inside the TTL is sufficient at signal cadence.

**(2) TRADING SKETCH — Kalshi as a sixth BrokerGateway, flag-gated,
demo-env-first-capable.**

Account model: add "kalshi" to `ConnectedAccount.broker` and
`policy.activeBroker` unions; `ConnectedAccount.apiKey` = Kalshi API Key ID,
`apiSecret` = RSA private key PEM (already encrypted at rest); environment
maps beautifully — "paper" = demo env (`external-api.demo.kalshi.co`),
"live" = prod, with the base URL DERIVED from environment exactly like
Tradier so credentials can never cross (demo keys 401 against prod and vice
versa, failing closed). Add `AccountCapabilities.eventContracts: boolean`
(Kalshi true, all equity brokers false) and `accountType "event_exchange"`
(or reuse `crypto_exchange` precedent — new value is cleaner). Kalshi has
one account per member with optional subaccounts 0-63 (see corrections: 1-63
are institution-gated); v1 uses subaccount 0 as `accountNumber`.

OrderSide mapping (the elegant part): a binary contract is a $0/$1-settling
instrument quoted 0.01-0.99, and Kalshi v2 collapsed yes/no into one
YES-denominated book where buying NO == selling YES. So the existing
four-sided `OrderSide` maps exactly: `buy` -> side "bid" (open YES exposure);
`sell` -> side "ask" + `reduce_only=true` (close YES); `short` -> side "ask"
(open NO exposure); `cover` -> side "bid" + `reduce_only=true` (close NO).
Kalshi's position sign convention (positive = YES, negative = NO) matches
the app's long/short quantity semantics one-for-one, so
`getEquityPositions` maps `position_fp` directly to signed quantity.
`reduce_only` makes sell/cover structurally risk-reducing — aligned with
existing policy exemptions for closes. *(Note: this is the design lane's
proposed mapping, produced before the K2-pre design memo the program plan
requires — see Feasibility Corrections below: the feasibility pass flags
Kalshi's actual `action` buy/sell × `side` yes/no order model as not fully
reconciled with this OrderSide mapping in the source text, and treats it as
a genuinely open design question that K2-pre must resolve before any
gateway code.)*

Gateway method mapping: `getAccounts` -> `GET /portfolio/balance` (+ static
capabilities); `getPortfolio` -> balance + sum of position market values
(cash = balance; binaries are cash-only, no margin, buyingPower = cash);
`getEquityPositions` -> `GET /portfolio/positions`
(`market_exposure_dollars`/`total_traded_dollars` for cost basis);
`getEquityOrders` -> `GET /orders` (set `ordersListIncludesTerminal` per
verified terminal-inclusion behavior, conservative false until proven);
`getEquityQuotes` -> `GET /markets?tickers=...` (bid=yes_bid, ask=yes_ask,
price=last/mid); `getEquityTradability` -> market `status === "open"`;
`reviewEquityOrder` -> synthesized locally (no native review endpoint):
balance check + fee estimate via the taker formula; `placeEquityOrder` ->
`POST /portfolio/events/orders` with `client_order_id = refId` (native
idempotency — plugs straight into the broker-truth placement-reconcile
machinery from #1397); `cancelEquityOrder` -> `DELETE
/portfolio/events/orders/{order_id}`. OrderType: "limit" native; "market"
emulated as immediate_or_cancel limit at a marketable price (cross the book
with a small buffer) since v2 is limit-only; `stop_market`/`stop_limit` NOT
SUPPORTED and must be rejected at review — protective stops are the wrong
tool for binaries (a probability-priced instrument near resolution will
always gap through a stop); risk is bounded by construction (max loss =
premium paid), so the risk model is defined-risk sizing, not stops.
`synthetic-stops.ts` and `broker-protective-stops.ts` must explicitly skip
kalshi accounts. TimeInForce: `gtc` -> `good_till_canceled`, `gfd` ->
`good_till_canceled` + `expiration_time` at next midnight ET (GTT);
optionally set `cancel_order_on_pause=true` on resting orders. Prices/counts
are fixed-point dollar STRINGS with tick 0.01 — money handling must format
exactly, never floats. *(See corrections: default market-data fields are
integer cents, not dollar strings — the dollar-string fields are a parallel
representation available on request.)*

Pipeline honesty — where the equity abstraction genuinely strains, and the
answer is a separate sleeve, not forced reuse: (a) DISCOVERY: the
strategist's universe is equity scans; Kalshi markets need their own
discovery — reuse the K1 data feed as the candidate list for an "event
sleeve" prompt section that may propose event-contract trades only when a
kalshi account is connected + `policy.eventContractsEnabled` (double gate,
mirroring the shortSelling pattern at `strategy-risk.ts:91`). (b) NAMESPACE:
Kalshi tickers (e.g. `KXFEDDECISION-26SEP`) must never collide with equity
symbols in fills/performance/policy — namespace proposals/positions as
instrument-tagged (`proposal.instrument = "event_contract"` or a `KALSHI:`
symbol prefix; decide once, early — this is the highest-regret-if-wrong
choice). (c) POLICY: notional caps, daily-notional tracking, and
account-boundary rules apply unchanged; wash-sale, sector concentration,
beta/ATR stops are meaningless for binaries and must no-op for the event
sleeve; add `maxEventOrderNotional` + `maxEventExposureNotional`
(owner-adjustable, advisory-default per the guardrails ruling). (d)
SETTLEMENT: contracts expire to $0/$1 with no closing fill — positions
vanish; reconcile via `GET /portfolio/settlements` (and fills endpoint) into
the fills/performance ledger as synthetic closing events at settlement
price, tagged so P&L attribution and the learning loop (thesis/regime
outcomes) still work. (e) FEES: `execution-cost.ts` needs the parabolic
per-contract taker fee (`0.07 x C x (1-C)`, maker 25%) or realized-P&L
attribution is silently wrong. (f) HOURS: `market-hours.ts` equity gating
must not block a ~24/7 venue; the gateway consults `GET /exchange/schedule`
+ `/exchange/status` instead. Regulatory notes: CFTC-regulated DCM +
clearinghouse, US persons explicitly OK (this is the app's owner-operated
account model — no advice being given), KYC required to fund, segregated
customer funds at qualified US banks (not SIPC). Tax reporting differs from
equities (exchange-issued forms) — surface honestly in UI copy, no tax logic
in v1.

#### Packages

- **K1** — Kalshi event-market data as strategist evidence (S/M, LOW RISK,
  ship first). No keys, no account, public endpoints, failure-tolerant, zero
  money-path contact. Files: `src/lib/market-signals/kalshi.ts` (new
  fetcher + curated series config + 15-30min success-only cache),
  `src/lib/market-signals/index.ts` or `strategy.ts:~3225/3328` (fetch +
  inject `eventMarkets` prompt block — keep out of the 1h base cache),
  `strategy-prompts.ts:~156` (one guidance line),
  `test/market-signals-kalshi.test.ts` (mocked-fetch shape/pruning/cache
  tests). One mid-tier agent, ~1-2 days including verify gates. Immediate
  LLM value: real-money-implied Fed/CPI/recession/shutdown probabilities as
  regime evidence. **K1b** (optional, separable, S): console dashboard tile
  via the `con-*` composite recipe.
- **K2** — Kalshi trading (L, FLAG-GATED, staged in three PRs,
  demo-env-capable from day one). **K2a**: gateway + connect (M/L) —
  `src/lib/kalshi.ts` (RSA-PSS signer, v2 order/position/balance mapping,
  env-derived base URL), `types.ts` unions + `AccountCapabilities
  .eventContracts`, `broker.ts` registry, `execution-mode.ts` `brokerLabel`,
  connect-account UI + key entry (PEM via secret-file handoff, never chat),
  demo-env integration verify; **K2b**: policy + event sleeve (M) —
  `eventContractsEnabled` double gate, `maxEventOrderNotional`/
  `maxEventExposureNotional`, no-op wash-sale/sector/stops for the sleeve,
  synthetic-stops/protective-stops skip, strategist event-sleeve prompt
  section fed by K1 data, instrument namespace decision implemented;
  **K2c**: settlement + P&L (M) — `/portfolio/settlements` reconciliation
  into fills/performance, fee model in `execution-cost.ts`, learning-loop
  tagging. Frontier-tier review on K2b/K2c money paths (per fleet model
  economics); adversarial-verify against the demo env before any live
  enablement. Sequencing: K1 -> owner reviews prompt value -> K2a/b/c. eToro
  and options workstreams are unaffected; coordinate the `types.ts` union
  edits with the short/leverage lane to avoid the known merge trap.

#### Owner Decisions (lane-level)

1. Demo vs live first for trading (K2): recommendation is to CONNECT DEMO
   FIRST purely as integration verification (Kalshi's demo is a separate
   signup with separate credentials; it maps to `environment="paper"` — "an
   account is an account," not a safe-home-base ritual), then live at the
   owner's discretion with lose-it-all funds; if the owner prefers
   straight-to-live, nothing in the design blocks it — the live preflight
   guard (`ALLOW_LIVE_TRADING`) already gates real placement.
2. Which event categories feed the strategist (K1 config): proposed default
   = Fed/rates, inflation (CPI/PCE), recession/GDP, labor, government
   shutdown/debt-ceiling, broad index range markets; elections/politics =
   owner toggle (high signal for regime but noisy/crowded); sports/
   culture/weather = excluded by default (mission drift) unless the owner
   wants them.
3. Instrument namespace choice in K2 (`KALSHI:` symbol prefix vs a
   first-class `proposal.instrument` field) — instrument field is cleaner
   and options/futures workstreams will want it too; needs one early owner/
   architect call because it touches proposal/fill/performance schemas.
4. Whether Kalshi trading gets its own exposure budget (recommended: yes,
   `maxEventExposureNotional`, advisory-default).
5. K1b dashboard tile now or after K1 proves prompt value.
6. Rate-limit tier: Basic suffices for both packages; only if a future
   WS/orderbook strategy emerges would the Advanced upgrade call matter.

#### Risks

1. API churn (MEDIUM, the big one): Kalshi is actively migrating REST to the
   v2 events-orders surface (legacy deprecation floor of 2026-05-06 already
   passed; docs carry parallel legacy/cents and v2/dollar-string shapes;
   most third-party guides describe the legacy API). Mitigation: build
   v2-only, integration-test against demo, pin exact endpoint paths in one
   client module. Spot-check the create-order schema again at
   implementation time.
2. Symbol collision (HIGH if skipped, cheap to prevent): Kalshi tickers
   entering equity-shaped fills/performance/policy without a namespace would
   corrupt P&L and learning data — the namespace decision must land in
   K2a/K2b before any order is placed.
3. No stops on binaries: synthetic/protective stop engines must explicitly
   skip event positions or they will thrash cancel/replace against a venue
   with no stop orders; defined-risk sizing replaces stops.
4. Fee-model omission: without the parabolic taker fee in
   `execution-cost.ts`, realized P&L attribution is silently wrong (max
   1.75c/contract sounds small but is 3.5% round-trip at 50c).
5. Settlement accounting: positions vanish at $0/$1 with no closing fill; if
   K2c ships late, the ledger shows ghost positions — sequence K2c with (or
   immediately after) K2b, and the #1397 broker-truth reconcile gives a
   proven pattern.
6. Data-quality honesty: thin books make mid-price "probabilities" noisy —
   carry `openInterest`/`volume` alongside every prob and instruct the LLM
   to weight by liquidity; never backfill a missing book with `last_price`
   older than the market session.
7. Maintenance window (Thu 03:00-05:00 ET) + market pauses: resting GTC
   orders survive; use `cancel_order_on_pause` where appropriate and treat
   5xx/schedule-closed as expected states, not incidents.
8. Regulatory drift: CFTC posture around some categories (esp. sports) is
   litigated and state-contested; data use is unaffected, trading category
   exposure is the owner's accepted risk — no paternalistic blocks, just
   honest labeling.
9. Coordination: `types.ts`/policy union edits overlap the short/leverage
   and options lanes (known merge-conflict trap) — reserve the effort-board
   row and sequence union changes through one lane.
10. Demo-env fidelity: demo books are thin/unrealistic; treat demo as
    plumbing verification only, never as strategy evidence.

---

### 6.4 eToro

#### Current State

No eToro code exists anywhere in the repo. Broker registry is a 5-value
union `"alpaca" | "alpaca-mcp" | "robinhood" | "test" | "tradier"` appearing
at: `src/lib/types.ts:652` (`ConnectedAccount.broker`) and `:950`
(`TradingPolicy.activeBroker`); `src/lib/broker.ts:9-28` (`resolveGateway` —
the single gateway factory, already wrapped by the live-preflight Proxy
chokepoint at `broker.ts:48-75` so ANY new gateway inherits the
`ALLOW_LIVE_TRADING` guard for free); `src/lib/db-api-keys.ts:607/651/677`
(row casts) and `:160` (service-key map); `src/lib/execution-mode.ts:115`
(display name); `src/lib/strategy.ts:2771` (broker label);
`src/lib/dashboard.ts:142`; `app/api/connected-accounts/route.ts:39` +
`:96-122` (connect route with per-broker env validation — the Tradier
branch is the exact template: env-scoped credentials, explicit paper/live
selector, write-time base-URL/env cross-check); UI surface
`app/console/settings/brokers.tsx` (+ `lib.ts`, `help.tsx`,
`settings-search.ts`, `chrome.tsx`). Reference adapter: `src/lib/tradier.ts`
(808 lines, hand-rolled REST, no SDK, `capsFromProfile` false-by-default
capabilities at `:210-223`, shared broker-agnostic helpers
`fillMissingQuotesWithClose`/`estimateReviewNotional` re-exported from
`./alpaca`). Gateway contract: `src/lib/types.ts:1855-1877`
(`BrokerGateway`, incl. the `ordersListIncludesTerminal` money-path flag at
`:1867`), `EquityOrderInput` `:1823-1853`, `ExecutedOrder` `:1814`,
`EquityPosition` `:694`, `EquityOrder` `:703`, `Portfolio` `:685`,
`AccountCapabilities` `:141-180`. `OrderSide` already carries short/cover;
`OrderType = market|limit|stop_market|stop_limit`; `TimeInForce =
gfd|gtc`. Protective-stop machinery (`synthetic-stops.ts`,
`broker-protective-stops.ts`) is currently claimed by another in-flight lane
per the keepout board — coordinate before PR3 touches it.

#### Feasibility Verdict — YES, WITH ONE HONEST CAVEAT

eToro launched a real, public, documented trading API on 2025-10-29 (press
release). It is NOT partner/invite-only in the docs: key issuance is
self-serve in the product (Settings > Trading > API Key Management,
SMS-verified), free ("Access to the eToro API is free for eligible users"),
with full public docs, a real OpenAPI spec (v1.296.0; the design's original
"132-path" count is unverified — see Feasibility Corrections below), real-
money order execution, cancellation, position SL/TP management, and a
complete demo (paper) mirror. THE CAVEAT: eToro's own marketing page still
said "Currently available to select users in early access" as of this
research, the FAQ hedges with "eligible users," and NO official source
anywhere states whether eToro USA accounts (separate FINRA-regulated entity;
the owner is US-based) see the API Key Management section. The docs' line
"If the API key isn't showing in your settings, please finish the
verification process" implies some accounts don't see it. So: the API is
real and the adapter is fully designable today with high confidence (schemas
verified from the spec, not vendor blurbs), but access for THIS owner is
unverified until a 5-minute Day-0 probe. Do NOT use the reverse-engineered
community APIs — ToS-hostile, credential-unsafe, brittle; rejected.

**API FACTS** (verified against the downloaded OpenAPI spec + doc pages, not
summaries): Base `https://public-api.etoro.com`. Auth = 3 headers on every
call: `x-request-id` (UUID, doubles as idempotency/reference key),
`x-api-key`, `x-user-key`. Keys have Read/Write scopes and are
ENVIRONMENT-SCOPED (separate Demo vs Real keys — same pattern as Tradier's
env-scoped tokens). Rate limits: trading ops 20 req/60s SHARED across ~9
endpoints; info 60/60s shared; market data — see corrections below (the
design's separate "120/60s" figure is unverified); 429 + `Retry-After`. Core
endpoints: `POST /api/v2/trading/execution/orders` (unified create; demo
twin `/api/v2/trading/execution/demo/orders`) — body `{action: open|close,
transaction: buy|sell|sellShort|buyToCover, symbol XOR instrumentId, amount
XOR units XOR contracts, orderType: mkt|mit (+triggerRate), leverage
(required for open; 1 = real unleveraged asset), stopLossRate,
stopLossType: fixed|trailing, takeProfitRate, positionIds[] (for close),
orderCurrency}` → `{token, orderId, referenceId (echoes x-request-id)}`;
`DELETE /api/v2/trading/execution/orders/{orderId}` (cancel — see
corrections: unverified in public docs); `GET
/api/v2/trading/info/orders:lookup?orderId=|referenceId=` (status ids:
1=Executed, 2=Cancelled, 3=Rejected, + `errorCode`/`errorMessage` — lookup
BY OUR OWN `x-request-id` is a gift for placement reconcile — see
corrections: unverified); `GET /api/v1/trading/info/real/pnl` (credit=cash,
unrealizedPnL, `positions[]` `{positionID, instrumentID, units, openRate,
leverage, isBuy, amount, stopLossRate, takeProfitRate, isTslEnabled,
fees...}`, `ordersForOpen[]`, `ordersForClose[]`); `PATCH
/api/v2/trading/positions/{positionId}` `{stopLossRate, takeProfitRate,
stopLossType fixed|trailing, clearStopLoss, clearTakeProfit}` —
position-attached protective stops (see corrections: unverified in public
docs); `POST /api/v2/trading/info/eligibility` (≤100 symbols → per-
instrument `minPositionExposure`, `maxUnitsPerOrder`,
`allowOpenPosition`/`ClosePosition`/`PartialClose`, `allowMitOrders`,
`allowEntryOrders`/`ExitOrders` (market-closed resting),
`allowTrailingStopLoss`, `unitsQuantityType whole|fractional`,
`requiresW8Ben`) (see corrections: unverified); `POST
/api/v2/trading/info/costs` (what-if cost breakdown for a hypothetical
order) (see corrections: unverified); `GET
/api/v1/market-data/instruments/rates?instrumentIds=` (bid/ask/
lastExecution — instrument IDs required, so a symbol→instrumentId cache via
`GET /api/v1/market-data/search` + `/instruments` is mandatory); `GET
/api/v1/trading/info/trade/history`; `GET /api/v1/balances`; candles + WebSocket
streaming exist (later phase). Asset semantics: `GetOrderInfoAsset
.settlementType ∈ {cfd, real, realFutures, marginTrade}` — leverage>1 and
`sellShort` are CFD mechanics, which eToro USA does NOT offer; a US account
is long-only real stocks/ETFs/crypto at leverage=1. Market-orders guide
confirms the KEY MODEL DIFFERENCE: eToro is POSITION-BASED — "You cannot
simply 'sell' the instrument; you must close the specific line item in your
portfolio." **Close-position flow correction (see Feasibility Corrections
below): the officially documented v1 endpoint is `POST
/api/v1/trading/execution/market-close-orders/positions/{positionId}` (body:
`InstrumentId`, optional `UnitsToDeduct`), not the v2 unified
`action:"close"`+`positionIds[]` shape assumed in the adapter design draft
below — until portal access confirms otherwise, treat the v1 per-position
endpoint as authoritative.**

#### Design

ADAPTER DESIGN (`src/lib/etoro.ts`, ~800-900 lines mirroring `tradier.ts`;
hand-rolled REST, no SDK): `getEToroGateway(userId, connectedAccountId)` →
`EToroBrokerGateway implements BrokerGateway`.

(1) AUTH/CUSTODY: `ConnectedAccount {broker:"etoro", apiKey=x-api-key,
apiSecret=x-user-key, environment: "paper"(Demo key)|"live"(Real key)}` —
encrypted at rest via existing `db-api-keys` path; connect route branch
modeled on the Tradier branch: environment is an EXPLICIT selector, both
keys required, Write scope required for trading (Read-only keys connect as
view-only and must fail closed at `placeEquityOrder`), and a connect-time
probe `GET /trading/info/{demo/}pnl` verifies the key matches the selected
environment so a demo key can never masquerade as live (env-scoped keys
make crossing impossible at the venue too — same fail-closed property
Tradier has). `x-request-id`: pass our `refId` when UUID-shaped, else
UUIDv5(refId) — deterministic so retries stay idempotent; persist the sent
value for `orders:lookup` reconcile.

(2) READS: `getAccounts` → balances + profile, capabilities via
`capsFromEligibility` false-by-default discipline (`equityTrading:true`;
`shortSelling:false, marginEnabled:false, optionsTrading:false,
futuresTrading:false, cryptoTrading:false` in v1 — US entity has no CFDs,
and crypto is deferred; `accountType:"brokerage"`); `getPortfolio` → pnl
(cash=credit, buyingPower=credit, totalMarketValue=credit+Σ(position
amount+pnl)); `getEquityPositions` → AGGREGATE position line items per
symbol (Σunits, weighted averageCost from openRate, marketValue via rates)
while caching the per-symbol→[positionID,units,openRate...] line-item map
for closes; `getEquityOrders` → pnl `ordersForOpen`/`ordersForClose` mapped
to `EquityOrder` (live-only list ⇒ leave `ordersListIncludesTerminal`
UNSET — conservative per `types.ts:1856-1866`; follow-up: teach
`reconcilePlacementError` an optional by-referenceId lookup hook, which
eToro's docs describe but which needs portal verification per corrections);
`getEquityQuotes` → rates via the instrument-ID cache (bid/ask/
lastExecution; no volume — enrichment cascade covers it);
`getEquityTradability` → eligibility endpoint, tradable=allowOpenPosition,
fractional=(unitsQuantityType==="fractional").

(3) WRITES: `placeEquityOrder` buy → `{action:open, transaction:buy,
leverage:1, amount:dollarAmount or units:quantity, stopLossRate:
bracketStopLoss, takeProfitRate:bracketTakeProfit}` — bracket legs ride
natively on the open order (position-attached SL/TP), which is BETTER than
synthetic stops; sell → close by symbol: resolve line items via the
documented v1 per-position close endpoint (see corrections), full close =
one close call per position, partial = close-by-units against line items
largest-first, honoring `allowPartialClosePosition` and
`minPositionExposure` remainder rules; short/cover → REJECT at
`reviewEquityOrder` with a structured `preflightBlock` (US entity, no CFDs)
and capabilities already gate proposals upstream (strategy-risk.ts
double-gate); type mapping: market→mkt; limit→mit ONLY when `triggerRate` is
on the valid side ("trigger price must be better than the current price" —
buy-limit below market maps cleanly; a marketable limit does NOT map and
must be rejected with a clear `preflightBlock`, never silently degraded to
market — guardrails are owner preferences, so a policy toggle "degrade
marketable limits to market" can be added later, default off);
`stop_market`/`stop_limit` ENTRY orders → reject (no venue equivalent);
`timeInForce`: venue has no TIF — resting MIT ≈ GTC; a `gfd` input is
annotated as not-enforceable in `ReviewedOrder.alerts` (advisory, per the
no-paternalism philosophy) rather than blocked; marketHours: no
extended-hours at eToro — annotate and proceed regular-hours; `trailPercent`
→ FAIL CLOSED (eToro's trailing SL is `isTslEnabled` trailing a fixed
distance, NOT a settable percent — exactly the Robinhood precedent in
`types.ts:1846-1851`, so the reconciler emulates by ratcheting);
`cancelEquityOrder` → cancel then confirm terminal (mirror Tradier's
cancel-is-a-request handling at `tradier.ts:700-729`; exact cancel endpoint
path needs portal verification per corrections).

(4) PROTECTIVE STOPS: v1 rides the native position-attached SL set at open +
a PATCH-style ratchet for updates (mirroring `broker-protective-stops`'
"replace stop" — exact PATCH endpoint needs portal verification per
corrections) — potentially atomically better than order-based brokers if
confirmed; coordinate with the in-flight stop-plans lane before wiring.

(5) RATE-LIMIT DISCIPLINE: per-gateway token bucket (trading 20/60s, info
60/60s), 429/`Retry-After` backoff, and a short-TTL pnl cache since
`getPortfolio`/`getEquityPositions`/`getEquityOrders` all hit the same
endpoint — one fetch per strategy tick, not three.

(6) SYMBOLS: US tickers are plain (AAPL); create-order accepts symbol
directly; reads are instrumentId-keyed so the cache is the single
translation point; `normalizeSymbol` for share-class punctuation as with
Tradier. Demo environment = full endpoint mirror under `/demo/` paths with
Demo keys → maps 1:1 onto `environment:"paper"` with zero fake-fill code,
consistent with the no-test-mode philosophy.

#### Packages (PR0–PR3)

NPM PACKAGES: none — zero new dependencies. eToro is plain REST + 3 headers;
repo convention (`tradier.ts`, `alpaca.ts`) is hand-rolled fetch, no SDK, and
no signing/HMAC library is needed (no request signing, just header keys).
eToro's official MCP server and community SDKs exist but are not wanted for
a server-side gateway.

WORK PACKAGES (PR slicing, all gated on the Day-0 probe):
- **PR0** (owner, ~5 min, no code): eligibility probe — log into eToro (or
  open an account first — account creation is owner-only), check Settings >
  Trading > API Key Management, create a DEMO Read+Write key pair, run a
  curl smoke (`GET /api/v1/trading/info/demo/pnl` with the 3 headers). If
  the section is absent: join the waitlist, park the lane.
- **PR1** — registry + read-only gateway (~1-1.5 days, mid-tier model): add
  "etoro" to both unions (`types.ts:652,950`), `broker.ts` `resolveGateway`,
  `execution-mode.ts:115`, `strategy.ts:2771`, `dashboard.ts:142`,
  `db-api-keys.ts` casts, connected-accounts route branch (env selector +
  connect-time env probe + Write-scope detection), `src/lib/etoro.ts` with
  `getAccounts`/`getPortfolio`/`getEquityPositions`/`getEquityOrders`/
  `getEquityQuotes`/`getEquityTradability` + instrument-ID cache + rate
  limiter, `test/etoro.test.ts` with recorded fixtures (mirror
  `test/tradier.test.ts`).
- **PR2** — execution (~1-2 days, frontier-tier review — money path):
  `placeEquityOrder` open/close mapping incl. per-position close ledger and
  partial-close allocation, `reviewEquityOrder` via costs+eligibility with
  structured `preflightBlock`s (marketable-limit, short-on-US, trailPercent,
  sub-minimum), cancel+confirm, `orders:lookup` reconcile by referenceId,
  idempotent `x-request-id` derivation. Adversarial-verify the
  close-allocation math (the Tradier program showed green tests miss
  money-path bugs).
- **PR3** — protective stops + UI (~1 day): PATCH-based stop ratchet
  integration (coordinate with the active stop-plans keepout), console
  settings broker card (`brokers.tsx` + `lib.ts` + `help.tsx` +
  `settings-search.ts`), docs (`docs/etoro-broker.md` + rollout note).
  Later/optional: WebSocket streaming quotes, crypto capability,
  by-referenceId hook in `reconcilePlacementError`.

*(Note: this design lane's own package doc uses PR0–PR3 naming; the
program-level package roll-up in §4 above renames the code packages
ET1–ET3 with the same PR0 probe as the shared blocking gate — both refer to
the same underlying work, sourced verbatim from the two workflow sections.)*

#### Owner Decisions (lane-level)

1. DAY-0 PROBE (blocking): Does the owner have an eToro account, and does
   Settings > Trading > API Key Management appear in it? Agents must not
   create the account or accept eToro's terms — owner action. If absent →
   waitlist and park.
2. SCOPE: is eToro wanted primarily for US stocks/ETFs (overlaps
   Alpaca/Tradier) or for its differentiators (crypto via the same API,
   social/copy-trading data)? v1 design is equities-only, long-only,
   leverage=1; crypto flip is a small follow-up if wanted.
3. MARKETABLE-LIMIT POLICY: eToro has no true limit order (mkt +
   market-if-touched only, trigger must be on the passive side); default
   design rejects marketable limits with a `preflightBlock`; owner may
   prefer an opt-in "degrade to market" toggle (adjustable-preference
   template).
4. PRIORITY: this lane is behind Tradier follow-ups/options/Kalshi in the
   capability program — owner to sequence.
5. LIVE KEYS: when/if going live, owner generates the Real-environment Write
   key themselves and hands it over via the chmod-600 secret-handoff
   protocol; remind that eToro keys support IP whitelisting + expiry —
   recommend setting both.

#### Risks

1. ELIGIBILITY/COHORT RISK (the big one): "eligible users" is undefined; the
   marketing page still says early-access even though the API portal reads
   as GA self-serve; US-entity availability is stated NOWHERE official —
   the owner's account may simply not show key issuance. Mitigation: Day-0
   probe before any code; everything else in the design is unblocked-once-
   keys-exist.
2. US capability ceiling: no shorting, no leverage, no extended hours, no
   options via this API for a US account — eToro adds breadth (crypto,
   social data), not capability depth, vs Alpaca/Tradier; worth stating so
   expectations match.
3. Rate limits are TIGHT (trading 20/60s shared; info 60/60s shared): a busy
   strategy tick plus protective-stop reconcile plus UI polling can 429 —
   the shared pnl cache + token bucket are load-bearing, not nice-to-have.
4. Position-close allocation is new money-path math (line items, partial
   closes, min-exposure remainders, whole-vs-fractional per instrument) with
   no precedent in the repo — highest-risk code in PR2; adversarial
   verification required.
5. No true limit/stop entry orders and no TIF: strategy entries that rely on
   limit protection lose it here unless the reject-vs-degrade policy is
   settled; `gfd` cannot be enforced venue-side.
6. `ordersListIncludesTerminal` stays unset ⇒ placement-reconcile is
   conservative (uncertain instead of not_placed) until the by-referenceId
   lookup hook is built and portal-verified.
7. API churn: spec is v1.296.0 with v1 endpoints already deprecated in favor
   of v2 for SOME surfaces; pin to whichever surface portal access confirms
   per-endpoint (see corrections — several endpoints' v1-vs-v2 status is
   unverified) and record the spec version in the adapter header.
8. Demo≠live microstructure: demo fills are simulated; treat demo results as
   plumbing verification only.
9. Docs/site flakiness observed during research (FAQ 404s, block-pages
   exist) — keep recorded fixtures in tests, never live-hit eToro in CI.
10. Coordination: `broker.ts`/`broker-protective-stops.ts`/
    `synthetic-stops.ts` carry active keepout claims from the
    Tradier/stop-plans lanes — reserve on the effort board and sequence PR3
    after that lane lands.

---

## 7. Feasibility Verification — Adversarial Corrections

Two design lanes (Kalshi, eToro) went through an adversarial feasibility
pass against live documentation. Both verdicts: **partial** — core
integration facts hold, but each has real corrections. These corrections are
already folded into §6.3/§6.4 above where they bite; this section restates
them together for visibility since a package that skips them will ship a bug.

### Kalshi — verdict: partial

**Confirmed correct:** RSA-PSS auth model (3 headers, timestamp+method+path
signed payload, salt=digest length); demo environment mirrors prod exactly
with fully separate credentials (401s cross-environment); base URLs
(`external-api.kalshi.com`/`external-api.demo.kalshi.co`, both under
`/trade-api/v2`); `GET /markets?series_ticker=X&status=open` is real,
public, unauthenticated, paginated; WebSocket channel names are real (though
deferred); rate limits (Basic tier 200 read/100 write tokens/sec, 10
tokens/request default) are real and ample for a 15-30min poll cadence;
subaccounts numbered 0-63 exist.

**Corrections needed:**
1. **Price representation** — the design says market data comes as
   "fixed-point dollar strings." That's only half right: the default/
   primary fields are integer cents (`yes_bid`, `yes_ask`, `last_price`,
   ints 1-99); dollar-string variants (`yes_bid_dollars`, `yes_ask_dollars`,
   `last_price_dollars`, e.g. "0.5600") exist as separate parallel fields,
   not the default representation. `impliedProb = mid(yes_bid, yes_ask)`
   still works fine either way, but the field-typing assumption should be
   corrected before implementation (cents-as-int by default).
2. **Subaccounts are not simply "optional" for any member** — per Kalshi's
   own docs, subaccounts 1-63 are "currently only available to institutions
   and market makers" and are an API-only feature not yet exposed in the
   web/mobile app. A retail member's default account already IS subaccount
   0, so "v1 uses subaccount 0" works regardless and needs no gated
   feature — but the framing "one account per member with optional
   subaccounts 0-63" overstates general availability.
3. **Production trading (not demo) requires completed KYC** (legal name,
   DOB, address, SSN, gov ID) before an API key can even be generated — not
   mentioned as an explicit onboarding prerequisite in the original design,
   only implicitly via environment mapping. Worth stating explicitly since
   it affects flag-gated rollout sequencing.
4. **Order-side semantics — a genuinely open design question, not a
   hallucination.** Kalshi orders are NOT stock-style buy/sell/short/cover:
   `POST /portfolio/orders` (legacy) / the v2 events-orders surface takes
   `action` ("buy"/"sell") crossed with `side` ("yes"/"no") on a binary
   event contract, plus `time_in_force`, `post_only`, `reduce_only`,
   `buy_max_cost`, `expiration_ts`, `client_order_id`. Mapping this cleanly
   onto the app's existing `"buy"|"sell"|"short"|"cover"` `OrderSide` union
   is a real design problem that the K2-pre package (§4, §3 Wave 0) exists
   specifically to resolve before any gateway code is written — flag it as
   an open gap, not a false claim.
5. Base-URL description should include the full path segment: demo REST
   base is `https://external-api.demo.kalshi.co/trade-api/v2` (omitting
   `/trade-api/v2` understates the path).

No hallucinated endpoints, no invented auth mechanism, no fabricated
environment found — the foundational integration facts (RSA-PSS, demo env,
public REST markets endpoint, WS channel names, rate limits, subaccount
numbering) all check out against current docs.kalshi.com.

### eToro — verdict: partial

**Confirmed correct:** the API is real, public, launched 2025-10-29,
self-serve key issuance (Settings > Trading > API Key Management,
SMS-verified), free for eligible users, environment-scoped Demo/Real keys,
3-header auth (`x-request-id`/`x-api-key`/`x-user-key`), core order-creation
endpoint (`POST /api/v2/trading/execution/orders` + demo twin), the
account-info/pnl endpoint, and the fundamental position-based (not
share-based) trading model.

**Corrections needed:**
1. **Reframe the caveat as blocking, not a footnote:** eToro's own
   2025-10-29 press release — not just the marketing page — says the API is
   "available to select users" with broader rollout "planned in the coming
   months." The Day-0 probe (PR0) is a blocking prerequisite before scoping
   further adapter work, not an optional footnote.
2. **Drop or re-verify the "120 req/60s" market-data rate-limit figure** —
   available evidence puts market-data reads in the same 60/60s tier as
   portfolio/info reads, not a separate higher tier.
3. **Rewrite the close-position flow** to match the officially documented v1
   endpoint `POST /api/v1/trading/execution/market-close-orders/positions/
   {positionId}` (body: `InstrumentId`, optional `UnitsToDeduct`) instead of
   claiming `action:"close"`+`positionIds[]` on the unified v2 `/orders`
   endpoint, unless/until direct portal access confirms a v2 unified-close
   variant also exists.
4. **Mark as unverified (not confirmed) until a logged-in portal session
   check:** `DELETE .../orders/{orderId}` cancel endpoint, `GET
   .../orders:lookup` (colon-syntax) endpoint and its status-code enum,
   `PATCH /api/v2/trading/positions/{positionId}` for SL/TP edits, `POST
   /api/v2/trading/info/eligibility`, `POST /api/v2/trading/info/costs`.
   None were found in any public documentation, blog post, or third-party
   client reference despite targeted searches.
5. **Change "132-path OpenAPI spec, verified by downloading"** to "a real
   OpenAPI spec (version v1.296.0) exists and is fetchable when
   authenticated/browser-rendered; exact path count unverified — third-party
   sources cite 60+ or 146+ endpoints, neither matching 132." Don't present
   132 as a verified fact.
6. **Soften "implies some accounts don't see it"** — the cited doc line is
   about identity/KYC verification completion, not a stated US-eligibility
   gate. Label the US-specific-access theory as a hypothesis, not a
   documented fact.
7. **Add to the Day-0 probe checklist:** confirm whether
   `builders.etoro.com/app-registration` represents a second,
   approval-gated tier (beyond the self-serve personal API key) that could
   apply to third-party "integrations" as opposed to personal use — this
   page 404'd during research and could not be checked.

---

## 8. Cross-Cutting Coordination Notes

- **Auto-deploy consequence:** merge to `main` == live in production
  immediately (Coolify auto-deploy, since 2026-07-10). Every package in this
  program must be dormant by construction (optional fields, default-off
  flags) — no package may flip its own capability on. The owner enables per
  account in the UI once a package train completes.
- **Box build serialization:** `concurrent_builds=1` on the Hetzner box.
  Space `main` merges hours apart, never burst multiple capability-program
  PRs back to back.
- **`types.ts` / `strategy.ts` never concurrent:** both files are touched by
  multiple lanes (SL-P0/O1/O2 on types; F1/K1/SL-P5 on strategy). Land one
  package touching either file at a time; rebase the next.
- **Active keepouts as of 2026-07-12** (reserve on the effort board before
  touching): `ios/SocraticTrade/**` (AG, native rebuild), the notification
  system (CODEX), `strategy.ts` (CLAUDE, PR #1371 stop-plans + attribution
  sweep), `broker-protective-stops.ts` (CLAUDE), `synthetic-stops.ts`
  (CLAUDE), `data-providers.ts` (CLAUDE, FMP quota PR), `tradier.ts`
  (CLAUDE, adapter live-token validation pending).
- **Model-tier discipline:** every package above carries a size/tier tag
  (S/M/L, H/S/F) per the fleet's standing model-economics rule — Haiku for
  mechanical work, Sonnet as the default implementer, Frontier reserved for
  design-heavy or money-path-subtle work and for adversarial verification on
  every money-touching package. This practice already caught real bugs in
  the Tradier program that green tests missed.
- **Owner-only actions that block code:** the eToro Day-0 probe (PR0) and
  the Tradier live-token validation session are both owner-gated
  prerequisites for downstream packages; escalate them early (Wave 0) since
  everything behind them stalls otherwise.
- **Memory-board correction (follow-up, not part of this doc's edits):**
  the owner's Claude memory index (`capability-trading-program.md`) and the
  branch-neutral live board (`/Users/jay/apps/TRADING-EFFORT-LOG.md:236,
  :1331, :1636`) both currently carry the same false iOS overclaims
  corrected in `STATUS.md`/`docs/EFFORT-LOG.md` by this landing, plus the
  PR #1389 mislabel (FMP quota metering, not a capability foundation PR).
  Those files are outside this repo/branch and are actively touched by a
  concurrent AG lane; correcting them is flagged here for the owner/next
  session rather than edited directly in this PR to avoid clobbering
  concurrent live-board writes.
