# Alpha Vantage proactive 23/day cap + ops follow-ups (MONET)

**Date:** 2026-07-15
**Seat:** MONET (owner-directed, follow-up lane to the todays-app-errors triage)
**Branch:** `monet/todays-errors-triage-handoff-8d809b`
**Base:** merged onto `origin/main@080eb52e` (includes #1632, #1634, #1640)

## Summary

1. **Alpha Vantage proactive global daily cap (owner-directed: 23 calls/day).** AV's
   free-tier 25/day limit is enforced **per IP** — key pooling never multiplied capacity
   (the pool was already retired to a single key, `db-api-keys.ts`). Until now the app had
   **no proactive counter**: it dispatched until AV's own rejection text tripped the
   reactive `markExhausted` path. This adds a **persisted per-ET-day budget** (env
   `PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY`, default **23**) in
   `src/lib/alpha-vantage-key-pool.ts`, surviving deploy restarts (this app deploys
   several times a day — an in-memory sliding window would forget mid-day usage).
   Wired into `AlphaVantageEnrichmentProvider.enrich()` (`src/lib/data-providers.ts`):
   per-chunk reservation, refund of never-dispatched calls (via `fetchWithRetry`'s
   `onDispatch` hook — dispatched-but-errored is NOT refunded), un-admitted symbols get
   the same skip semantics as reactive exhaustion. Proactive exhaustion fires the same
   once-guarded operator alert + suppress-until-ET-reset plumbing that #1632 added for
   reactive exhaustion (no double alert). Reactive path stays as belt-and-suspenders
   (other processes share the IP). Complementary to #1640, which deregisters AV entirely
   when Alpaca news is configured — this cap governs configs where AV IS registered.
2. **`.env.example` correction:** the stale "pool multiple keys to multiply the 25/day
   quota (25 x N)" advice removed (per-IP cap makes it wrong); documents the new env knob.
3. **Ops-snapshot visibility:** `order_rejected_by_broker` added to the audit allowlist
   in `src/lib/ops-snapshot.ts` — raw broker-rejection reasons were invisible to remote
   diagnostics, which blocked root-cause confirmation of today's broker rejects.
4. **NUL-byte cleanup:** `fingerprintKeySet` in `alpha-vantage-key-pool.ts` contained a
   raw NUL byte inside a string literal (pre-existing), making grep treat the file as
   binary and silently skip it. Replaced with the `"\x00"` escape — identical string
   value, so persisted fingerprints are unaffected.

## Investigated, deliberately NOT changed

- **`order-replacement.ts` held-state `continue` is load-bearing, not dead.** The
  todays-errors handoff (§4c) recorded a verifier note calling it "now-redundant"; the
  implementing agent proved otherwise: `stale-limit-orders.ts` deliberately does NOT
  filter held legs out of `listStaleLimitOrders` (its own comment says the listing is a
  shared primitive `order-replacement.ts` relies on), and #1632's final form suppressed
  only the owner-facing *alert* (`isHeldExitLeg` in `notifyStaleLimitOrders`). The
  `continue` is what keeps auto-remediation from cancel-replacing an unactivated bracket
  leg. The "remove dead held-state check" suggested-task chip was dismissed with this
  reasoning.

## Why

Owner-directed (2026-07-15): "change alpha vantage to only do 23 calls a day since there
is a hard limit per IP", plus the two small ops follow-ups surfaced by the todays-errors
triage, batched into one PR to minimize deploy count (each deploy restarts the app
mid-run).

## Files

- `src/lib/alpha-vantage-key-pool.ts` — persisted daily budget (reserve/refund/day-key),
  NUL-byte fix
- `src/lib/data-providers.ts` — budget wiring in `AlphaVantageEnrichmentProvider.enrich()`
  + shared exhaustion-alert guard
- `src/lib/ops-snapshot.ts` — audit allowlist + `order_rejected_by_broker`
- `.env.example` — per-IP cap docs + `PROVIDER_QUOTA_ALPHA_VANTAGE_PER_DAY`
- `test/alpha-vantage-key-pool.test.ts` — new "proactive daily call budget" suite
  (admission cap, persistence-across-restart, refund, day rollover, alert-once, env
  validation) + isolation guards for the pre-existing suites
- `test/ops-snapshot.test.ts` — broker-reject rows surface in `recentAudit`
- `docs/EFFORT-LOG.md` — CLAUDE todays-app-errors row flipped to Deployed+verified; this
  effort's row added
- `STATUS.md` — snapshot entry

## Verification

- Implemented by a scoped sonnet agent; adversarially reviewed by a test-quality lens
  (**LAND**, with independent test runs: 53/53 + 108/108 collateral) and a correctness
  lens re-run post-merge (first attempt died on a session cap; the re-run's verdict gates
  arming auto-merge on the PR).
- Post-merge-with-main focused runs (Node 24):
  `npx vitest run test/alpha-vantage-key-pool.test.ts test/ops-snapshot.test.ts
  test/data-providers.test.ts test/connection-health-routing.test.ts
  test/alpha-vantage-quota-alert-cooldown.test.ts` → **177/177**.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors (grandfathered warnings only).
- Full `npm test` + `npm run build` run by `scripts/land.sh` at land time.

## Deploy context (same day, for the record)

PR #1632 (CLAUDE's P1 RAG ledger-authority fix) merged `951fe45c`, auto-deployed
19:47:38Z, and was deploy-verified by MONET: health/db/scheduler/litestream ok, Sentry
SOCRATIC-TRADE-X silent post-restart, container logs clean, first ledger authority
minted in prod (new `socratic-private-*` Pinecone namespace with 7 vectors; legacy
7,702-vector corpus intact). RAG outage window 11:27Z–19:47Z, fail-open.

## Follow-ups / deferred

- Roth IRA per-order floor change (owner action item 4): advised `maxOrderNotional=$250`
  + blank/raise `maxOrderPctOfNav` if balance < ~$5k; awaiting owner's Chrome-extension
  connection or manual click (no agent-reachable authenticated write path — by design).
- Buying-power-not-decremented within a run (probable co-cause of broker rejects) —
  flagged to the AG safety-maintenance lane (`strategy.ts` KEEPOUT), Slack ts posted.
- AV dereg (#1640) makes `alpha-vantage: down` in `/api/health` EXPECTED-INERT when
  Alpaca news is configured (sibling lane's note) — don't re-alarm on it.
