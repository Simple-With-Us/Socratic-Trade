# 2026-07-10 — Order-status reconciliation: kill the perpetual "verify with broker" alert

Branch: `claude/order-status-reconcile` (order-status-reconcile workflow, CLAUDE)

## Summary

Placement errors no longer leave an order "always uncertain." When a broker
`placeEquityOrder` call THROWS, both placement paths now ask the broker what
actually happened — via the existing `refId → client_order_id/ref_id`
idempotency key — and map the result to a DEFINITE proposal status instead of
immediately firing a permanent, un-clearable "verify with broker" alert.

## Why

Confirmed root cause (three gaps, all verified in code):

1. **No inline reconciliation.** Both catch blocks — autonomous run loop
   (`strategy.ts`) and human-approval path (`executeProposal`) — on a thrown
   `placeError` set status `placing_failed`, fired a permanent
   `run_failed` "…placement uncertain — verify with broker" notification, and
   moved on. Neither queried the broker.
2. **The alert was un-clearable and never resolved on recovery.**
   `isBrokerVerificationRunFailed` marked any such row non-sweepable, and nothing
   acked it when the order later reconciled (sweep recovery or a normal fill). A
   fully placed-and-filled order left a permanent alert.
3. **The catch set `placing_failed`, but the stale sweep filters
   `status = 'placing'`** (`listStalePlacingProposals`). So an inline-thrown row
   was never reconciled by the sweep at all — the transient-throw case had *no*
   reconciliation path, which is exactly why the alert was perpetual.

The old comments claiming the `client_order_id` plumbing was "a follow-up / we
can't yet auto-match" were stale — the plumbing already exists
(`EquityOrder.clientOrderId`, populated by both broker adapters) and the sweep
already used it. Comments corrected.

## What changed

- **New shared helper `reconcilePlacementError(...)`** (`src/lib/strategy.ts`,
  exported) called from both placement catches. Broker-truth-first, mirroring the
  sweep's matching:
  - `getEquityOrders` throws → `uncertain` (broker unreachable — the ONLY
    genuinely-unknown case).
  - no order carries our `refId` → `not_placed` (order never reached the matching
    engine; safe to retry).
  - order present + terminal-declined (`isRejectedOrCanceledState`) → `declined`.
  - order present + live/filled → `placed` (books the fill here, deduped on
    `(proposalId, brokerOrderId)`; a booking error degrades to `uncertain` so the
    intent + alert are never dropped).
- **Caller mapping** in both catches maps each outcome to a definite status +
  a distinctly-toned notification carrying a `payload.reconcile` discriminator
  (`recovered` / `declined` / `not_placed` / `uncertain`):
  - placed → status `placed`, `type:"fill"` (recovered) notification, prior
    uncertain alert resolved, dashboard event.
  - declined → status `rejected_by_broker`, decline notification.
  - not_placed → **new status `not_placed`**, sweepable "was NOT placed — safe to
    retry" notification.
  - uncertain → status kept **`placing`** (not `placing_failed`) so
    `flagStalePlacingIntents` retries next run; protected "verify with broker"
    alert. This is now the ONLY path that produces a perpetual-until-confirmed
    alert, and only when the broker is truly unreachable.
