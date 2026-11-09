# Retired-provider Usage Monitor cleanup

## Summary

Retires Usage Monitor forwarding for Alpaca, Tradier, and Robinhood without removing or changing
their broker functionality. It also removes the dead Intrinio provider implementation and current
configuration/documentation, while retaining historical rollout evidence.

## Behavior

- Alpaca, including its `alpaca-news` and `alpaca-snapshot` subproviders, Tradier, and Robinhood
  remain available for trading, account reads, and API-health reporting.
- Their call-volume events are no longer forwarded to Usage Monitor.
- `pushBrokerBalance` is removed entirely (call sites were already unhooked; the export is gone).
- A central provider-family policy prevents retired broker names and subproviders from being
  admitted on the live path (`recordProviderCall`) and the durable provider-dispatch path
  (`createProviderDispatchUsageMonitorEvent` returns null; replay drops nulls and still advances
  watermarks).
- Paid providers remain eligible for Usage Monitor forwarding; the integrated regression uses FMP
  as the paid control alongside suppressed Alpaca/Tradier/Robinhood.
- Strict-v2 identities, complete/partial ACK semantics, replay watermarks, and cutover behavior
  from #1889 are preserved.
- The unused Intrinio provider, API-key resolution, environment example, and current planning
  references are removed. Historical rollouts, reviews, and handoffs are deliberately unchanged.

## Files

- `.env.example`
- `src/lib/alpaca.ts`
- `src/lib/tradier.ts`
- `src/lib/robinhood.ts`
- `src/lib/data-providers.ts`
- `src/lib/db-api-keys.ts`
- `src/lib/usage-monitor-provider-policy.ts`
- `src/lib/usage-monitor-push.ts`
- `src/lib/usage-monitor-replay.ts`
- `test/usage-monitor-provider-policy.test.ts`
- `test/usage-monitor-push.test.ts`
- Current provider/broker/Usage Monitor docs
- `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md`

## Verification

- Node 24 focused gate before strict-v2 integration: 5 files / 209 tests passed.
- TypeScript `--noEmit` and `git diff --check` passed before strict-v2 integration.
- Post-#1889 integration on exact `origin/main` (`bd7068b6`): focused usage-monitor suites
  4 files / 61 tests passed (`provider-policy`, `push`, `replay`, `vector-db-voyage-dispatch-cost`);
  `tsc --noEmit` and `git diff --check` green. Full `npm test` + `npm run build` run before PR.

## Dependency and release state

PR #1889 merged as `bd7068b6341380b49ec13165f5f4e0b8b15a07ee` and is live on Coolify at that exact
SHA with `usage-monitor` healthy. This branch integrates the retired-provider boundary on that
strict-v2 transport.
