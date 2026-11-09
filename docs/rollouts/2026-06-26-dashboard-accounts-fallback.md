# 2026-06-26 — Root fix: dashboard accounts fall back to stored connected accounts

Branch `fix/dashboard-accounts-fallback` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).
Follow-up to #183 (which softened the readiness badge); this fixes the underlying data fragility.

## Why
`snapshot.accounts` is built from a LIVE `gateway.getAccounts()` (e.g. Robinhood MCP). When that call
fails or returns empty (transient enumeration miss), `dashboard.ts` degraded `accounts` to `[]`, so the
configured/active account disappeared from the snapshot — which made the readiness badge unable to find
it. #183 stopped the false "not available" warning; this makes the snapshot resilient so the badge can
show a DEFINITIVE "available" again.

## What
`src/lib/dashboard.ts`:
- After `gateway.getAccounts()`, backfill any **stored connected account** (`listConnectedAccounts`)
  whose `accountNumber` the live list didn't return, so the snapshot always reflects the configured
  accounts even when the broker enumeration hiccups.
- New exported helper `connectedAccountAgenticFallback(account)` derives `agenticAllowed` for the
  backfilled entry, mirroring the live gateways: Robinhood → only a standard `brokerage` account
  (not IRA/Roth) defaults agentic-allowed; Alpaca / Alpaca-MCP / Test → agentic-allowed for all.
- Live entries always win (only missing account numbers are added; no duplicates).

Only one consumer reads `snapshot.accounts` in the client (the readiness badge's `selectedBrokerAccount`
lookup) plus the `accountNumber` default in `dashboard.ts`, so the blast radius is small.

## Verification
- New unit test `test/dashboard-agentic-fallback.test.ts` (Robinhood brokerage→true, IRA/Roth→false,
  missing type→brokerage default; Alpaca/Alpaca-MCP/Test→true).
- `npx tsc --noEmit` clean · `npm test` 1256 passing · `npm run build` clean.

## Result
With the live RH list present, the active Agentic account resolves from live data (agenticAllowed=true)
→ badge "available". With the live list empty/failed, the same account is backfilled from the stored
record (brokerage → agenticAllowed=true) → badge still "available", no false warning and no soft
"could not re-verify" fallback. The execution gates remain strict/fail-closed (unchanged).