- **New status `not_placed`** added to `FEED_STATUS_LABELS` ("Not placed - safe to
  retry") in `src/lib/dashboard-ui.ts`. `status` is free-form (`string`); no
  exhaustive switch consumes it.
- **`resolveBrokerVerificationNotifications(userId, {proposalId?, refId?,
  resolution})`** (`src/lib/db-notifications.ts`, re-exported via the `db` barrel):
  surgically acks the uncertain alert for a now-confirmed proposal/order (matched
  by the exact UUIDs; only `reconcile:"uncertain"` or legacy-title rows; never a
  `declined` row). Called from (a) both inline `placed` branches, (b) the sweep's
  recovery branch — the primary fix for "even reconciled orders stay uncertain",
  and (c) `reconcilePendingFills` when a live order reaches `filled`.
- **`isBrokerVerificationRunFailed` is now reconcile-marker-driven** (drops the
  blanket "has proposalId/orderId ⇒ protected" short-circuit that would wrongly
  protect the new sweepable `not_placed` alert). `uncertain`/`declined` stay
  protected; `not_placed`/`placed`/`recovered` are sweepable; legacy rows (no
  marker) fall back to the enumerated title text. Stale doc-comment line numbers
  fixed.
- **Idempotency (two layers).** Layer A: status gate — the sweep only reads
  `status='placing'`, and inline leaves `placing` only when it booked nothing.
  Layer B: `(proposalId, brokerOrderId)` dedupe guard added to BOTH the inline
  `placed` booking and the sweep's matched branch (the sweep previously booked
  unconditionally), covering the crash window where a fill was inserted but the
  status flip didn't persist.

## Files

- `src/lib/strategy.ts` — `reconcilePlacementError` helper (new, exported); both
  placement catches rewritten; `flagStalePlacingIntents` dedupe guard + recovery
  resolution + exported for tests; `reconcilePendingFills` filled-branch
  resolution; stale sweep doc-comment corrected; `FillEvent` +
  `listFillEventsByProposalId` + `resolveBrokerVerificationNotifications` imports.
- `src/lib/db-notifications.ts` — `resolveBrokerVerificationNotifications` (new);
  `isBrokerVerificationRunFailed` refined + doc-comment corrected; `audit` import.
- `src/lib/dashboard-ui.ts` — `not_placed` label.
- `test/placement-reconcile.test.ts` (new, 5 e2e via `executeProposal`).
- `test/placement-reconcile-sweep.test.ts` (new, 4 — sweep idempotency +
  resolution).
- `test/notification-lifecycle.test.ts` (+5 — resolution + reconcile-marker
  sweepability, incl. legacy back-compat).
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification

Run in the worktree (node_modules built for node26/ABI 147, so gates ran under
the default `node v26.5.0`; `npx tsc --noEmit` also run under node@24):

- `npx tsc --noEmit` — clean (0 errors).
- `npm test` — **3408/3408 passed** (317 files).
- `npm run lint` — 0 errors (376 grandfathered warnings).
- `npm run build` — success (exit 0, full route manifest).

## Money-path invariants

- No change to Alpaca/Robinhood placement or the idempotency keys (they work).
- A fill for a given `proposalId` is booked by exactly one of {inline, sweep}
  (status gate + dedupe guard).
- Status `placed` / a booked fill is produced ONLY when a broker order whose
  `clientOrderId === refId` exists and is not terminal-declined. Missing ⇒
  `not_placed`; declined ⇒ `rejected_by_broker`; never a phantom "placed".
- The durable `placing` intent + protected uncertain alert are emitted ONLY when
  `getEquityOrders` throws (broker truly unreachable).
- Resolution is surgical (exact UUID match, uncertain-marked only) and
  account/user-scoped.

## Follow-ups / risks

