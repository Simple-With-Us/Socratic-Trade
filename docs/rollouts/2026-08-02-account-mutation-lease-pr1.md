# 2026-08-02 — §7 slice 3 PR-1: per-account broker-mutation lease (risk lanes + backstop)

**Agent:** MONET · branch `monet/broker-mutation-mutex` (off `origin/main` @ `3bc08106`)

## 1. Context & Objective

Order-state hardening slice 3 (docs/oss-lessons.md §4 "Sequential-per-account ordering"):
the Alpaca-OMS discipline that buying-power validation is order-dependent, so broker
mutation sequences must serialize per account. Before this change, the protective/synthetic
stop pass, stale-exit cancel-then-place remediation, account-drain cancels, and the manual
routes could all interleave on the same account with only per-lane point defenses (in-flight
sets, row CAS claims) — the real race window being every `await` between a DB claim and a
broker call.

Design was chosen by a 3-designer + 2-judge panel (sequence-scoped vs gateway choke-point vs
lease-unification); the implemented spec is the judges' merged synthesis: sequence-scoped
windows over the existing `operation-lease` durable primitive, with the advisory backstop,
`cid:` fallback keying, post-success loss semantics, and a two-PR delivery. **This is PR-1**
(primitive + risk lanes + backstop). PR-2 adds the strategy/approval placement windows.

## 2. Changes Made

- **`src/lib/operation-lease.ts`** — type widening only: `BrokerMutationLeaseGroup`
  (`broker-mutation:${string}`) joins the group union. No behavior change.
- **`src/lib/account-mutation.ts` (new)** — `withAccountMutation(options, run)`: runs one
  mutation SEQUENCE under a durable per-account lease (TTL 90s, heartbeat 30s). Key =
  `broker-mutation:${userId}:${accountNumber}` (the broker-side OMS identity; blank
  accountNumber falls back to `cid:${connectedAccountId}`, receipted; both absent runs
  unserialized with a receipt — the caller cannot place orders anyway). Lane-typed waitMs:
  0 (try-once, skip-and-retry — all periodic lanes) or bounded (human-adjacent). Kill switch
  `accountMutationSerialization` in settings KV (default ON, flippable without redeploy).
  Context gives `assertOwned()` fencing (risk-CREATING calls) + the heartbeat AbortSignal.
  Post-success ownership loss returns the value with `ownershipLostAfterRun` + an
  `account_mutation_lost` audit — completed broker work is never booked as failure. Header
  carries the cancel doctrine and the 4-level lock hierarchy (the lease is a LEAF).
- **Wrapped windows (all try-once, skip idiom):**
  - scheduler `stale-limit-scan` lane → `autoRemediateStaleExitOrders` body
  - scheduler `synthetic-stop-monitor` lane → whole monitor pass (coverage reads included)
  - scheduler `account-drain` lane → the multi-cancel + purge sequence
  - `safety-maintenance` steps 4 & 5 (same two functions, called from inside strategy runs)
- **`app/api/orders/replace-market`** — the manual cancel-then-place waits up to 10s, then
  maps busy to the route's existing honest-409 idiom.
- **`app/api/orders/cancel`** — NEVER leased (cancel doctrine); emits
  `broker_mutation_cancel_during_lease` when it fires during someone else's window.
- **`src/lib/broker.ts`** — `withMutationLeaseReceipt` (innermost gateway Proxy): a
  placement with no active local mutation claim audits `broker_mutation_unleased` and
  proceeds — converts any missed wrap point into a greppable receipt, not a silent hole.
  (Expected today: strategy/approval placements receipt this until PR-2 wraps them.)
- **`test/account-mutation.test.ts` (new, 11 tests)** — keying, same-account mutual
  exclusion + cross-account/user independence (two-caller interleave pattern), bounded-wait
  acquisition, busy audit (and never `order_placement_uncertain`), kill switch, unkeyed
  receipt, in-window fencing loss, post-success loss semantics, claim registry/peek, and
  the unleased-backstop receipt through the real `getBrokerGateway` composition.

## 3. Decisions & Trade-offs

