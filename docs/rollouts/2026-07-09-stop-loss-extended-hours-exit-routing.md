# 2026-07-09 — Stop-loss settings accuracy: extended-hours exit routing + honest coexistence label (MONET)

Branch: `monet/stop-loss-settings-defaults-759d07`

## Summary

First slice of an owner-directed stop-loss **settings-accuracy** effort (audit found several stop
toggles that behave differently than their labels imply). This slice ships the two parts that are
**non-overlapping** with the parallel Monet/Antigravity PRs also touching the guardrails surface:

1. **Extended-hours protective-exit routing fix** — the "App stops in extended hours"
   (`allowExtendedHoursSyntheticStops`) toggle was not just mislabeled, it was **broken**:
   `alpaca.ts` set `extended_hours=true` on a still-`market` order, which Alpaca rejects (extended
   orders must be DAY limit orders), and the MCP order path dropped the flag entirely. So turning it
   on made the protective exit fail/no-op instead of firing after hours. Per owner ruling
   ("limit when ON, queue when OFF"), protective exits now route through a new shared helper:
   - toggle OFF (default) or a regular/closed session → a plain **market** order tagged
     `regular_hours` (unchanged; an after-hours trigger rests until the 09:30 open);
   - toggle ON **and** the pre/post session → a **marketable-limit** (`type: "limit"`,
     `extended_hours`, DAY) priced through the last quote (a SELL crosses down, a COVER up, by
     `tuning.marketableLimitBufferBps`, default 15) so it can actually fill in thin liquidity.
   Applied to BOTH protective-exit paths: the every-tick synthetic monitor and the proactive
   risk-exit generator. Fails safe (market/queue-to-open) when no price is available or "limit" is
   not a permitted order type.

2. **Honest coexistence protection label** — the per-position protection label
   (`deriveProtection`) showed only the trailing stop when a trailing % was set, implying it
   *replaced* the fixed stop. A fixed stop and a trailing stop actually COEXIST (fixed % drives the
   proactive exit / broker bracket; trailing % drives the synthetic monitor). The label now reads
   `App stop −8% + trailing −5%` when both apply.

## Why

Owner audited the stop settings and asked that they be "obvious in settings and accurate always."
The extended-hours toggle was the sharpest case: enabling it silently broke the protective exit.
Owner chose the marketable-limit fix (real after-hours execution) over queue-to-open, with the
default staying OFF.

## Coordination

