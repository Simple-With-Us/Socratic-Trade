# 2026-08-02 — §7 slice 2: declarative per-broker order-type constraint validation

**Agent:** MONET · branch `monet/broker-order-constraints` (off `origin/main` @ `44069368`)

## 1. Context & Objective

Order-state hardening program (docs/oss-lessons.md §4/§7), slice 2 of 4 — Lean's
"brokerage models as data" discipline: each broker's order-shape constraints encoded
declaratively and validated BEFORE submission, with a unit test per constraint, instead of
being learned one production 422 at a time. Slice 1 (status conformance tables, PR #2335)
established the pattern.

The motivating incident was still LIVE at implementation time (found by the pre-work
exploration sweep): Alpaca 422 "bracket orders must be entry orders" on a T sell
(docs/rollouts/2026-07-27-pending-orders-done-for-day.md, follow-up never closed) —
`alpaca.ts` computes `isBracket` with no side check, `enrichOpeningProposal` early-returns
for exits, and `sanitizeProposals` carries bracket fields for any side, so an exit proposal
could reach the adapter wearing bracket legs and be rejected by the broker.

## 2. Changes Made

- **`src/lib/broker-order-constraints.ts` (new)** — the constraint tables.
  `BROKER_ORDER_CONSTRAINTS: Record<ConstraintBrokerId, OrderConstraintRow[]>` with
  `ConstraintBrokerId = alpaca | robinhood | tradier | test` (alpaca-mcp folds into alpaca;
  test is deliberately constraint-free). Each row: stable id, the broker rule, a mandatory
  receipt note (incident/adapter/doc it encodes), and a remedy:
  - `reshape` — intent is valid but carries fields the broker would reject or silently
    drop; produces a corrected copy + receipt. Never blocks an exit over decorative legs.
  - `block` — the order cannot be honestly expressed on this broker; throws
    `OrderValidationError` (strategy/approval lanes already classify that as `blocked`).

  Rows: alpaca bracket-legs-entry-only (reshape — THE T fix), trailing-excludes-brackets
  (block), trailing-requires-share-quantity (block), stop-price-only-on-stop-orders
  (reshape), extended-hours-limit-only (block); robinhood no-short-selling (block, promotes
  `toMcpOrder`'s plain Error to a pre-submission `OrderValidationError`),
  no-native-trailing (block), no-bracket-legs (reshape — previously silently ignored);
  tradier no-native-trailing (block — `tradier.ts` has ZERO trailPercent handling, the
  field would be silently dropped leaving a believed-trailing order untrailed; production
  never routes trailing there because `broker-protective-stops`' `nativeTrailing` is
  alpaca-only, this row makes that invariant structural), bracket-legs-require-limitable-
  entry (reshape, mirrors the adapter's silent fallthrough).

- **`src/lib/broker.ts`** — `withOrderConstraints(gateway, policy, userId)` Proxy on
  `placeEquityOrder` only (cancels stay unguarded — risk-reducing), composed in
  `getBrokerGateway` INSIDE `withLivePreflight` (preflight authorizes, then constraints
  validate/reshape, then the adapter's own checks run as defense in depth). Applies in
  EVERY environment — the T incident was on Alpaca Paper. Each reshape is audited as
  `order_constraint_reshaped` ({broker, constraintId, description, changedFields, symbol,
  side, type, refId}).

- **`test/broker-order-constraints.test.ts` (new, 42 tests)** — slice-1-style rigor:
  fixture-coverage test (every row must have violating+passing fixtures, both directions),
  per-row behavior (block throws `OrderValidationError` / reshape satisfies its own
  constraint + receipts), input-purity (never mutates the caller's object), the T
  regression suite (sell and cover shed legs; buy AND short keep them; reshape chaining
  with two receipts), and choke-point wrapper tests with a stub gateway (reshape before
  adapter + refId preserved + audit row written; robinhood short blocked with adapter
  untouched; test broker passes wild shapes; cancels uninstrumented).

## 3. Decisions & Trade-offs

- **Reshape vs block chosen per row by risk direction.** Blocking an EXIT is itself a risk
  (position stays open); stripping meaningless legs is not. Blocking is reserved for
  shapes with no honest encoding (notional trailing on Alpaca, any trailing on
  Robinhood/Tradier, shorts on Robinhood, non-limit extended-hours on Alpaca).
- **Only receipted rules.** Every row cites the incident, adapter check, or documented
  broker rule it encodes — a guessed constraint could block real orders. The table header
  makes this a standing requirement for future rows.
- **Adapter checks stay** (defense in depth); some rows deliberately duplicate them with
  identical messages, pinned by tests.
- **Fail-open for unknown brokers** at the wrapper (unreachable today — `resolveGateway`
  throws first): the table not knowing a broker must not invent a block.
- **Market-data-dependent rules excluded** (e.g. Alpaca bracket dollar-order sizing):
  the table is pure by design; those stay in the adapters where quotes exist.

## 4. Verification State

- `npx tsc --noEmit` clean; `npx eslint` on all three files clean (Node 24 prefix).
- `npx vitest run test/broker-order-constraints.test.ts` — 42/42 pass.
- Adversarial review workflow (money-path lens enumerating all 5 production placement
  lanes; wiring lens; table-truth lens vs the real adapters; 13 agents, per-finding
  refutation): **6 findings confirmed, 4 refuted, all 6 fixed before landing:**
  1. (MEDIUM) The extended-hours row blocked LLM-producible shapes that previously
     EXECUTED on the alpaca-mcp transport (MCP silently drops the flag; REST 422'd).
     Fixed by splitting the row: sell/cover non-limit extended → **reshape** to
     regular_hours with receipt (the shape's only honest encoding — and exactly what MCP
     did); buy/short → keep **block**, deliberately fail-closed for entries
     (**owner heads-up:** on alpaca-mcp accounts with permitExtendedHours on, a market
     entry tagged extended_hours used to silently execute at the open; it is now blocked
     pre-submission with an honest message — say the word and the entry row flips to the
     same requeue-reshape).
  2. (MEDIUM ×2, one per lens) The approval lane did NOT classify OrderValidationError as
     "blocked" — a deterministic constraint block would loop through
     reconcilePlacementError and read "not_placed — safe to retry" forever. Fixed:
     `strategy-execution.ts` now short-circuits `instanceof OrderValidationError` →
     status "blocked" + `order_blocked_validation` audit + "block" notification,
     mirroring the autonomous lane and the lane's own protective-state-block pattern.
  3. (LOW) Constraint blocks in the autonomous lane were audited under the misleading
     pre-existing kind `order_blocked_live_preflight`. Fixed structurally: blocks now
     throw `OrderConstraintBlockedError` (extends OrderValidationError, carries the row
     id) and the choke point itself audits `order_constraint_blocked` with the row
     identity (the lane's legacy kind still fires alongside — one accurate receipt
     guaranteed regardless of lane).
  4. (LOW) robinhood-no-short-selling's note overclaimed a classification upgrade
     (review hits toMcpOrder's plain Error first in the standard lanes) — note corrected.
  5. (LOW) Header overclaimed that the tests pin the adapters' duplicate copies —
     corrected to state reality (table rows pinned here; adapter copies pinned by their
     own suites; messages copy-equal by convention).
  Refuted (with code receipts, not applied): audit-write-failure aborting reshaped exits;
  lone bracketStopLimit miscounting; row-order block-vs-place divergence; bracket-strip
  discarding a real protective intent on resting limit exits.
- Post-fix: tsc clean, eslint 0 errors (1 pre-existing warning), 48/48 targeted tests.
- Full `npm test` + `npm run build` via `scripts/land.sh` at landing.

## 5. Next Steps & Blockers

- Slices 3–4 of §7 remain planned/unassigned: per-account broker-mutation mutex; uniform
  protection receipts.
- Possible slice-2 follow-up: constraint-check `reviewEquityOrder` inputs too (today only
  placement is wrapped; order-replacement reviews the pre-reshape shape — harmless for
  current rows, worth revisiting if a reshape ever changes notional).

## 6. Zero-Code Findings

- Confirmed the 2026-07-27 Alpaca sell+bracket 422 follow-up was never fixed anywhere
  upstream of the adapter (this change closes it).
- `tradier.ts` silently ignores `trailPercent` (zero handling) — unreachable in production
  today only because `broker-protective-stops`' `nativeTrailing` is alpaca-only.
