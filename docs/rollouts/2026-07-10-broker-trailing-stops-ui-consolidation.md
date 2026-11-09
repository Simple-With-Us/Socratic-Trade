# 2026-07-10 — Broker-held trailing stops (Alpaca native + Robinhood ratcheted) + Guardrails stop consolidation

Agent: CLAUDE (cloud session, branch `claude/stop-loss-preset-options-f1jygn`)

## Summary

Owner-directed, three asks in one session:

1. **Trailing stops are now broker-held on both brokers** (owner: "ensure that robinhood and
   alpaca have trailing stop loss working since they both have that feature now").
   - **Alpaca (paper + live):** TRUE native `trailing_stop` orders. New
     `EquityOrderInput.trailPercent`; the Alpaca gateway translates it to
     `type: "trailing_stop"` + `trail_percent`, drops any `stopPrice` (Alpaca rejects price
     params on trailing stops), requires whole shares, and refuses trailing+bracket combos.
     The MCP lane is bypassed for trailing (REST direct) — no guessing at unverified MCP arg
     schemas.
   - **Robinhood (live only):** the RH MCP exposes **no verified native trailing parameter**, so
     rather than silently sending unverified args, the protective-stop reconciler emulates the
     trail with verified primitives: a resting GTC `stop_market` at `trailingStopPct` below the
     high-water mark, RATCHETED upward (cancel-replace) each scheduler tick as price rises
     (churn-guarded: replaces only on a ≥ $0.02 and ≥ 0.1% move; never ratchets down). Between
     ticks the broker holds a real stop, so protection survives app downtime. `toMcpOrder` now
     throws on `trailPercent` (fail closed, like short/cover) with a pointer to the ratchet lane.
     Gated on the existing `robinhoodBrokerStops` opt-in (the "resting stops at RH are
     live-verified" switch) — one flag continues to govern all RH resting stops.
   - New policy flag **`brokerTrailingStops` (default ON, inert until
     `riskRules.trailingStopPct` > 0** — which still defaults to 0/off). Off-switch per the
     "preferences, not cages" philosophy. Validated in the policy route.
   - `broker_protective_stops` table: new `kind` (`fixed`|`trailing`) + `trail_percent` columns
     (migration 16; pre-existing rows are RH fixed stops → `'fixed'` default is correct).
     Kind changes are detected as mismatches (cancel-then-replace, still guarded by
     `liveReplaceBlocked` so a position is never left stopless).
   - **Placement is now coverage-aware:** the synthetic monitor passes its pre-reconcile order
     list into `reconcileBrokerProtectiveStops`, which skips a position already fully covered by
     another live exit-side order (an Alpaca OCO bracket stop leg, a manual GTC sell) instead of
     provoking a broker rejection every tick. Orders cancelled by the same reconcile are pruned
     from the coverage source first. `isLiveExitOrder`/`liveExitOrderCoverage` moved from
     `synthetic-stops.ts` to `broker-side.ts` (shared, no import cycle; semantics unchanged).
   - Long positions only (Robinhood is long-only; Alpaca shorts keep synthetic trailing coverage —
     broker-held short trails are an explicit follow-up).

2. **Guardrails UI: stop settings consolidated** (owner: "the standard stop loss % shouldn't be
   alone and separate from the other related settings that are down lower in advanced settings").
   The lone Essentials "Stop-loss" row (whose hint was actively misleading — with ATR stops ON by
   default, the flat % is only the FALLBACK distance) plus take-profit/trim and the buried
   "Protective stops plumbing" advanced group are now ONE **"Protective stops" card** between
   Essentials and the Advanced rulebook, containing every per-position exit rule with rewritten
   fallback-honest hints, plus the new `brokerTrailingStops` toggle.

3. **Stop-flow diagram** (owner: "arranged on the screen with some graphical depiction/flow or
   arrows between them so that the user can easily tell which works when one fails or isn't
   available… and how trailing stop losses will fit into that").
   New `app/console/guardrails/stop-flow.tsx`: three lanes with labeled fallback arrows, computed
   live from the account's policy (active nodes lit, inactive dimmed, current values shown):
   - **Distance:** ATR stop —(no price history)→ Beta-scaled —(no beta)→ Flat base %.
   - **Trailing:** the high-water-mark overlay that runs alongside the distance stop.
   - **Enforcement:** Broker-held (brackets / native trailing / RH resting) —(broker can't hold
     it)→ App monitor (every tick; pauses while Stopped).
   The model is a pure exported function (`stopFlowModel`) so the wiring is unit-tested.

## Why

The owner reviewed both brokers as supporting trailing stops and asked that the app actually use
them; and correctly observed that the settings UI presented stop mechanisms as unrelated scattered
options with no depiction of the fallback chain, while defaults (ATR+beta ON since 2026-07-07)
made the "Stop-loss %" hint literally untrue. The RH native-vs-ratchet decision: sending
unverified `trailing_peg`-style args to the RH MCP could silently degrade into a never-moving
stop (dishonest trail) — the ratchet gets a REAL working trail out of verified primitives, and if
RH's MCP later exposes a native param, `toMcpOrder` is the single place to translate it.

## Decisions made

- `brokerTrailingStops` defaults ON because it is inert until the owner deliberately sets a
  trailing % (default 0), safe on Alpaca (documented REST feature), and RH additionally requires
  the `robinhoodBrokerStops` opt-in. No behavior change for any existing configuration.
- Trailing takes precedence over the RH fixed stop when both lanes apply — shares can only back
  one resting sell; the synthetic monitor still layers the other rule on its tick.
- Alpaca positions opened with brackets (default) keep their bracket stop leg; the coverage check
  means the trailing lane doesn't fight it. Native trailing applies to positions without live
  exit-order coverage (manual buys, bracket-less entries, brackets off).
- Per-position LLM-chosen stop plans (owner ask #4) deliberately NOT ridden along — planned with a
  design sketch in `docs/EFFORT-LOG.md` (money-path change across ~6 modules + a migration).

## Files

- `src/lib/types.ts` — `EquityOrderInput.trailPercent`, `TradingPolicy.brokerTrailingStops`.
- `src/lib/defaults.ts` — `brokerTrailingStops: true`.
- `src/lib/alpaca.ts` — native trailing_stop translation in `placeEquityOrder`.
- `src/lib/robinhood.ts` — `toMcpOrder` fails closed on `trailPercent`.
- `src/lib/broker-protective-stops.ts` — two-lane reconciler (`brokerTrailingStopsEnabled`,
  `desiredBrokerStopKind`, kind-aware mismatch incl. ratchet, coverage-aware placement).
- `src/lib/broker-side.ts` — `isLiveExitOrder` + `liveExitOrderCoverage` moved in (shared).
- `src/lib/synthetic-stops.ts` — imports moved helpers; passes `brokerOrders` to reconcile.
- `src/lib/db.ts` — migration 16 + CREATE TABLE columns (`kind`, `trail_percent`).
- `src/lib/db-api-keys.ts` — `BrokerProtectiveStop.kind`/`trailPercent` mapping + upsert.
- `app/api/policy/route.ts` — `brokerTrailingStops` boolean validation.
- `app/console/guardrails/field-defs.ts` — `PROTECTIVE_STOPS` group (replaces `STOPS_PLUMBING`;
  absorbs stop-loss/take-profit/trim from `ESSENTIALS`), honest fallback hints.
- `app/console/guardrails/stop-flow.tsx` — NEW: `stopFlowModel` + `StopFlowDiagram`.
- `app/console/guardrails/page.tsx` — new "Protective stops" card; advanced group removed.
- `test/broker-protective-stops.test.ts` — trailing-lane suite (enablement, native vs ratchet,
  ratchet up/never down, kind switch, coverage skip, teardown, fractional flooring).
- `test/alpaca-brackets.test.ts` — trailing translation + bracket/notional rejection.
- `test/broker-side.test.ts` — `toMcpOrder` trailPercent throw.
- `test/stop-flow-model.test.ts` — NEW: diagram model truthfulness.
- `test/console-policy-diff.test.ts` — import rename.
- `docs/stop-loss-and-exit-strategies.md`, `STATUS.md`, `docs/EFFORT-LOG.md` — updated.

## Verification

Run in the cloud container (Node 22):

```bash
npx vitest run test/broker-protective-stops.test.ts test/alpaca-brackets.test.ts \
  test/broker-side.test.ts test/synthetic-stops.test.ts test/stop-flow-model.test.ts \
  test/console-policy-diff.test.ts test/settings-search-index.test.ts   # 112/112 pass
npm run lint        # (full-gate results recorded below before push)
npx tsc --noEmit
npm test
npm run build
```

## Review fixes (Codex, PR #1331 — all six findings valid, fixed in the follow-up commit)

1. **Stop-loss hint honesty:** clearing the field reverts to the shipped 8% default (mergePolicy
   refills it), it does NOT disable stops — hint rewritten.
2. **Already-breached trails:** placement now skips (and does not advertise) a trailing stop whose
   entry-seeded trigger is at/above the current mark — a native order would restart the trail from
   the depressed market and defer the exit by a full trail distance; the synthetic monitor
   registers and fires the app-defined exit instead.
3. **Fractional remainders:** partial placements (floored native trailing, partially-covered
   positions) are advertised via a new `partiallyPlacedStopSymbols` — the synthetic monitor defers
   only the FIRE path for them and still REGISTERS, so the remainder is never stop-less for a tick.
4. **alpaca-mcp transport:** native trailing is REST-only; `alpaca-mcp` accounts (possibly
   endpoint-only) now take the ratcheted stop_market lane through their own MCP transport.
5. **Partial coverage sizing:** broker stops are sized to the UNCOVERED remainder
   (`uncoveredQuantity`, own-order excluded in mismatch checks) — never stacking more exit
   quantity than the account holds.
6. **Diagram cadence honesty:** the app-managed enforcement node now says fixed/ATR breaches exit
   on each STRATEGY RUN while only the trailing monitor evaluates every scheduler tick.

## Review fixes round 2 + main merge (Codex on `fc72001`; merged `origin/main` incl. PR #1352/#1341)

- **Native trails below entry:** a native Alpaca trail placed while mark < entry seeds from the
  depressed market (avg 100 / mark 96 / 5%: trigger ~91.2 vs the app's entry-seeded 95) — the
  native lane now places only when mark ≥ entry; below it the synthetic monitor keeps the
  entry-seeded trail (the ratcheted lane is unaffected — its explicit trigger IS entry-seeded).
- **Trailing copy honesty:** shares committed to resting broker exits (Alpaca bracket legs) can't
  also back a trail — hint + diagram now say bracketed positions keep their bracket exits.
- **Live-placement preflight:** sections 3–4 now return early when `livePreflightBlocks` is true
  (ALLOW_LIVE_TRADING=false escape hatch) — the default-on trailing lane can no longer place a
  real broker order past an explicit live-trading opt-out; risk-reducing cancels still run.
- **Merge with main:** PR #1352's pending_cancel self-heal (`isDoneRestingState`, filled-recovery
  defer) landed on main touching the same reconciler — its `orders` param and this PR's
  `brokerOrders` were the same caller list, so they are UNIFIED as `orders` (recovery + coverage
  documented together); PR #1341's connectedAccountId audit threading kept on the merged sites.
  NOTE: main also flipped **auto-deploy ON** (b4c4f4b) — merging this PR auto-deploys production.

## Review fixes round 3 (Codex on `c36c3ab`, three findings)

1. **P2 — coverage-unknown ≠ coverage-free:** when the synthetic monitor's own `getEquityOrders`
   fetch fails, it was passing an EMPTY order list into `reconcileBrokerProtectiveStops`, which
   the reconciler read as "confirmed no coverage" — placing (or, worse, resizing/cancelling) a
   broker-held stop against a blind spot that might actually hide a full-size bracket leg. New
   `ordersListed?: boolean` param (default `true`, preserving old behavior for every caller that
   never had real coverage info to begin with) — the synthetic monitor now passes its own
   `brokerOrdersListed` flag. `uncoveredQuantity`/`desiredStopQuantity` return `null` ("truly
   unknown") instead of a number when `ordersListed` is `false`, and BOTH section 3 (mismatch/
   cancel) and section 4 (new placement) skip a symbol entirely on `null` rather than guess.
2. **P2 — stop-flow tooltip still wrong:** the NEW diagram's "Flat base %" node detail repeated
   the same "clearing turns it off" claim already fixed in field-defs.ts's hint — corrected to say
   blanking reverts to the 8% default; only an explicit 0 disables the stop.
3. **P1 — partial broker stops wiped on a remainder-only exit:** when a broker-held stop covers
   only PART of a position (e.g. a native Alpaca trail floored 10.6 sh to 10), the synthetic
   monitor fires for just the uncovered remainder — but then called `cancelBrokerProtectiveStop`
   UNCONDITIONALLY, tearing down the still-valid 10-share stop covering the rest of the position.
   Fixed: the cancel now runs only when the fire closes the WHOLE position (`qty >=
   positionQty - epsilon`); a partial fire leaves the broker-held stop resting undisturbed.

New tests: `test/broker-protective-stops.test.ts` (ordersListed skip on placement/mismatch,
recovery on the next successful fetch, default-true regression); `test/synthetic-stops.test.ts`
(partial fire preserves the broker-held stop). Full gate re-run green after these fixes.

## Review fixes round 4 (Codex on `40ebbc2`, four findings)

1. **P2 — OCO bracket legs double-counted as coverage:** `liveExitOrderCoverage` summed the
   quantities of ALL live exit orders for a symbol, but an Alpaca OCO bracket's stop-loss and
   take-profit legs are mutually exclusive exits for the SAME shares (filling one auto-cancels the
   other) — summing both counted a fully-bracketed position's protection as double its real size.
   Harmless when a position's bracket covers 100% of it (the "≥ position size" skip fires either
   way), but a genuinely half-bracketed position (e.g. two independent 50-share scale-in brackets
   vs. one 50-share bracket on a 100-share position) had its uncovered half silently hidden from
   every caller that sizes a NEW broker-held stop off this number. Fixed: `liveExitOrderCoverage`
   now pairs a stop-type leg with an unused limit-type leg at a matching remaining quantity (the
   OCO bracket signature) and counts the pair once; unpaired legs (a lone resting stop, a manual
   take-profit-only sell) still count independently. Moved the whole computation from a flat sum to
   stop/limit/other buckets with pairing logic in `src/lib/broker-side.ts`.
2. **P2 — a mismatched trailing stop was cancelled even when the replacement would be refused:**
   section 3's cancel-then-replace logic didn't check whether section 4's already-breached /
   looser-than-app-trail guard would actually let the replacement land — a trail%/quantity change
   while price sat below entry (or the tracked high) cancelled the old (still-protective) stop and
   then correctly refused to replace it, leaving the position with NO broker-held stop until
   conditions recovered. Fixed: extracted the placement-eligibility check into a shared
   `canArmTrailingNow` helper; section 3 now skips the cancel (keeps the existing stop) whenever
   section 4 would refuse the replacement.
3. **P1 — a broker-held trail could be seeded looser than the app's own already-armed trail:** the
   ratchet/native-placement logic recomputed the trailing anchor from `max(currentMark, entry)`
   only — but if price had rallied above entry and then pulled back, the SYNTHETIC monitor's own
   `extreme_price` (the true high-water mark) could be well above the current mark, meaning the
   app's real trigger was already tighter (higher) than anything reconstructed from just the
   current tick's data. Example: avg 100, synthetic-tracked extreme 130, mark 120, 5% trail — the
   app's real trigger is 123.50, but recomputing from `max(120,100)` would arm a broker trail
   around 114, weakening protection the moment broker-held trailing turns on. Fixed: new
   `extremePriceBySymbol` param (the synthetic monitor's own ACTIVE-row extremes, fetched by the
   caller before reconcile runs) feeds `trailingTriggerPrice` and the native-lane placement guard
   (now `mark >= max(entry, trackedExtreme)` instead of just `mark >= entry`), so a broker-held
   trail is never armed looser than the trail already protecting the position.
4. **P2 — the stop-flow diagram implied ATR/beta distance applies to Robinhood's fixed broker
   stop:** `reconcileBrokerProtectiveStops`'s fixed-kind price calc uses the flat `stopLossPct`
   only, never the ATR/beta-adjusted effective distance shown in the diagram's distance lane —
   properly closing that gap requires threading per-symbol effective-stop-distance data into
   `broker-protective-stops.ts` (this file has no market-scan/beta access today), which is the same
   plumbing the planned per-position stop-plan feature will add. For now, fixed with an honest
   annotation: the enforcement lane's "Broker-held" node explicitly calls out the exception when
   Robinhood's fixed lane is active. Proper fix deferred to the stop-plan follow-up.

New tests: `test/broker-side.test.ts` (7 new `liveExitOrderCoverage` OCO-pairing cases);
`test/broker-protective-stops.test.ts` (tracked-extreme seeding, native-lane refusal below tracked
extreme, keep-existing-stop-when-replacement-refused). Full gate re-run green.

## Review fixes round 5 (Codex on `9d83464`, four findings)

1. **P2 — OCO pairing could conflate two INDEPENDENT equal-quantity exits as one bracket:**
   round 4's stop/limit quantity-matched pairing in `liveExitOrderCoverage` had no way to tell a
   real bracket sibling (Alpaca creates both legs together) from an owner's manual stop plus a
   separately-placed take-profit limit at the same size — pairing the latter undercounts real
   coverage (reports 50 instead of 100 on a 100-share position) and lets a new exit stack on top of
   an order that can still fill. Fixed: pairing now also requires the two legs' `createdAt` to fall
   within a `BRACKET_SIBLING_WINDOW_MS` (5s) window — true bracket legs are created together;
   independent manual orders placed at different times no longer pair.
2. **P2 — a stale `resting` broker-stop row was never checked against the tracked order's actual
   broker state:** section 3 only looked for a numeric qty/price/kind mismatch on an existing
   `resting` row, so if the tracked order had already finished (filled naturally, or
   rejected/canceled/expired) without ever going through section 1's cancel-recovery path, and the
   recomputed values happened to still match the stale row, the ghost row was never cleared —
   permanently blocking section 4 from placing a real replacement for the (now differently
   protected) remaining shares. Fixed: section 3 now checks the caller's order list for the tracked
   order's terminal state first (mirroring section 1's `isDoneRestingState` recovery) and deletes
   the stale row on positive evidence, deferring same-tick replacement via `filledRecoverySymbols`
   for an actual fill (same staleness reasoning as the existing section-1 path).
3. **P2 — an oversized existing stop was left untouched whenever other-order coverage was
   unknown:** when a real order-list fetch failed this tick (`ordersListed: false`),
   `desiredStopQuantity` correctly returns `null` (coverage from OTHER orders is unknowable), but
   the code skipped ALL drift handling on that `null` — including the case where the position
   itself has shrunk below the existing stop's OWN recorded quantity, which needs no order-list
   data at all. An oversized resting stop can sell more shares than the account holds (or open an
   unintended short) if it fires. Fixed: the unknown-coverage path now separately checks
   `existingStop.quantity` against the current position size and cancels (never blindly replaces)
   when oversized, regardless of the other-order blind spot; a row that isn't oversized is still
   left untouched exactly as before.
4. **P2 — a trailing stop's oversized-by-known-coverage mismatch was discarded whenever a
   replacement would be refused:** the round-4 `canArmTrailingNow` guard (added to avoid cancelling
   into a stranded position) blanket-cleared EVERY trailing mismatch when arming would be refused —
   including a pure quantity SHRINK caused by newly-KNOWN other coverage (e.g. a separate live exit
   order now covers part of the position). Unlike a price/kind mismatch, cancelling a shrink never
   needs to "arm" anything — it only removes exposure — so keeping the old full-size stop stacked
   on top of the other known order risked an over-sell if both filled. Fixed: the arm-gate now
   exempts a `qty < existingStop.quantity` "quantity drift" mismatch, cancelling it unconditionally;
   section 4's own `canArmTrailingNow` gate still independently decides whether a same-tick
   replacement can be placed.

New tests: `test/broker-side.test.ts` (independent-orders-not-paired-by-time case);
`test/broker-protective-stops.test.ts` (new `round-5 mismatch/staleness fixes` describe block: stale
filled-row cleanup, oversized-on-unknown-coverage cancel, not-oversized-stays-untouched control case,
quantity-shrink-cancels-despite-arm-refusal). Full gate (lint/tsc/test/build) re-run green in the
isolated worktree.

## Review fixes round 6 (Codex on `3a2fb65`, four findings)

1. **P2 — round 5's OCO created-together time window still admitted a false-positive pair:**
   Codex correctly pushed back (twice) on the `BRACKET_SIBLING_WINDOW_MS` heuristic — an owner can
   coincidentally submit an independent same-size stop and limit within the 5s window, and both can
   still fill; timestamp proximity alone is not proof of a real bracket relationship. Fixed properly
   this time: added `EquityOrder.orderClass` (mapped from Alpaca's own `order_class` field —
   "simple"/"bracket"/"oco"/"oto" — which the broker preserves on split child legs after the entry
   fills, not just the parent), and `liveExitOrderCoverage` now requires BOTH legs to report a
   bracket-family `orderClass` before pairing — the broker's own verified sibling identity, not a
   time-based guess. Dropped the time-window heuristic entirely. An order with no `orderClass`
   (Robinhood, which has no bracket concept, or a manually-placed "simple" Alpaca order) never
   pairs — the residual risk is the bounded, previously-accepted "half-bracket looks fully covered"
   gap, never a false-positive pair that could stack two real exits on the same shares.
2. **P2 — a PARTIAL native-trail placement blanket-skipped the synthetic fire path for the WHOLE
   position:** when a whole-share-only native trailing stop floors away a fractional remainder (a
   fractional Alpaca long), `reconcileBrokerProtectiveStops` correctly places a partial broker stop
   THIS tick — but `runSyntheticStopMonitor`'s fire-path guard treated ANY partial placement the same
   as a full one and skipped firing entirely, leaving the fractional remainder completely
   unprotected if a fresh quote already breaches the trail this same tick (and exposed indefinitely
   if the app stops before the next tick). Fixed: `ReconcileResult` grew
   `partiallyPlacedStopQuantities` (the exact quantity just placed, keyed by symbol); the synthetic
   monitor now folds that quantity into `liveExitOrderCoverage`'s result as KNOWN additional coverage
   instead of skipping outright, so the fire path still protects the genuinely uncovered remainder.
3. **P2 (documentation) — the stop-flow diagram's "Broker-held" node implied Alpaca trailing covers
   shorts too:** the reconciler deliberately builds `liveLongs` from `p.quantity > 0` and leaves
   Alpaca shorts on the synthetic monitor only (a documented, accepted follow-up) — but the diagram's
   text didn't say so, so a short-enabled account could believe its short trailing stops survive app
   downtime when they don't. Fixed: the "Broker-held" node's detail now appends an explicit
   long-only caveat whenever `policy.shortSellingEnabled === true`.

New tests: `test/broker-side.test.ts` (orderClass-gated pairing: no-orderClass, same-timing-but-no-
orderClass, mismatched orderClass, and an `"oco"`-class pairing case); `test/broker-protective-stops.test.ts`
(exact-equality assertion updated for the new `partiallyPlacedStopQuantities` field);
`test/synthetic-stops.test.ts` (a fractional Alpaca long gets its native trail floored to whole
shares, and the 0.5-share remainder still fires this same tick instead of the whole fire path being
skipped); `test/stop-flow-model.test.ts` (short-enabled long-only caveat present/absent). Full gate
(lint/tsc/test/build) re-run green in the isolated worktree.

## Review fixes round 7 (Codex on `c70c219`, three findings + one docs fix)

1. **(docs) — the `brokerTrailingStops` field hint didn't distinguish Alpaca REST from Alpaca MCP:**
   round 4 already routes `alpaca-mcp` through the ratcheted stop-market emulation (not a true
   native `trailing_stop`), but the Guardrails hint text described "native trailing_stop orders on
   Alpaca" without that caveat, understating the downtime-survival difference for MCP-endpoint
   accounts. Fixed: the hint now explicitly separates "Alpaca REST → native" from "Alpaca MCP → same
   app-ratcheted stop as Robinhood."
2. **P2 — a broker-held stop that was ACTIVELY EXECUTING (`partially_filled`) could be cancelled by
   the quantity-drift mismatch check:** section 3 only recognized a tracked order as terminal via
   `isDoneRestingState` (filled/rejected/canceled/expired) — a `partially_filled` order is still
   LIVE (per `broker-side.ts`'s `LIVE_ORDER_STATES`), so it fell through to the quantity-drift
   comparison, which could see a mismatch (the position not yet reflecting the in-flight partial
   fill) and cancel the order mid-execution — either the broker refuses the cancel outright, or it
   succeeds and aborts the rest of an exit that was already correctly working. Fixed: a
   `partially_filled` tracked order now skips drift detection entirely for that tick — the row is
   left resting untouched; a later tick's `isDoneRestingState` recovery or a clean drift check
   (once the fill settles) handles it from there.
3. **P2 — the re-arm confirmation could be permanently blocked by an UNRELATED broker-held stop for
   the same symbol:** `confirmedPriorExitDead`'s `hasAnyLiveExitOrder` symbol-wide sweep was
   originally meant as a conservative fallback for rows with no recorded `lastAttemptRefId` — but it
   ran UNCONDITIONALLY, even for rows that DO have one. After round 6's partial-native-trail fix (a
   fractional long's floored native trail coexists with the synthetic monitor firing its own exit
   for the uncovered remainder), that symbol-wide sweep would see the broker's own STILL-LIVE trail
   (covering the OTHER shares) and refuse to re-arm the remainder's OWN dead exit attempt forever —
   even though the specific order being checked (by `client_order_id`) was confirmed dead. Fixed:
   when a row has a recorded `lastAttemptRefId`, `confirmedPriorExitDead` now checks ONLY that
   specific order's liveness — never a symbol-wide sweep that can't distinguish "our own dead
   order" from "an unrelated order covering different shares." The symbol-wide fallback now applies
   only to the (essentially historical) case of a row with no recorded attempt id at all.

New tests: `test/broker-protective-stops.test.ts` (a `partially_filled` tracked stop is left resting
untouched despite a quantity recompute that would otherwise look like drift); `test/synthetic-stops.test.ts`
(a fractional Alpaca long's uncovered remainder re-arms and re-fires after its own exit dies, despite
the unrelated native trail for the other shares staying live throughout). Full gate
(lint/tsc/test/build) re-run green in the isolated worktree.

## Review fixes round 8 (Codex on `ad487ba`, two findings)

1. **P1 — round 7's `client_order_id`-only re-arm branch was itself fragile when the id is
   missing:** round 7 special-cased `confirmedPriorExitDead` to check only the row's own
   `lastAttemptRefId` (via `client_order_id` match) when one was recorded, instead of a symbol-wide
   sweep — but `client_order_id` is an OPTIONAL field on `EquityOrder`; if a broker's order mapper
   doesn't populate it on a still-live order, the specific-match check would find nothing live under
   that id and wrongly conclude "dead," advancing the generation and placing a duplicate exit
   alongside an order that's still actually working. Fixed differently: replaced the
   `client_order_id`-branching with `brokerHeldOrderIdBySymbol`, a map of the account's OWN
   recognized `broker_protective_stops` row's `brokerOrderId` per symbol — built from
   `listBrokerProtectiveStops`, independent of any broker-supplied `client_order_id`. The
   quantity-blind `hasAnyLiveExitOrder` sweep now excludes only that one specifically-tracked order
   (separately-managed, possibly-covering-other-shares coverage) and stays a full symbol-wide sweep
   for everything else — including the row's own synthetic exit attempt if ITS id happens not to be
   matchable, which still correctly blocks re-arm. `confirmedPriorExitDead` reverted to a single
   combined check (no more `lastAttemptRefId`-present/absent branching) plus its own belt-and-suspenders
   `client_order_id` check as an additional (not sole) safeguard.
   - **Ordering bug found while verifying this fix:** the re-arm pass runs BEFORE this tick's
     `reconcileBrokerProtectiveStops` call (which is what refreshes `brokerHeldOrderIdBySymbol` from
     the DB), so populating the map only after reconcile left it empty for the re-arm pass every
     tick — silently defeating the exclusion it was meant to provide. Fixed by ALSO seeding the map
     at declaration, from the DB state left by the END of the previous tick's reconcile (before the
     re-arm pass runs), then refreshing it again after this tick's reconcile for the later fire pass.
     Caught by a debug trace on the exact round-7 regression test — `test/synthetic-stops.test.ts`'s
     "re-arms the remainder's own dead exit even while an UNRELATED broker-held stop is still live"
     failed (`second.exited` was `0` instead of `1`) until both halves of the fix landed.
2. **P2 — a broker-held stop recognized as FILLED during stale-row cleanup was only deleted, never
   booked as a fill:** both section 1's pending-cancel recovery and section 3's stale-resting-row
   cleanup detect a tracked order in a terminal `filled` state and delete the DB row, but neither
   ever recorded the actual exit — a native Alpaca trail or an RH ratcheted stop that closed a
   position this way vanished from realized P&L, the learning loop, and the activity feed, with no
   record it ever executed. Fixed: both sites now call a new `bookBrokerHeldStopFill` helper that
   inserts a `fill_events` row (side `sell`, quantity/price from the tracked order's
   `filledQuantity`/`averagePrice` falling back to the DB row's own recorded quantity/stop price,
   `status: "filled"`, `raw: { brokerHeldProtectiveStop: true, kind }`) before the row disappears.

New test coverage for round 8: the existing round-7 regression test in
`test/synthetic-stops.test.ts` now exercises the corrected map-seeding order end-to-end (re-arm
succeeds on tick 2 despite the unrelated native trail staying live). Full gate (lint/tsc/test/build)
re-run green in the isolated worktree; 3434 tests / 316 files pass.

## Review fixes round 9 (Codex on `dd0306b`, three findings)

1. **P2 — a broker-held stop recognized as FILLED during DISABLED-teardown (`kind === null`) was
   never recovered:** that teardown path (the whole feature turned off while a stop was still
   resting) only tried the cancel and, on failure, unconditionally marked the row `pending_cancel` —
   it never checked the caller's `orders` evidence the way section 1's normal recovery does. A stop
   that had already FILLED before the cancel reached the broker would retry forever (the teardown
   path runs every tick while disabled) and its fill would never reach `fill_events`. Fixed: the
   teardown catch block now mirrors section 1 — checks `orders` for a terminal state and, if found,
   deletes the row and books the fill via `bookBrokerHeldStopFill` instead of retrying indefinitely.
2. **P2 — a PARTIAL fill that then terminated as canceled/expired/rejected (not literally `filled`)
   was never booked, at any of the three recovery sites:** all three (the new disabled-teardown
   recovery above, section 1's pending-cancel recovery, section 3's stale-resting-row cleanup) only
   called `bookBrokerHeldStopFill` when the tracked order's overall state string was exactly
   `"filled"` — a stop that partially executed (some real shares traded) and then had its remainder
   canceled reported a non-"filled" terminal state despite a positive `filledQuantity`, so those
   shares' exit silently vanished from P&L/learning/activity, and the symbol was never added to
   `filledRecoverySymbols` either (risking section 4 sizing a replacement off the stale pre-partial-
   fill position). Fixed: a new `hadExecutedFill` predicate books on EITHER the literal `"filled"`
   state OR a positive `filledQuantity` regardless of state, used at all three recovery sites.
3. **P2 — a native trail's mismatch-driven REPLACEMENT (trail % or quantity changed) could reseed
   LOOSER than the broker's own already-ratcheted-up high-water mark:** `canArmTrailingNow`'s guard
   reads `extremePriceBySymbol[sym] ?? 0` — but a native trail that covers the WHOLE position
   suppresses synthetic registration entirely (by design, since the position is already protected),
   so this map has no entry for that symbol at all; `0` was read as "no tracked peak," not "unknown."
   Concretely: entry 100, rally to 130 (native trail seeds at 123.50 = 130 × 0.95), pull back to 126,
   then the trail % changes — with `trackedExtreme` read as 0, `canArmTrailingNow` saw `126 >=
   max(100, 0)` and wrongly approved a reseed at `126 × 0.94 = 118.44`, LOOSER than the 123.50 already
   resting. Fixed: before section 3 runs, backfill any symbol MISSING a tracked extreme by inverting
   the existing stop's own recorded terms — `stopPrice = trueStartPeak × (1 − trailPercent/100)`, so
   `impliedExtreme = stopPrice / (1 − trailPercent/100)` — a mathematically sound LOWER BOUND on the
   broker's true current peak (Alpaca's native trail only ever ratchets UP). A synthetic row's own
   independently-tracked extreme, when present, is trusted as-is and never overridden.

New tests (all in `test/broker-protective-stops.test.ts`, new "round-9" describe block): disabled-
teardown fill recovery; partial-then-canceled fill booking (asserts both the `fill_events` row and
`filledRecoverySymbols`); the exact rally/pullback/trail-%-change scenario from finding 3 (asserts
the replacement is refused and the tighter existing stop survives); a companion test confirming the
backfill doesn't overshoot — a genuinely-at-or-above-peak mark still permits the replacement. Full
gate (lint/tsc/test/build) green in the isolated worktree; 3438 tests / 316 files pass.

## Follow-ups / risks

- **Live-verify the RH ratchet lane before enabling `robinhoodBrokerStops`** — same standing
  caveat as the fixed lane (that flag remains default OFF).
- Broker-held trailing for Alpaca SHORT positions (buy-side trailing stop) — follow-up.
- Alpaca order-list mapping reports a resting trailing_stop as `stop_market` (`mapAlpacaOrderType`)
  — deliberate (coverage counts it as protection); revisit if the UI should label it "trailing".
- Per-position LLM stop plans: Planned row + design sketch in `docs/EFFORT-LOG.md`.
- `/Users/jay/apps/TRADING-EFFORT-LOG.md` (branch-neutral live board) could NOT be updated from
  this cloud session (no Mac filesystem access) — next Mac-side agent should sync the mirror.
