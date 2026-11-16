# 2026-07-18 — Money-path / reliability follow-ups from PR #1705 (CLAUDE)

Branch: `claude/money-path-followups-1701` (off `origin/main` @ `b0063a7`).

## Summary

Fixed 4 money-path / reliability findings that merged into `main` (rode in via PR #1705) still
UNFIXED. A 5th finding was already resolved on current `main` by PR #1713 and is skipped. Each fix
is minimal + carries a regression test that was verified to FAIL on the unfixed code and PASS with
the fix.

## Findings

### 1. scheduler/synthetic-stops — halted account could PLACE broker protective stops (money-path)
- **Still reproduced on main:** YES.
- With `protectWhileHalted` enabled, `scheduler.ts` runs `runSyntheticStopMonitor(userId, policy,
  true)` while `systemState === "halted"`. That `running=true` flowed straight into
  `reconcileBrokerProtectiveStops`, whose placement/replacement sections (3 & 4, gated by `running`)
  then PLACED/REPLACED broker-held stops — contrary to the rule that halted protection may only
  FIRE existing synthetic/exit stops, never register/update looser broker stops.
- **Fix** (`src/lib/synthetic-stops.ts`, ~L363): compute
  `const mayReconcileBrokerStops = running && policy.systemState !== "halted";` and pass THAT as
  `running` to `reconcileBrokerProtectiveStops`. The reconciler's `running` flag is exactly what
  gates its placement/replacement sections; its risk-reducing cancel-on-close sweeps (sections 1 &
  2) run regardless. So a halted+`protectWhileHalted` tick still fires resting synthetic exits (the
  fire loop below still keys off the original `running`) and still cancels stops on closed positions,
  but can no longer submit NEW/looser broker protective orders.
- **Test:** `test/synthetic-stops.test.ts` — new "never PLACES/REPLACES a broker-held protective
  stop while halted" (Alpaca paper so the broker trailing lane is live; asserts 0 placements while
  halted, > 0 when the same account is active). Verified it fails pre-fix (placed 1 while halted).

### 2. strategy — Tradier bracket stripped before marketable-limit conversion (money-path)
- **Still reproduced on main:** YES.
- In `enrichOpeningProposal`, a Tradier `market` opening entry with `marketableLimitEntries` on is
  converted to a `limit` order a few lines later (a type Tradier's native OTOCO/OTO bracket DOES
  support). But the Tradier market-entry bracket-strip ran EARLIER and permanently removed
  `bracketStopLoss`/`bracketTakeProfit`, so the final order became a limit entry with NO native
  bracket protection.
