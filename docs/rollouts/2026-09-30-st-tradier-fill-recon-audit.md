# 2026-09-30 CLAUDE — Post-Merge Audit of #3798 Tradier Fill Reconciliation

Board `687a5fb4`, lane h2.  Branch `claude/st-w3-h2`, worktree `~/apps/claude-st-w3-h2`.  PR label `do-not-automerge`.

## Context & Objective

PR #3798 (Tradier fill reconciliation: per-order lookup, bracket exit legs, listing ingestion, proposal convergence, ops backfill route) merged on 2026-09-27 without its adversarial review, because the reviewers hit a usage limit.  This lane audits it as merged on `main`, checks tonight's live observation on the Tradier Sandbox, and fixes what is real.

The observation (2026-09-29 22:41Z, Tradier Sandbox, paper): after an ops cancel, the cancel reply read `pending_cancel`, but the working-order list then showed the four Aug 5 GTC buy limits as state `pending`, still counted as working.  Fill reconciliation wrote `fill_reconciliation_pending_price` audits for them with `brokerState: "pending"` and `brokerQuantity: 0`.

## Changes Made

Four verified defects, each fixed test-first.

1. **(P2) A definitive not-found counted as a broker outage.**  `TradierBrokerGateway.getEquityOrder` let a Tradier 404 reach `trackHealth` as a thrown error, so every not-found wrote a `tradier-broker` hard-failure row to `api_health_log`.  Five in a row trip `getLaneHealth`'s consecutive-failure streak.  That fires `alertConnectionFailure`: a "tradier-broker connection failed" operator push, a Sentry capture, and a red Connections row, while Tradier is healthy.  One budgeted backfill pass (`POST /api/ops/fill-reconcile`, up to 500 lookups) over old Sandbox receipts that Tradier no longer serves is exactly that pattern.  The per-tick pass can do it too (12 lookups, re-asked every 30 minutes).  The not-found is now caught inside the tracked call and logged as a healthy answer.  Transport and server failures still throw and still count.
2. **(P2) Bracket double-booking.**  `tradierBracketParts` picked the leg-entry shape only when leg 0 was an opening side and every other leg a closing side, counting equity legs only.  Anything else fell to the container-entry branch, which books the container's own execution as the entry and treats EVERY equity leg, leg 0 included, as an exit.  An owner's sell-first OTOCO, a stock-plus-option OTO, or a side word Tradier spells differently therefore booked the same shares twice: once under the container id and once under leg 0's id.  The split now keys on the TOTAL leg count (every class).  The container-entry shape carries one leg fewer, so the count is unambiguous.  A non-equity leg 0 leaves the bracket with no equity entry.
3. **(P3) Fabricated BUY from a side-less exit leg.**  `tradierOrderLookupFromRow` mapped every exit leg through `mapTradierOrder`, whose side reader defaults an unknown side to `buy`.  Those legs are booked by `bookBracketExitLegs`, so a leg without a recognized side would book as a broker-originated BUY.  The listing path (`executionsFromTradierRow`) already dropped such legs.  The lookup path now drops them too.
4. **(P3) Mislabeled pending-price audits (the 22:41Z observation).**  `reconcilePendingReceipts` wrote `fill_reconciliation_pending_price` for every receipt that did not settle, including a LIVE order with nothing executed.  "Pending price" means executed-but-unpriced.  The audit now fires only when the broker reports an execution or the order is terminal.  The receipt's raw refresh and the terminal-state escalation are unchanged.

