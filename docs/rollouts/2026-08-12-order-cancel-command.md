# 2026-08-12 — Mobile `order.cancel` command (server side)

## 1. Context & Objective

The iOS parity panel called open orders "the only see-but-can't-act money surface" on the phone:
`/api/mobile/snapshot` already returns the working-order list (filtered by `isWorkingOrderState`),
but there was no mobile command that could act on one.  A rotting limit order could be watched from
the phone and only killed from the desktop console.  This is the SERVER half of roadmap item #3 —
cancel only.  No iOS files are touched here (a parallel agent owns those).

## 2. Changes Made

**One cancel implementation, two front doors.**  The console's cancel logic lived entirely inside
the route handler, so wiring a mobile command to `gateway.cancelEquityOrder` directly would have
created a second cancel that drifts from the lease receipt, the cancel-dust advisory, the audit
trail, and the dashboard event.  Instead the route body was extracted verbatim into a lib module
that both callers now run.

- **`src/lib/order-cancel.ts` (new).**  `cancelWorkingOrder({ userId, orderId,
  expectedAccountNumber?, requireWorkingOrder?, source? })` → `ExecutedOrder & { dustWarning?,
  symbol? }`, plus `OrderCancelPreconditionError { status }`.  Carries over unchanged: the
  no-wait-on-the-mutation-lease doctrine with its `broker_mutation_cancel_during_lease` receipt,
  the 2 500 ms time-bounded advisory pre-read, `order_cancel_dust_risk`, the `order_cancel` audit,
  the `dashboard.order` event, and the dust notification.  New: the `expectedAccountNumber`
  scoping check and the optional `requireWorkingOrder` resolution.
- **`app/api/orders/cancel/route.ts`.**  Now the HTTP shell only — auth, rate limit, and mapping
  `OrderCancelPreconditionError.status` onto the same 400 responses it returned before.  Console
  behaviour is unchanged (it does not pass `requireWorkingOrder`).
- **`src/lib/mobile-api.ts`.**  `"order.cancel"` added to `MOBILE_COMMAND_TYPES`, validated payload
  `{ orderId: string; accountNumber?: string }`, executor case calling `cancelWorkingOrder` with
  `requireWorkingOrder: true` and `source: "mobile"`.  Added to `IMMEDIATE_MOBILE_COMMAND_TYPES`
  and deliberately NOT to `IMMEDIATE_PROTECTIVE_COMMAND_TYPES` (see below).  `requireString` grew
  an optional max-length argument.
- **`test/mobile-order-cancel.test.ts` (new).**  9 tests.

## 3. Decisions & Trade-offs

**Immediate, but not protective.**  `IMMEDIATE_PROTECTIVE_COMMAND_TYPES` does two distinct things:
it puts a command in `IMMEDIATE_MOBILE_COMMAND_TYPES` (runs in-request instead of behind the global
sequential worker), and on success it runs `cancelQueuedRiskIncreasingCommands`, cancelling that
user's queued `strategy.run_once` / `strategy.start` / `proposal.approve`.  The first behaviour is
exactly what a phone cancel needs — killing a rotting limit is worthless if it lands after a
30-minute run drains.  The second is the wrong blast radius: an operator cancelling one stale AAPL
limit did not ask to also drop a queued approval on an unrelated symbol, and the cancellation
reason string ("… took immediate effect") describes a system-wide containment state, which this is
not.  So `order.cancel` takes the same seat as `account.activate`: in the immediate set, out of the
protective set.  A test asserts both memberships and a further test asserts a queued
`strategy.run_once` survives a successful cancel.

**No typed confirmation, and no new ceremony.**  Cancelling is risk-REDUCING.  The console route
has never required typed confirmation (only `replace-market` does, because it opens live risk), and
the mobile command matches it exactly.

**Account isolation is structural, not a check that can be skipped.**  Every cancel resolves the
policy for the requesting `userId`, uses that policy's `accountNumber`, and goes through a gateway
built from that user's own stored broker credentials.  There is no code path where a caller-supplied
account or order id can redirect it.  Two additional guards sit on top:
1. `expectedAccountNumber` — when the client names the account it thought it was looking at, a
   mismatch is refused (409) and receipted as `order_cancel_account_mismatch` before any broker
   I/O.  This is the stale-view guard: a phone that queued a cancel while viewing account A and
   then switched to B must not have its cancel land on B.
2. `requireWorkingOrder` — the mobile lane resolves the order inside the selected account first and
   refuses (404 / 409) when it is absent or no longer working.

**Why `requireWorkingOrder` is mobile-only.**  The advisory pre-read is time-bounded precisely
because a cancel must never wait behind a hung broker read; making refusal depend on it would put
the emergency lever behind a network call.  So it fails OPEN — when the read times out or throws,
nothing was learned, an `order_cancel_precheck_unavailable` receipt is written, and the cancel
proceeds.  Isolation is unaffected (see above).  The console keeps the unconditional behaviour it
has always had: its sheet renders only live rows from the account currently on screen, whereas a
mobile failure is read as text on a phone minutes later and has to say something true rather than
surfacing a raw broker 404.

**Not done: replace-at-market.**  Deliberately out of scope.  `POST /api/orders/replace-market`
(`src/lib/order-replacement.ts`) is a durable state machine over the `order_replacements` table with
cancel-settle polling, a live pre-flight, a `MarketReplaceConfirmation` typed-text contract
(`REPLACE LIVE <SYMBOL>`), and a mutation-lease fence around the placement half.  Bringing it to
mobile would additionally require: a mobile command carrying the typed-confirmation payload and a
`MobileCommandValidationError`-style 409 surface for `live_confirmation_required` (the
`proposal.approve` `LiveApprovalConfirmationError` path is the model), a redaction rule in
`redactPayloadForResponse` so the typed text never echoes back, a decision about whether a
multi-second cancel-settle poll may run on the immediate in-request path or must stay queued, and
a `pending_cancel` result state the phone can render honestly.

## 4. Verification State

Run in `~/apps/trading-monet-cancel` with `PATH="/opt/homebrew/opt/node@24/bin:$PATH"`:

```
npm install
npx tsc --noEmit                                   # clean
npx vitest run test/mobile-order-cancel.test.ts    # 9/9 pass
npx vitest run test/orders-cancel-dust-risk-route.test.ts test/account-mutation.test.ts \
  test/mobile-api.test.ts test/mobile-stop-preemption.test.ts \
  test/stale-mobile-commands.test.ts test/mobile-view-scope.test.ts   # 37/37 pass
npx vitest run                                     # full suite — see below
```

The three pre-existing cancel-route tests and the `account-mutation` lease-interleave test pass
unchanged against the extracted module, which is the evidence that the refactor is behaviour
preserving for the console.

## 5. Next Steps & Blockers

- iOS client work (a cancel affordance on the open-orders surface, posting `order.cancel` with
  `{ orderId, accountNumber }`) is owned by a parallel agent — not touched here.
- Replace-at-market remains open; see the requirement list in section 3.
- No credential, key, or infrastructure action is required for this change.