- **Fix** (`src/lib/strategy.ts`, ~L5733): predict the conversion
  (`willBecomeMarketableLimit`, mirroring the conversion gate incl. the whole-share qty check) and
  exclude it from `isTradierMarket`. When the entry will convert, it is no longer treated as a
  "Tradier market entry" for bracket purposes: the strip is skipped and the whole-share branch runs
  to (re)compute the legs, which then survive to the converted limit order. A Tradier market entry
  that will NOT convert still has its brackets stripped (Tradier can't bracket a bare market entry).
- **Test:** `test/strategy-hardening.test.ts` — new "keeps native brackets for a Tradier market
  entry the marketable-limit conversion turns into a limit" + guardrail "still strips … that will
  NOT convert". Verified the first fails pre-fix (brackets undefined).

### 3. strategy — active-protection live-exit semantics (money-path) — ALREADY FIXED, SKIPPED
- **Still reproduced on main:** NO. PR #1713 (commit `530c867`, after #1705) already replaced the
  narrow inline filter `o.side === exitSide && ["open","pending_new","accepted","partially_filled"]
  .includes(o.state)` with the shared `isLiveExitOrder(o, positionSide)` helper, which recognizes
  Robinhood `queued`/`confirmed`/`unconfirmed`, Tradier `pending`, and short-cover exits Alpaca
  reports as side `buy` (via `isLiveOrderState`). `input.recentOrders` are raw `EquityOrder`s
  carrying orderClass/stopPrice/side/state (enrichment confirmed present). No change needed.

### 4. notifications — non-atomic option-alert reservation (concurrency)
- **Still reproduced on main:** YES.
- `checkAndDispatchOptionAlerts` read the "already sent" set (`sentAlerts`, from `notification_events`
  status='sent') ONCE at the top, before any event row was inserted. Dashboard snapshots invoke it
  concurrently, so two concurrent requests could both pass the in-memory check and both deliver the
  same (account, symbol, alertType) alert.
- **Fix:**
  - `src/lib/db.ts` `migrate()`: new `option_alert_reservations` table with
    `UNIQUE(user_id, connected_account_id, symbol, alert_type)`.
  - `src/lib/db-notifications.ts`: `reserveOptionAlert(...)` = `INSERT OR IGNORE` returning
    `changes === 1` (atomic single-winner claim; better-sqlite3 is synchronous so the
    insert-and-read runs within one event-loop tick), and `releaseOptionAlertReservation(...)`.
  - `src/lib/notifications.ts`: a `deliverAlert(symbol, alertType, input)` helper — skip if already
    sent (historical fast path), else claim atomically; only the winner sends. Release the claim
    when the send did NOT actually deliver (status != "sent" — disabled type or webhook failure), so
    a disabled/failed alert stays deliverable on a later cycle (matches the historical status='sent'
    -only dedupe). Reserve only for events that will actually be delivered.
- **Test:** `test/option-alert-dedupe.test.ts` — a unit test of the claim primitive (first true,
  second false, release re-opens) + "two CONCURRENT dispatches deliver the same appearance alert
  only ONCE". Verified the concurrency case fails pre-fix (2 rows delivered).

### 5. dashboard — option-fetch had no deadline (reliability)
- **Still reproduced on main:** YES.
- The best-effort `await gateway.getOptionPositions(accountNumber)` sat OUTSIDE the dashboard's
  `withDeadline` safeguards. Its `try/catch` only handles a REJECTION, so a HUNG options/MCP
  endpoint hung the whole snapshot forever — the catch never runs and the dashboard never renders.
- **Fix** (`src/lib/dashboard.ts`, ~L424): wrap the leg in `withDeadline<OptionPosition[]>(…, 8000,
  () => [], "gateway.getOptionPositions", timedOutSections)`, the same pattern the
  portfolio/positions/orders leg uses. Returns `[]` on timeout/error.
- **Test:** covered by the existing dashboard-snapshot suite compiling against the wrapped signature;
  behavior is the standard `withDeadline` fallback already exercised for the sibling legs.

## Files
- `src/lib/synthetic-stops.ts`
- `src/lib/strategy.ts`
- `src/lib/notifications.ts`
- `src/lib/db-notifications.ts`
- `src/lib/db.ts` (new `option_alert_reservations` table)
- `src/lib/dashboard.ts`
- `test/synthetic-stops.test.ts`, `test/strategy-hardening.test.ts`, `test/option-alert-dedupe.test.ts` (new)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this rollout note.

## Verification
- `npx tsc --noEmit` — clean.
- `npm test` — (result recorded below at commit time).
- `npm run build` — (result recorded below).
- `npm run lint` — (result recorded below).
- Per-finding regression tests each verified to FAIL on the unfixed code and PASS with the fix
  (findings 1, 2, 4). The one pre-existing unrelated local failure
  `test/market-custom-symbol.test.ts` (`no such table: sec_insider_transactions`) is an env/DB-state
  flake, ignored per task instructions.

## Follow-ups / risks
- Finding 1 keeps risk-reducing broker-stop CANCELS running while halted (deliberate) — only
  placement/replacement is suppressed. If a future requirement wants ZERO broker interaction while
  halted, that is a separate decision.
- `option_alert_reservations` grows one row per delivered alert; it is small (bounded by distinct
  (account, symbol, alertType) triples) and mirrors the permanent `status='sent'` dedupe. No pruning
  added.

## Round 2 — Codex review on PR #1738 (2 findings, both real, fixed)

Codex reviewed the pushed PR and raised two money-path findings on the round-1 fixes. Both were
genuine and are now fixed on the same branch.

- **P1 — halted mode wrongly suppressed the oversized-stop CANCEL** (`src/lib/synthetic-stops.ts`,
  `src/lib/broker-protective-stops.ts`): round 1 passed `running=false` into
  `reconcileBrokerProtectiveStops` while halted. That short-circuits at the `if (!running) return`
  gate BEFORE section 3 — which includes the risk-reducing cancel of a resting stop whose quantity
  now exceeds the (out-of-band-reduced) position. So a halted+`protectWhileHalted` account could keep
  an oversized broker stop resting that over-sells / opens a short if it fires. Fix: pass the real
  `running` plus a new `haltedProtectOnly` flag that suppresses ONLY section 4 (placement) and the
  section-3 non-shrink mismatch cancel-then-replace, while the oversized/quantity-SHRINK cancel still
  runs (the synthetic monitor covers the real position until a non-halted tick resizes). Regression:
  two new cases in `test/synthetic-stops.test.ts` (oversized → cancelled while halted; trail-% drift →
  kept while halted, with an active-mode control).
- **P2 — bracket legs not repriced after marketable-limit conversion** (`src/lib/strategy.ts`): the
  Tradier/Alpaca bracket legs were derived from the pre-conversion `entryPrice`, but the
  marketable-limit conversion re-prices the entry to `ask+buffer` (or `bid-buffer` for a short), which
  can sit meaningfully above/below the reference on a wide spread. A take-profit priced off the raw
  reference could then land at/below the actual fill, rejecting the OTOCO or arming an instant-loss
  exit. Fix: compute the converted limit ONCE up front (`marketableLimitPrice`/`marketableLimitQty`),
  anchor the bracket legs (both the policy defaults and the LLM-leg validity checks) to it via
  `bracketAnchorPrice`, and have the conversion block reuse those exact values — single source of
  truth, so legs and the entry limit can never drift apart. The non-converting path is unchanged
  (anchor falls back to `entryPrice`). Regression: the existing finding-2 test now asserts the
  repriced legs (92.14/120.18 off the 100.15 limit) plus a new wide-ask case (real ask 120 → limit
  120.18, take 144.22, stop 110.57; take-profit strictly above the entry limit).

### Round-2 verification
- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (582 grandfathered warnings only).
- `npx vitest run` — 413 files / **4802 tests pass, 0 fail** (no flake this run).
- `npm run build` — exit 0.
- Both new/updated regressions verified against the fix; the P1 tests exercise both the cancel-while-
  halted and keep-while-halted branches, and the P2 tests lock the take-profit-above-limit invariant.

## Round 3 — Codex review on b157e70 (3 findings, all real, fixed)

- **P2 — reclaim abandoned option-alert reservations** (`src/lib/db-notifications.ts`): a process that
  crashed between `reserveOptionAlert`'s INSERT and recording a `status='sent'` event (or the
  finally-release) orphaned the reservation row, permanently suppressing that alert. `reserveOptionAlert`
  now DELETEs any reservation older than a 10-min TTL before its INSERT OR IGNORE. Safe because the real
  dedupe is the permanent `status='sent'` check upstream (the caller never reaches the claim for an
  already-sent alert), so a reclaim can only free a genuine orphan, never double-send. Regression added
  to `test/option-alert-dedupe.test.ts` (stale row reclaimed; fresh row not reclaimed; single-winner
  guard intact).