Files touched:
- `src/lib/tradier.ts`
- `src/lib/strategy-execution.ts`
- `test/tradier-order-lookup.test.ts`
- `test/tradier-fill-reconciliation.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md` (new h2 row; the G1 row corrected from IN PR to MERGED #3798)
- `docs/rollouts/2026-09-30-st-tradier-fill-recon-audit.md`

## Decisions & Trade-offs

- **`pending_cancel` is not mis-mapped.**  `mapTradierOrder` stores Tradier's status verbatim.  `pending_cancel` is the app's own label for Tradier's DELETE reply `ok` (`cancelEquityOrder`).  Tradier's own vocabulary has no `pending_cancel`: it reports `pending` until the cancel is confirmed, and `canceled` after that.  Treating `pending` as live is correct, because a cancel-requested order can still fill.  Once Tradier reports `canceled`, the receipt flips to `canceled` from the listing (same session) or the by-id lookup, and the proposal leaves `placed`.  Cancelled orders are not stuck as fills-in-waiting.  Only the audit label was wrong (finding 4).
- **Side checks dropped from the bracket split.**  Counting every leg is stricter and simpler than inferring the shape from side words.  The app's own OTO and OTOCO placements (`symbol[0..n]`) always carry the class's full count, so their handling does not change.
- **Not-found stays `undefined`.**  Nothing is flipped on a not-found.  The receipt stays pending and escalates as before, and a bracket container settles after three not-founds.  Only the health accounting changed.
- **Design concern, not changed (owner call).**  Listing ingestion books untagged owner orders on a Tradier account as `brokerOriginated` fills.  This is by design in #3798, and it makes realized P&L complete.  But those fills also reach `calculatePnl` consumers such as `strategy-tuning.ts` and experience memory, so the owner's manual trades now count in the app's own learning signals.  It is flagged for the owner, not reverted.
- **Pre-existing label, not changed.**  An operator-cancelled order that Tradier confirms as `canceled` ends with its proposal at `rejected_by_broker` and the message "Broker terminated the order without a fill".  That branch predates #3798.

## Verification State

Local, Node 24 (`/opt/homebrew/opt/node@24/bin`), on a Mac at load average 250-450:

```bash
npx vitest run test/tradier-fill-reconciliation.test.ts test/tradier-order-lookup.test.ts   # before the fix: 5 failed, 20 passed
npx vitest run test/tradier-order-lookup.test.ts --testTimeout=400000                       # after: 10 passed
npx vitest run test/tradier-fill-reconciliation.test.ts test/ops-fill-reconcile.test.ts test/pending-fill-reconcile-refire.test.ts test/reconciliation-risk.test.ts --testTimeout=400000
npx tsc --noEmit
npx eslint src/lib/tradier.ts src/lib/strategy-execution.ts test/tradier-fill-reconciliation.test.ts test/tradier-order-lookup.test.ts
```

- The 5 new tests failed before the fix, each for the named reason, and pass after it.
- The adjacent run: 62 of 63 passed.  The 1 failure is `pending-fill-reconcile-refire` "writes the closed-lot experience exactly once".  Its `vi.waitFor` uses the default 1s budget for a fire-and-forget `import("./experience-memory")`, which did not finish in time at load 444.  That test goes through the `filled` branch, which this change does not touch.  CI `verify` is the binding gate.
- With the default 60s test timeout at this load, `tradier-order-lookup` timed out on `vi.resetModules` plus dynamic imports.  At `--testTimeout=400000` all 10 pass.
- tsc and eslint results are recorded in the PR body.
- Full suite and `next build` are left to the required `verify` check.  No route or client/server module boundary changed.

## Next Steps & Blockers

- Review and merge (the label holds it).  It is a money-path-adjacent change on the Tradier adapter.
- After deploy, run `GET /api/ops/fill-reconcile?account=<Sandbox connected account id>` to read the counts: placed proposals, pending receipts, broker-originated fills.  Then `POST ...&budget=200` if a backlog remains.  This lane has no production access, so it could not confirm whether the #3798 backfill already ran or whether the Sandbox still shows 40 `placed` proposals.
- Owner decision: should untagged owner orders be booked into the app's ledger (see Decisions)?

## Zero-Code Findings

- The by-id lookup, listing ingestion, and proposal backfill are idempotent.  Every booking checks for any fill in the account with that broker order id and inserts inside one IMMEDIATE transaction.  The `(proposal_id, broker_order_id)` unique index backs up the proposal backfill.  `test/ops-fill-reconcile.test.ts` covers a repeated POST converging once.
- The gateway wrappers (`withLivePreflight`, `withPositionInvariant`, `withOrderConstraints`, `withMutationLeaseReceipt`) are Proxies that forward `getEquityOrder` and `listRecentExecutions`, so the new capability does reach production callers.
- Halted accounts still reconcile every tick.  Parked accounts are skipped by the scheduler, so a parked account's backlog drains only through the ops route.
