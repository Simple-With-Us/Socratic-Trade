# 2026-06-21 — Deferred backlog continuation (multi-agent, autonomous)

## Summary
Continued the financial-expert-panel backlog autonomously in `~/apps/trading-claude` (branch
`agent/claude`), using background agents (sonnet where a delicate-but-disjoint task fit) for
non-overlapping files while doing the interdependent money-path items inline. Each chunk committed
+ reconciled + fast-forwarded into `main`.

## Landed (commits on agent/claude → main)
- **`daa965b`** macro Unknown-regime (no fabricated "live" regime when FRED is unsourced),
  deterministic not-advice disclaimer in chat, real SEC EDGAR UA default, **pinned Score column**
  (sticky-right). (3 via parallel agents; macro inline after its agent was rate-limited.)
- **`cca0806`** **factor orthogonalization** (sonnet agent): tanh intraday curve (de-saturates the
  momentum factor) + reduced 52w/technicalScore double-counting. Weights unchanged; 12 tests pass.
- **`0caa2f0`** **clientOrderId broker-truth reconcile** (money-path): `EquityOrder.clientOrderId`
  (Alpaca `client_order_id` / Robinhood `ref_id`) populated in both adapters; the run-start sweep
  is now async + matches a stale `placing` intent against the broker and RECOVERS it into P&L (or
  abandons it if it never executed). Completes the atomic-placement loop.
- **`d33960d`** **evidence floor** — unproven theses (< 20 closed lots) sized at the floor instead
  of ~28% on AI conviction; **not-advice disclosure** on the Decision/proposal surface (sonnet agent).
- **`82041ff`** **scheduler pending-fill reconciler** — reconcile pending live fills every tick
  (Robinhood has no realtime stream), not just inside a ≤60-min strategy run.

## Verification
- `npx tsc --noEmit` clean after each chunk; `npm test` **456 tests** green throughout; clean build
  verified earlier in the session.

## Multi-agent notes
- Agents were given strict single-file ownership (disjoint from the money-path) to avoid conflicts;
  no merge conflicts occurred. The transient server rate limit intermittently killed subagents
  (2 of an early batch of 4); those items were redone inline or re-run on sonnet successfully.

## Still deferred (next session)
- **run-lock the approval path** (cap double-spend TOCTOU) — `executeProposal` should take the
  per-user strategy lock around the gate→place→persist critical section.
- **native Alpaca brackets** (order_class bracket with stop/take-profit legs) so protection survives
  process death / overnight gaps.
- **PDT/Reg-T gate** — needs `daytrade_count`/`pattern_day_trader` plumbed from Alpaca into the new
  `AccountCapabilities`.
- **migration ledger** (`schema_version` + ordered migrations) and **db.ts split** — sensitive
  db.ts work, do carefully with full-suite verification.
- **Litestream operationalization**; **Robinhood fundamentals** enable (needs a live
  `/api/admin/robinhood-probe` to validate field units); remove/implement dead `stopLossAtrMultiple`.