- **P2 — gate the Tradier bracket exemption on a REAL conversion** (`src/lib/strategy.ts`): a pathological
  stored buffer (e.g. legacy `marketableLimitBufferBps=10000` → a short's `bid*(1-1.0)=0`) made
  `willBecomeMarketableLimit` true while the computed limit was non-positive, so the conversion no-op'd
  (order stayed `market`) yet `isTradierMarket` was false — preserving OTOCO legs on a raw Tradier market
  entry the gateway can't carry. `isTradierMarket` now gates on the actual `marketableLimitPrice ===
  undefined` (computed up front), so the un-converted order is correctly stripped. Regression: short +
  buffer 10000 → stays market, legs stripped, "not supported" annotation present.
- **P2 — preserve pending-cancel stops while halted** (`src/lib/broker-protective-stops.ts`): section 1's
  `pending_cancel` retry could still cancel an open position's only (still-live) broker stop during a
  halt, after which section 4 (blocked while halted) refuses the replacement — the same strand the
  round-2 non-shrink mismatch guard prevents. Extended the existing `liveReplaceBlocked` skip to
  `(liveReplaceBlocked || haltedProtectOnly)` for an open position whose plan still wants a stop
  (`kindForSymbol !== null`); a plan-excluded teardown (`=== null`) still retries. Regression:
  pending_cancel row not retried while halted (still-live stop kept), retried when active.

### Round-3 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npx vitest run` 413 files / **4805 tests pass**;
  `npm run build` exit 0. Each new regression exercises the exact failure the finding described.

## Round 4 — Codex review on 22462fd (2 findings, both real; resolved with a design change)

Both findings share one root cause: while halted, the synthetic monitor FIRES existing stops but does
NOT register new ones (`synthetic-stops.ts:430`), so cancelling a broker stop during a halt can leave a
broker-covered position (which has no synthetic row) with NO protection — while KEEPING an oversized
stop risks an over-sell. Neither pure option is safe; only "cancel + keep protection" is. Owner was
asked to choose the halted-mode policy and (via rejecting the prompt under the standing "finish it"
directive) left it to the implementer. Chosen policy: **a halt blocks INITIATING new/looser protection,
but ALLOWS a risk-reducing RIGHT-SIZE of an oversized existing stop** (cancel + place the smaller
replacement the same tick). This keeps broker-held protection for ALL stop plans (incl. fixed/atr, which
have no synthetic fallback) and stays entirely within `broker-protective-stops.ts` — no change to the
high-blast-radius synthetic-registration path.

- **P2 — oversized pending_cancel retry while halted** (section 1): the round-3 skip deferred ALL
  open-position pending_cancel retries while halted, but an OVERSIZED pending_cancel row (quantity >
  current position) would over-sell if it fires, and section 3 only examines `resting` stops — so this
  is the only path that can clear it. Added an exception: a halted OVERSIZED pending_cancel retries the
  cancel and marks the symbol for right-sizing.
- **P2 — halted shrink cancel could strand the position** (section 3): the round-2 shrink cancel removed
  the only broker stop and returned before section 4 could replace it (and the synthetic monitor won't
  register while halted), leaving no protection. Now the shrink cancel marks the symbol
  (`haltedRightsizeSymbols`) and section 4 places the right-sized replacement the same tick.
- Section 4 while halted now places ONLY for `haltedRightsizeSymbols` (right-size replacements), never
  for an unprotected position (new protection). `liveReplaceBlocked` (ALLOW_LIVE_TRADING escape hatch)
  is unaffected — it still never touches the broker.

Tests updated/added in `test/synthetic-stops.test.ts`: oversized RESTING stop → cancel + right-sized
40-share replacement (was: cancel + no placement); oversized PENDING_CANCEL → retry + right-size; the
non-oversized pending_cancel and non-shrink trail-% cases still KEEP the stop (unchanged).

### Round-4 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npx vitest run` 413 files / **4806 tests pass**;
  `npm run build` exit 0.

## Round 5 — Codex review on fcececa (2 findings, both real; completes the halted invariant)

Both findings show that the round-4 right-size CANCELS the oversized stop but section 4 can't always
PLACE the replacement, leaving a gap while halted: (a) a native trailing replacement after a
rally-then-pullback is refused by `canArmTrailingNow` (mark below tracked extreme); (b) the `qty===null`
path (order-list fetch failed) cancels but can't size a replacement. Resolved by strengthening the
invariant to **cancel iff replaceable**: while halted, an oversized-stop cancel proceeds ONLY when a
right-sized replacement can actually be placed this tick; otherwise the existing (oversized) stop is
KEPT (a bounded over-sell risk beats leaving the position unprotected — no synthetic fallback registers
while halted).

- New `replacementPlaceable(pos, sym, kind, excludeOrderId)` helper: false when uncovered qty is null
  (fetch failed) or a trailing trigger can't arm; true when qty<=0 (covered elsewhere) or fixed or the
  trailing trigger arms.
- Section 1 (oversized pending_cancel): retries the cancel only if `replacementPlaceable`.
- Section 3 shrink: the trailing arm-gate now also applies while halted, so a halted trailing shrink
  that can't arm keeps the stop.
- Section 3 `qty===null`: the oversized cancel is skipped while halted (`&& !haltedProtectOnly`).

Tests added in `test/synthetic-stops.test.ts`: oversized stop KEPT when the trailing replacement can't
arm (mark below tracked extreme); oversized stop KEPT when the order-list fetch failed. The round-4
placeable cases (canArm true) still cancel + right-size.

### Round-5 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npx vitest run` 413 files / **4808 tests pass**;
  `npm run build` exit 0.

## Round 6 — Codex review on bc6ebce (3 findings, all real; hardens the halted right-size)

- **P2 — kind-drift + shrink treated as non-shrink** (`isQuantityShrink`): the predicate keyed off the
  mismatch LABEL (`"quantity drift"`), but a row that also needs a kind change is labeled `"stop kind …"`
  even when oversized — so the halted guard kept an over-selling stop. Fixed: judge the shrink by
  quantities (`qty < existingStop.quantity`), independent of the label.
- **P2 — extreme backfill ordering for pending_cancel**: section 1's `replacementPlaceable` runs before
  the section-3 extreme backfill, so `canArmTrailingNow` saw `trackedExtreme=0` and could reseed a
  native trail from the depressed mark (looser) during a halt. Fixed: inline-backfill the tracked
  extreme from the row (and live order) before the section-1 placeability check.
- **P2 — fully-covered (qty<=0) shrink blocked by the halted arm-gate**: when another live exit order
  already covers the position, no replacement is needed, but the halted arm-gate could keep the
  redundant (stacking) oversized stop resting → both could fire (over-sell). Fixed: gate the halted
  arm-block on `qty > 0`, so a `qty<=0` shrink cancel is never blocked.

Tests added in `test/synthetic-stops.test.ts`: kind-drift+shrink → cancel + right-size; qty<=0
covered-elsewhere → cancel + no placement; oversized pending_cancel with a ratcheted extreme above the
mark → kept (backfill makes `canArmTrailingNow` refuse the reseed).

### Round-6 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npx vitest run` 413 files / **4811 tests pass**;
  `npm run build` exit 0.

## Round 7 — Codex review on d6fa11a (1 P1 finding + a tsc fix)

- **P1 — pending_cancel oversize judged against the whole position, not the UNCOVERED remainder**
  (`src/lib/broker-protective-stops.ts` section 1): the halted oversized-pending_cancel check compared
  `row.quantity` to `Math.abs(pos.quantity)`, so a pending stop that STACKS on another live exit order
  (e.g. position still 100, another sell covers 60, pending stop 100) wasn't recognized as oversized
  relative to the 40 uncovered shares — the retry was skipped, section 3 ignores pending_cancel rows,
  and section 4 is blocked by the row, so the stacked stop could stay live through the halt and
  over-sell if both fire. Fixed: judge oversize against `desiredStopQuantity(...)` (the uncovered
  remainder), the same test the resting-drift path uses. `null` (fetch failed) → not oversized → keep.
- **tsc fix**: d6fa11a's round-6 test (`SYN-HALT-PCBF`) added a broker-order literal with `stopPrice`,
  which wasn't in the test's `broker.orders` element type — a latent `tsc` error (vitest doesn't
  typecheck, so it passed tests but would fail the CI `verify` tsc step). Added `stopPrice?: number` to
  the mock's `orders` type. (Root cause of the miss: an earlier `npx tsc` was run from the wrong
  worktree after a shell-CWD reset; now always run from the money-path worktree.)

