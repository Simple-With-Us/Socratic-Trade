# R2 usage monitor: multi-account (st/ct/um) support (2026-08-01)

## Context & objective

Owner correction 2026-08-01: the fleet uses **three different Cloudflare
accounts**, each with its own independent R2 free tier (10 GiB / 1M Class A /
10M Class B per account per month):

| Slot | Account | Bucket | Env pair |
| --- | --- | --- | --- |
| `st` | SocraticTrade.com (94ec35cf…) | socratic-trade-bucket | `CLOUDFLARE_ST_API_TOKEN` / `CLOUDFLARE_ST_ACCOUNT_ID` |
| `ct` | Congress.Trade (0e9f5a0c…) | congress-trade-bucket | `CLOUDFLARE_CT_API_TOKEN` / `CLOUDFLARE_CT_ACCOUNT_ID` |
| `um` | Usage.Jays.Services (3a936805…) | usage-monitor-receipts | `CLOUDFLARE_JAY_API_TOKEN` / `CLOUDFLARE_JAY_ACCOUNT_ID` |

The monitor shipped 2026-07-31 only watched `st`. This change monitors every
configured account against its own free tier, with independent alert state,
per-account alert messages, a per-account digest, and a grouped admin card.

## Changes made

- `src/lib/r2-usage.ts`:
  - `loadR2UsageAccounts()` — three fixed env-pair slots; any subset works.
  - `R2UsageSnapshot` gains `accountId` / `accountLabel`; snapshots persist
    as an array under `r2usage:lastSnapshots` (replaces the single
    `r2usage:lastSnapshot`).
  - Alert state keys become `account:metric` composites — the three free
    tiers track completely independently (state migration: old bare keys are
    simply superseded on the next run; worst case is one re-alert).
  - `runR2UsageCheck` loops accounts; **one account's failure never blocks
    the others** (per-account try/catch → `partial` status + error result,
    healthy accounts' snapshots still persist).
  - Alert titles/bodies name the account; digest renders one section per
    account (storage absolute, ops floored pace — the 2026-08-01 alert-basis
    semantics are preserved per account).
- `app/api/admin/r2-usage/route.ts` — returns `snapshots` array +
  `accountsConfigured`.
- `app/admin/page.tsx` — "R2 Free-Tier Usage" card groups metrics by
  account; ops rows show pace, storage rows show "absolute usage".
- `.env.example` — documents all three env pairs.
- `test/r2-usage.test.ts` — 5 new multi-account tests (27 total): slot
  loading, partial failure isolation, per-account alert independence,
  per-account digest rendering.
- Infisical ST prod: added `CLOUDFLARE_CT_API_TOKEN` /
  `CLOUDFLARE_CT_ACCOUNT_ID` / `CLOUDFLARE_JAY_API_TOKEN` /
  `CLOUDFLARE_JAY_ACCOUNT_ID` (values from the operator's local secret store,
  set via CLI, never printed).

## Verification state

- `npx tsc --noEmit` clean; `npx vitest run test/r2-usage.test.ts
  test/notify-user-creds.test.ts` 38/38 green. Full suite + build delegated
  to required `verify` CI.
- Bucket/account discovery verified live against all three Cloudflare
  accounts with their API tokens (bucket lists above).
- Prod activation: env is already in Infisical — the lane picks up all three
  accounts on the first post-deploy check; the next digest (daily 24h
  cadence) renders all three sections.

## Next steps & blockers

- None. The weekly Sunday ops digest (Kimi automation) was updated the same
  day to cover all three accounts.