- **Sequences, not lanes.** Strategy runs deliberate for minutes; leasing whole lanes would
  starve protection behind LLM latency. PR-1 lanes' natural bodies ARE their sequences.
- **Caller-side wraps** for the two long-bodied lane functions (monitor, auto-remediation)
  rather than a ~700-line body-into-closure refactor: 2 call sites each, and the backstop
  receipt catches any future unwrapped caller — that is precisely its job.
- **Busy is ordinary, not an error**: periodic lanes skip (their pre-existing idiom — the
  in-flight sets remain as same-process fast guards); nothing counts busy toward the
  broker-health uncertainty suppressor (no broker was contacted).
- **Known accepted window**: a long drain (many cancels) holds the lease while stop-monitor
  passes skip. A draining account is being torn down, and each skip is audited; PR-2 may
  add a hold-time receipt if this shows up in practice.

## 4. Verification State

- `npx tsc --noEmit` clean; eslint 0 errors on all touched files (Node 24 prefix).
- `npx vitest run test/account-mutation.test.ts` — 11/11.
- Neighbor suites: synthetic-stops, order-replacement, scheduler-draining, operation-lease —
  109/109.
- Adversarial review workflow (liveness / wiring / spec-fidelity lenses, 15 agents,
  per-finding refutation): **10 confirmed, 2 refuted, all 10 fixed before landing:**
  1. (MED) Deterministic lane starvation — the stale-exit lane reaches its acquisition
     only after a broker read, so try-once lost the phase race to the stop monitor every
     tick. Fixed: bounded `LANE_WAITS.staleExit` (15s) wait in both callers.
  2. (MED ×2) `assertOwned` fencing was dead code — now threaded as an optional `fence`
     into the synthetic-stop fire path and the replacement-market placement (cancel
     halves deliberately unfenced), passed from every wrap site.
  3. (MED) Adopted `broker_mutation_takeover_expired` audit was missing — implemented
     end-to-end (operation-lease surfaces `tookOverExpired`; withAccountMutation
     receipts it) + test.
  4. (MED) No wrap-point tests — added cancel-route-during-lease and takeover tests
     (route test derives the identity the route itself resolves; no auth spelunking).
  5. (LOW ×2) Lock-hierarchy header contradicted the implementation — rewritten:
     blocking acquisitions order downward; row CAS claims are non-blocking and
     deliberately INSIDE the lease window.
  6. (LOW) Stop-monitor rebind mismatch: caller lease key derived pre-rebind. Resolved
     honoring the test-pinned rebind-and-protect property: proceed, DROP the wrong
     account's fence, receipt `synthetic_stop_monitor_account_rebind_mismatch`.
  7. (LOW) Until PR-2, strategy/approval placements receipt `broker_mutation_unleased`
     by design (documented; do not suppress).
  8. (LOW) Test determinism: `pollMs` test override added; remaining short real-timer
     waits are gate-released deferreds, not timing-dependent assertions.
  Refuted (kept as-is with receipts): backstop-readLease amendment (local refcount is
  the designed behavior); vacuous-fencing-test claim.
- Post-fix: tsc clean; eslint 0 errors (7 pre-existing warnings in neighbor files);
  122/122 across account-mutation + synthetic-stops + order-replacement +
  scheduler-draining + operation-lease.
- Full `npm test` + `npm run build` via `scripts/land.sh` at landing.

## 5. Next Steps & Blockers

- **PR-2 (planned, same effort row):** wrap the strategy per-proposal placement window
  (before the fresh protective-state re-read) and the approval lease-before-CAS window
  (waitMs 15s/30s); make busy explicitly non-uncertain in those catches; thread fencing
  into `broker-protective-stops`' place at :1453; retire the in-flight sets; adopt the
  `broker_mutation_takeover_expired` audit if not landed in PR-1 review fixes.
- Slice 4 (uniform protection receipts) remains planned/unassigned.

## 6. Zero-Code Findings

- The design panel refuted the choke-point-only approach with a precise trace: per-call
  leasing at the gateway cannot close the stacked-protection hazard because the coverage
  reads run outside the lease; sequence windows are load-bearing, not stylistic.