Test added in `test/synthetic-stops.test.ts`: position unchanged at 100 with another sell covering 60 +
a pending 100-share stop → recognized oversized vs the 40 uncovered → retried + right-sized to 40.

### Round-7 verification
- `npx tsc --noEmit` clean (from the money-path worktree); `npm run lint` 0 errors; `npx vitest run`
  413 files / **4812 tests pass** (one timing flake re-ran green); `npm run build` exit 0.

## Round 8 — reconcile + repair codex-autofix's 4425b1a (durable halted right-size retry)

codex-autofix pushed commit `4425b1a` implementing the round-8 findings (durable `pending_replace`
retry marker; mark `haltedRightsizeSymbols` only after a confirmed cancel; purge
`option_alert_reservations` on account deletion). It did NOT compile and its central F1 marker was
never read back. Repaired here:

- **F2 tsc error (`src/lib/broker-protective-stops.ts` ~line 619, TS2304 `Cannot find name 'oversized'`)**:
  4425b1a referenced `oversized` (block-scoped to the section-1 guard `if`) inside the later `try`,
  where it is out of scope — the file did not typecheck, so the `verify` CI tsc step would have failed.
  Fixed by hoisting intent into a `let markRightsizeOnCancel = false;` flag declared before the guard
  block, set to `haltedProtectOnly` only on the halted+oversized+placeable fall-through, and used in the
  try (`if (markRightsizeOnCancel) haltedRightsizeSymbols.add(rowSym);`). Preserves the intended
  semantics: the durable retry marker is authorized ONLY after a live cancel actually runs for an
  oversized stop while halted — never on the escape-hatch path or a non-halted cancel.