- Robinhood MCP occasionally returns orders without `ref_id`; a genuinely-placed
  order lacking `clientOrderId` would be classed `not_placed` (false "safe to
  retry"). This is the SAME limitation the existing sweep already had — not a
  regression. A secondary fuzzy key `(symbol, side, qty, createdAt≈)` was
  deliberately NOT added: a false-positive match would book a phantom fill
  (violates MP-2). Left as a future follow-up.
- HEADS-UP: `claude/tradier-broker` also touches `strategy.ts` (broker-union
  switch cases — a different region than the placement catches here). If a
  merge-forward conflicts, keep both sets of changes.

## Fixups from adversarial review (2026-07-10, same branch)

An adversarial money-path review of the reconcile fix above surfaced four
findings. All four are fixed on this branch; each has a dedicated regression
test. No change to the Alpaca/Robinhood placement calls or the idempotency keys.

### (1) [HIGH] Robinhood `getEquityOrders` masked broker errors as an empty list

`getEquityOrders` coalesced anything without an `orders`/`results` array to `[]`,
and `callRobinhoodMcpMethod` only threw on a JSON-RPC `error` / HTTP non-2xx —
never on a **tool-level `isError: true`** result. So a broker-side failure
(rate limit, auth lapse, upstream 5xx surfaced by the MCP proxy) returned `[]`,
which `reconcilePlacementError` reads as "the broker has no such order ⇒
`not_placed` (safe to retry)". A genuinely placed/filled order could be marked
`not_placed`, drop its durable `placing` intent, never book its fill, and be
DUPLICATED next run.

Root fix (`src/lib/robinhood.ts`):
- `unpackMcpToolResult` now THROWS on a tool-level `isError: true` (surfacing the
  content text) — every `tools/call` funnels through it, so `get_equity_orders`
  (and every other RH tool) can no longer silently unwrap an error payload.
- New `extractRobinhoodOrderCollection(raw)` replaces the inline coalesce: an
  array or an object carrying an `orders`/`results` array is an AUTHORITATIVE list
  (empty `[]` = a real "no orders" account); anything else THROWS
  (`unrecognized shape … treating as an error, not an empty account`). After this,
  `[]` from `getEquityOrders` means the broker authoritatively returned no orders.
- Every existing caller already tolerated `getEquityOrders` rejecting (it always
  could, on HTTP/JSON-RPC errors), so this widens *which* responses throw without
  introducing a new crash surface (`reconcilePlacementError` / `flagStalePlacingIntents`
  / `reconcilePendingFills` all catch it → `uncertain`/skip; `synthetic-stops`
  falls back to protection-over-dedup).

Test: `test/robinhood-orders-error-throws.test.ts` — isError → throws; malformed
success → throws; `{ results: [] }` → `[]`; populated → mapped orders.

### (2) [HIGH] Sweep booked a fill for a matched-but-DECLINED order

`flagStalePlacingIntents`' matched branch booked a fill, marked the proposal
`placed`, and cleared the uncertain alert for ANY matched broker order — it
lacked the `isRejectedOrCanceledState(matched.state)` guard that
`reconcilePlacementError` (`declined`) and `reconcilePendingFills` both have. A
stale `placing` intent whose broker order was rejected/canceled would book a
phantom fill and falsely report "placed".

Fix (`src/lib/strategy.ts`): a matched order in a terminal-decline state now marks
the proposal `rejected_by_broker`, books NO fill, and does NOT clear the uncertain
alert as "placed" (a declined order is a standing fact). Mirrors the inline and
pending-fill decline handling exactly.

Test: `test/placement-reconcile-sweep.test.ts` — matched-declined → status
`rejected_by_broker`, zero fills, uncertain alert left unacked.

### (3) [MEDIUM] `not_placed` could be concluded from a non-authoritative list

A placement that threw on a lost ack but was actually ACCEPTED (then filled and
aged out of a live-only order list) could be misclassified `not_placed`
(sweepable/self-clearing) rather than the protected `uncertain` alert. `not_placed`
is only safe when the broker's order list authoritatively includes recently-terminal
orders.

Fix: new optional `BrokerGateway.ordersListIncludesTerminal` capability.
- **Alpaca** sets it `true` — `getEquityOrders` pages `status:"all"`, so the list
  includes filled/canceled/rejected/expired orders (verified in `alpaca.ts`).
- **Robinhood** leaves it unset (⇒ conservative/false): its `get_equity_orders`
  terminal-inclusion window can't be verified without a live token, so we treat
  absent-from-list as `uncertain`, not `not_placed`.
- `reconcilePlacementError` only returns `not_placed` when
  `ordersListIncludesTerminal === true`; otherwise `uncertain` (keep `placing` +
  protected alert). The stale sweep's absent branch is gated the SAME way (absent
  + non-authoritative ⇒ keep `placing`, don't abandon) so the sweep can't silently
  undo the inline conservatism 2 minutes later.

Conservative classification made without a live token: **Robinhood
`get_equity_orders` terminal-order inclusion is unverified**, so Robinhood is
treated as non-authoritative — an absent order stays `uncertain`/`placing`
(human verifies) rather than `not_placed`. Flip `ordersListIncludesTerminal` to
`true` on `HttpMcpRobinhoodGateway` only once verified against a live account.

Tests: `test/placement-reconcile.test.ts` (inline: non-authoritative + absent →
stays `placing` + uncertain, NOT `not_placed`) and
`test/placement-reconcile-sweep.test.ts` (authoritative absent → `placing_failed`;
non-authoritative absent → stays `placing`).

### (4) [LOW] Durable double-fill backstop (DB UNIQUE index)

Added migration **v16** (`db.ts` `MIGRATIONS`): a **partial** UNIQUE index
`idx_fill_events_proposal_broker_order` on `fill_events (proposal_id,
broker_order_id) WHERE proposal_id IS NOT NULL AND broker_order_id IS NOT NULL`.
The migration first collapses any pre-existing duplicate `(proposal_id,
broker_order_id)` rows (keep earliest by rowid, delete the rest, logged loudly) so
the index can't fail to build on legacy double-books — a duplicate for the same
physical order is a double-count bug, so collapsing it is the intended consistency
fix. Partial-on-non-null so the many legitimate NULL-column rows (pre-placement /
paper / non-broker fills) are never constrained.

`insertFillEvent` (`db-fills.ts`) now catches the unique-constraint violation and
returns the already-booked fill (idempotent no-op) instead of throwing or
double-booking — a last-resort backstop under the existing single-process dedupe
guards, covering the concurrent-process case they can't.

Test: `test/fill-events-dedupe-index.test.ts` — second insert of same
`(proposalId, brokerOrderId)` → one row, returns the first fill; different
brokerOrderIds coexist; NULL broker_order_id rows are unconstrained.

## Fixups verification

- `npx tsc --noEmit` — clean.
- `npm test` (vitest) — 3424 passed / 319 files (was 3408; +16 across the four new
  test files + the added sweep/inline cases).
- `npm run lint` — 0 errors (pre-existing grandfathered warnings only).
- `npm run build` — Next.js production build OK.
- NODE NOTE: the shared `node_modules` `better-sqlite3` is currently built for
  Node 26 (the homebrew default). Gates were run under Node 26; forcing
  `node@24` on PATH hits the reverse ABI mismatch (`NODE_MODULE_VERSION 147 vs
  137`). Run gates under the node the shared native module matches; do NOT rebuild
  the shared module for node24 (it would break concurrent node26 sessions).

## Fixups files touched

- `src/lib/robinhood.ts` — isError throw in `unpackMcpToolResult`;
  `extractRobinhoodOrderCollection`; `ordersListIncludesTerminal` unset (RH,
  documented) / `true` (TestBroker).
- `src/lib/alpaca.ts` — `ordersListIncludesTerminal = true`.
- `src/lib/types.ts` — `BrokerGateway.ordersListIncludesTerminal?`.
- `src/lib/strategy.ts` — `reconcilePlacementError` not_placed gate;
  `flagStalePlacingIntents` decline guard + non-authoritative absent gate.
- `src/lib/db.ts` — migration v16 (dedupe + partial unique index).
- `src/lib/db-fills.ts` — `insertFillEvent` idempotent no-op on unique conflict.
- `test/robinhood-orders-error-throws.test.ts` (new),
  `test/fill-events-dedupe-index.test.ts` (new),
  `test/placement-reconcile.test.ts` (+1 case),
  `test/placement-reconcile-sweep.test.ts` (+3 cases).