A parallel Monet session was mid-build on the overlapping fileset and (via #ag***-s**c) claimed a
"no gate / labels-only" reading of owner intent. Owner ruled (this session's live conversation is
authoritative): the short-selling **gate stays** and **behavior-match stays**. Division agreed on
the channel: the peer keeps `defaults.ts` (`shortStopLossPct=8` real default, PR #1221),
shorts-surface in Essentials, and the RH resting-state **safety** fixes; this branch keeps the
short-selling gate + ATR/beta/extended-hours label honesty + behavior-matches. Shared files
(`field-defs.ts`, `guardrails/page.tsx`) are deferred here to avoid a 3-way clobber with PR #1221
and Antigravity PR #1211 (extended-hours tooltips).

## Files

- `src/lib/protective-exit-routing.ts` — **new.** `extendedHoursExitBufferBps`,
  `marketableLimitExitPrice`, `resolveProtectiveExitRouting`.
- `src/lib/synthetic-stops.ts` — synthetic monitor exit uses `resolveProtectiveExitRouting` (replaces
  the unconditional `extended_hours` marketHours; adds `limitPrice`).
- `src/lib/strategy.ts` — `generateProactiveRiskProposals` takes an `extHoursBufferBps` param (resolved
  once by the async run via `extendedHoursExitBufferBps(policy)`); the proactive stop/short-stop exit
  becomes a marketable-limit `extended_hours` order when set.
- `app/console/lib/derive.ts` — coexistence protection label.
- `test/protective-exit-routing.test.ts` — **new**, 15 tests (helper + generator wiring).

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing warning backlog unchanged).
- `npx vitest run` — **3183 passed** (307 files), including the 15 new routing tests.
- `npm run build` — (in the same run; recorded green before PR).

## Review fixes (PR #1228, second commit — 4 confirmed-real findings on the exit pricing/queueing)

Code review confirmed four real defects in the new routing; all fixed in one follow-up commit on
this branch, each with regression tests:

1. **SELL exits now anchor to the BID (P1).** `marketableLimitExitPrice` priced a SELL off the
   single composite `refPrice`, but the composite quote price is ask-biased (Alpaca sets
   `price = ask ?? bid`), so on any spread wider than the buffer the "marketable" SELL limit sat
   ABOVE the bid and rested unfilled. The helpers now take a `ProtectiveExitQuote` (`price`/`bid`/
   `ask`): a SELL anchors to the real bid, a COVER to the real ask, composite price as fallback;
   synthesized (price-derived) spread sides never anchor (same guard as the entry marketable-limit,
   via `protectiveExitQuoteFromScan` / the monitor's `exitQuoteFor`).
2. **Approval-held exits are repriced at placement (P1).** Under propose authority the stored
   extended-hours limit was submitted verbatim at Approve time — a quote that moved through the
   stale limit left the exit resting where the old market/queue-to-open exit would have gotten out.
   `executeProposal` now re-resolves the routing (`repriceStoredProtectiveExit`) off the fresh
   approval-scan quote + wall clock, degrading to market/regular_hours when the extended session no
   longer applies, and writes a `protective_exit_repriced` audit receipt.
3. **Fractional exits stay queued, never blocked (P1).** Both protective paths routed fractional
   quantities to the extended-hours limit, which policy hard-blocks ("Fractional or dollar-based
   orders must be regular-hours only.") — a breached fractional stop placed NO exit at all for the
   whole extended session. Fractional quantities now keep the market/queue-to-open routing
   (whole-share guard in `generateProactiveRiskProposals` and `resolveProtectiveExitRouting`).
4. **Buffer validated (P2).** A stored zero/negative `tuning.marketableLimitBufferBps` inverted the
   marketable price (SELL limit above the reference). `extendedHoursExitBufferBps` now falls back to
   the 15-bps default for non-finite/non-positive values and caps at 500 bps; the policy route
   validates the field on save (`app/api/policy/route.ts`).

Additional files: `test/protective-exit-reprice.test.ts` (**new** — drives the real
`executeProposal` approval path under fake timers for both the repriced-limit and degraded-to-market
cases); `test/marketable-limit-buffer-api.test.ts` (**new** — route-level buffer bound); extended
`test/protective-exit-routing.test.ts` (bid/ask anchoring, fractional guard, buffer clamp,
`repriceStoredProtectiveExit`) and `test/synthetic-stops.test.ts` (monitor-level bid-anchored
extended-hours limit + fractional queue-to-open). Verification for the fix commit:
`npx tsc --noEmit` clean; `npx vitest run` on the four touched test files plus the adjacent
policy-route/generator suites (`reconciliation-risk`, `strategy-hardening`,
`drawdown-breaker-action-api`, `ira-washsale-api`, `model-rotation`, `policy-notification-events`)
— all passed; `npx eslint` on touched files — 0 errors (pre-existing warnings only). Full
lint/test/build runs in the `verify` CI gate.

## Review fixes round 2 (PR #1228, third commit — 5 findings)

1. **Early-close sessions (protective-exit-routing.ts).** `currentMarketSession` hard-codes the
   16:00 close, so on an NYSE early-close day (13:00 ET — `getEarlyCloseDays` in
   `market-calendar.ts`) 13:00–16:00 was misclassified as "regular", downgrading an extended-hours
   protective limit to a regular-hours market order that queues to the NEXT open. New
   `protectiveExitMarketSession` wraps `currentMarketSession` and treats post-close time on an
   early-close date as "post"; `extendedHoursExitBufferBps` (both exit paths + the approval reprice)
   uses it.
2. **Live typed-confirm invariant (strategy.ts).** A reprice after a live typed confirmation could
   place an order materially different from what the phrase confirmed. Following the
   `autoRemediateStaleExitOrders` precedent (PR #1036), on broker/live with
   `requireTypedConfirmation` on, a MATERIAL reprice (price — or confirmed-notional — drift beyond
   the validated marketable-limit buffer tolerance, `assessProtectiveExitRepriceDrift`) now routes
   the card BACK to approval with the repriced order persisted and a
   `protective_exit_reprice_reapproval` audit + `pending_approval` notification; immaterial drift
   places normally (drift included in the `protective_exit_repriced` audit payload). A degrade with
   no verifiable fresh price is treated as material (defer to human).
3. **Repriced proposal persisted (strategy.ts + db-proposals.ts).** `trade_proposals.proposal` kept
   the stale order after a reprice, so Recent/Activity/getProposal showed an order the broker never
   received. New `updatePendingProposalReprice` (CAS on `status='proposed'`, refreshes
   `estimated_notional`) persists the repriced JSON BEFORE claiming/placing on every reprice path;
   a lost CAS stops the approval like the other pending guards.
4. **validatePolicy over-reach (app/api/policy/route.ts).** The new `marketableLimitBufferBps`
   bound ran against the MERGED policy, so a stored out-of-range value 400'd EVERY unrelated save.
   Scoped like the reasoning/keyed-model rules: enforced only when the request sets/changes the
   field (`enforceMarketableLimitBufferRule`); the runtime clamp
   (`validatedMarketableLimitBufferBps`, extracted) still guards stale stored values.
5. **Sub-dollar tick precision (protective-exit-routing.ts).** 2-dp `Math.round` could un-cross a
   sub-$1 quote (SELL off a $0.496 bid rounded UP to $0.50, resting unfilled).
   `marketableLimitExitPrice` now rounds tick-aware and OUTWARD — always in the marketable
   direction (floor for SELL, ceil for COVER) — at 4 dp below $1 (SEC Rule 612 sub-penny increments)
   and whole pennies at/above $1, with an on-tick float-artifact snap. One synthetic-stops
   expectation moved a penny outward (89.37 → 89.36).

Regression tests extend the PR's existing files: `test/protective-exit-routing.test.ts`
(early-close session block, outward/sub-dollar rounding, `assessProtectiveExitRepriceDrift`),
`test/protective-exit-reprice.test.ts` (live material → routed back to approval + persisted card;
live immaterial → places; persisted-JSON assertions on the paper paths),
`test/marketable-limit-buffer-api.test.ts` (stored out-of-range value doesn't block unrelated
saves; changing writes still 400). Verification: `npx tsc --noEmit` clean; `npx vitest run` on the
four touched test files — 75 passed; `npx eslint` on touched files — 0 errors (pre-existing
warnings only).

## Follow-ups (blocked on other in-flight PRs)

- **field-defs honest copy** (ATR needs `stopLossPct>0` + precedence over beta; beta ignored when
  ATR applies; ATR period/multiple show real 14/2.0 defaults + decimal multiple; short-stop gate
  copy) — layer AFTER peer PR #1221 and AG #1211 merge (both touch `field-defs.ts`).
- **short-selling gate** in `guardrails/page.tsx` — inline warning when short selling is on and the
  effective `shortStopLossPct` ≤ 0 (shorts are hard-rejected at `policy.ts:433`); after #1221 lands
  (it moves the shorts fields into Essentials).
- **RH resting stop uses the effective ATR/beta distance** (`broker-protective-stops.ts`, currently
  flat `stopLossPct`) — needs the per-position effective stop % persisted at reconcile time; fold
  into / stack on the peer's RH-safety PR.
- Known: the synthetic monitor still routes `extended_hours` per-session; the RH resting stop and
  Alpaca native bracket stop legs remain regular-hours only (broker-held; separate follow-up).