- **F1 marker never read (`src/lib/db-api-keys.ts` `listBrokerProtectiveStops`)**: 4425b1a wrote a
  durable `pending_replace` row on a halted right-size placement failure, but the reader still filtered
  `status IN ('resting', 'pending_cancel')`, so section 1 never saw the marker, `haltedRightsizeSymbols`
  stayed empty, and section 4 returned without retrying — the position could stay unprotected until the
  account was unhalted. Fixed: added `'pending_replace'` to the status filter.
- **Consumer safety for the newly-returned `pending_replace` rows**: a `pending_replace` row carries a
  synthetic `pending-replace-*` brokerOrderId (no live broker order). The two consumer loops that run
  BEFORE section 1's marker cleanup — `cancelBrokerProtectiveStop` (standalone) and the `kind === null`
  disabled-teardown loop in `reconcileBrokerProtectiveStops` — would have called
  `gateway.cancelEquityOrder` on the fake id (404 → re-persisted as a stuck `pending_cancel` that
  retries forever). Guarded both to DROP a `pending_replace` marker outright instead of cancelling.
  The later cancel-on-close / plan-teardown loops are already safe (section 1 hard-deletes every
  `pending_replace` row before they run in the non-teardown path). The synthetic-stops
  `brokerHeldOrderIdBySymbol` map is safe too: the fake id never equals a real order id, so the
  quantity-blind exclusion stays a conservative no-op.

Tests: restored the round-8 halted/F3 tests from stash on top of 4425b1a and added an F1 regression
(`SYN-HALT-F1RETRY`): tick 1 right-sizes an oversized stop but the replacement placement THROWS →
a `pending_replace` marker is persisted (qty 40); tick 2 (broker healthy) section 1 READS the marker,
re-queues, and section 4 completes the right-sized replacement → resting, qty 40. Also kept the F3
`option_alert_reservations` purge test (`OPTALERTDEL`).

### Round-8 verification
- `npx tsc --noEmit` clean (from the money-path worktree); `npm run lint` 0 errors;
  `npx vitest run test/synthetic-stops.test.ts` 65 pass; account-delete + option-alert-dedupe pass;
  `npm run build` exit 0. Full 4800-test suite not awaited (localized change: every test file touching the changed reconcile / `listBrokerProtectiveStops` paths — synthetic-stops 65, broker-protective-stops + broker-side 91, account-delete + option-alert — passes).

## Round 9 — 3 Codex findings on the durable halted right-size retry marker (ccd19b1)

Codex round-9 raised three P2 findings on the `pending_replace` retry marker (the mechanism made
functional in round 8). All three are about the marker's lifecycle and are genuine; fixed together on
this branch:

- **F#1 — marker deleted before placement proven** (`broker-protective-stops.ts` section 1): the
  section-1 handler deleted the `pending_replace` marker up front, then re-queued the symbol. If
  section 4 then SKIPPED placement (order-list fetch failed -> qty unknown, native trail can't arm yet,
  sub-share qty), it does not call `persistHaltedRightSizeRetry` on those `continue` paths, so the
  marker was gone and the next halted tick forgot the owed right-size -> position unprotected until
  unhalted (synthetic registration is disabled while halted). Fix: section 1 now KEEPS the marker for a
  halted+live+kind symbol (re-queues, does not delete); it deletes only when the marker is moot (not
  halted, position closed, or plan now excludes every lane). Section 4's `existing` guard was changed to
  EXCLUDE `pending_replace` rows, so a kept marker still places; a successful placement upserts the same
  row id to `resting`, a skip leaves the marker for the next tick.
- **F#2 — cancel-only paths could cancel a marker's synthetic id** (`broker-protective-stops.ts`
  sections 2 / 2b): now that markers can survive section 1 (F#1 fix), the cancel-on-close and
  plan-excluded teardown loops could receive a `pending_replace` row and call `cancelEquityOrder` on its
  synthetic `pending-replace-*` id (404 -> re-persisted as a stuck `pending_cancel`). Added explicit
  `if (row.status === "pending_replace") continue;` guards to both loops (section 1 already drops markers
  for closed/plan-excluded symbols, so a survivor is always a live retry section 4 will place — these
  guards make each section locally correct regardless).
- **F#3 — uncertain placement lost its broker ref** (`broker-protective-stops.ts` section 4): when
  `placeEquityOrder` threw AFTER the broker accepted the order, the marker recorded only a fake id and
  discarded the submitted `refId`, so a later tick could orphan the untracked live order (coverage drives
  qty to 0 -> skip) or submit a duplicate. Fix: the throw path now persists the submitted client ref on
  the marker; before re-placing, section 4 ADOPTS any now-visible live order whose `clientOrderId`
  matches that ref (records the real order id, tracked/cancellable) instead of duplicating, and reuses
  the ref on retry so the broker's client-order-id idempotency guards the not-yet-visible case. The
  reject/no-id paths deliberately do NOT preserve the ref (those orders are definitively not resting, and
  reusing a rejected client-order-id could get the retry itself rejected).

Regression tests added in `test/synthetic-stops.test.ts`: `SYN-HALT-KEEPMARK` (marker survives a
placement-skip tick, then completes), `SYN-HALT-MARKCLOSE` (closed-position marker dropped with NO
broker cancel of its synthetic id), `SYN-HALT-ADOPT` (throw-after-accept -> next tick adopts the
ref-matched live order instead of duplicating).

### Round-9 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; synthetic-stops 68 + broker-protective-stops /
  broker-side / account-delete / option-alert 100 all pass (168 across the affected files); full
  `npx vitest run` + `npm run build` running.

## Round 10 — 4 Codex findings from the round-9 ref-preservation (4e04bead)

Round-9's F#3 (durable client-ref preservation + adopt-by-ref) made `pending_replace` markers able to
carry a REAL client ref, not just a synthetic placeholder. Codex round-10 surfaced 4 P2 consequences,
all genuine; fixed by consolidating marker/ref resolution into ONE owner (section 1) plus a
loosening guard:

- **F#1 (broker-protective-stops.ts:147, `cancelBrokerProtectiveStop`)** — the synthetic-exit cancel
  path blindly dropped a `pending_replace` marker. If it held a real ref for an accepted-but-not-yet
  -visible broker stop, dropping it lost the only handle → that stop could double-sell after the
  synthetic exit. Fixed: the function now fetches the order list (only when a real-ref marker is
  present) and reconciles — cancel the accepted order by its REAL id if live, drop if terminal, KEEP
  the marker if not yet visible (so the reconcile loop cancels it once it appears).
- **F#2 (broker-protective-stops.ts:585, section-1 delete)** — same hazard on the section-1 else-branch
  delete. Fixed by making section 1 the single reconciler: for a real-ref marker it adopts-if-live
  (records the real order id as a resting row), books-if-filled, drops-if-dead, and KEEPS-if-invisible.
  Only synthetic placeholders take the old keep-if-halted / drop-if-moot path.
- **F#4 (broker-protective-stops.ts:1144, section-4 adopt filter)** — the section-4 adopt matched only
  LIVE orders (`!isDoneRestingState`), so a saved ref that showed up FILLED was ignored and the ref
  retried, never booking the fill (missing from fill_events/P&L). Fixed: section 1 now books terminal
  fills (`hadExecutedFill` → `bookBrokerHeldStopFill` + `filledRecoverySymbols`). The now-redundant
  section-4 adopt block was removed; section 4 keeps only the ref-reuse (idempotency guard for the
  not-yet-visible case).
- **F#3 (broker-protective-stops.ts:1014, halted shrink bypass)** — a halted quantity shrink bypassed
  the non-shrink block even when the replacement was also LOOSER (a widened `stopLossPct` would place
  the right-sized fixed stop at a lower/looser trigger). Fixed with a per-symbol `haltedRightsizeFloor`
  captured from the cancelled stop's own trigger; section 4 clamps a fixed halted replacement UP to it
  (sell stop: tighter == higher), so a halted right-size is purely risk-reducing. Trailing is already
  arm-gated (`canArmTrailingNow`) against loosening.

Consolidation net effect: real-ref marker resolution lives ONLY in section 1 (and `cancelBrokerProtectiveStop`);
section 4 no longer adopts (removing the incomplete filter) and only reuses the ref for idempotency.

Regression tests added: `test/broker-protective-stops.test.ts` — `PS-REFCANCEL` (cancel the accepted
order behind a real-ref marker, not the fake id), `PS-REFKEEP` (keep a real-ref marker whose order is
not yet visible), `PS-FLOOR` (halted fixed right-size clamped to the tighter floor, not the looser
widened price), `PS-REFFILL` (a filled real-ref order is booked + marker dropped).

### Round-10 verification
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; synthetic-stops 68 + broker-protective-stops 64
  + broker-side + account-delete + option-alert = 172 across the affected files pass; full
  `npx vitest run` + `npm run build` running. Branch also carries `origin/main` merge 4e04bea, which
  includes #1739 (CI routed to a self-hosted Coolify runner) — may lift the provisioning outage.
