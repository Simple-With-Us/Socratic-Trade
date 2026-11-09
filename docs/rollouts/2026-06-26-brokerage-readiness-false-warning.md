# 2026-06-26 — Fix: Brokerage readiness badge showed the opposite (false "not available")

Branch `fix/brokerage-readiness-false-warning` (throwaway worktree `~/apps/trading-ag13`, off `origin/main`).

## Symptom (operator)
With the **Agentic** Robinhood live account selected, active, and running autonomous, the header
Brokerage readiness badge warned **"Selected broker account is not currently available for agentic
execution"** — the opposite of the real status (the Accounts modal showed the account Active/Autonomous
and orders were routing to it).

## Cause
The readiness badge (`app/dashboard-client.tsx`) computed:
`selectedBrokerAccount = snapshot.accounts.find(a => a.accountNumber === executionState.accountNumber)`
then `ok: …agenticAllowed === true`. `snapshot.accounts` comes from a LIVE `gateway.getAccounts()`
(Robinhood MCP); when that call fails/returns empty it degrades to `[]` in `dashboard.ts`, so
`selectedBrokerAccount` is `undefined` and the strict `=== true` check renders a hard "not available"
warning. It was NOT a number-matching bug — `executionState.accountNumber` resolves to the account's
number correctly; the live account list simply didn't include it at snapshot-build time.

This is informational UI only; the actual execution gates (`strategy.ts`, `/api/policy`,
`/api/strategy/enable`, `/api/ready`) independently fail closed on `!agenticAllowed`, so safety is
unaffected — the badge was just false-alarming.

## Fix
Treat only an EXPLICIT `agenticAllowed === false` as a hard block; an undefined (couldn't enumerate)
selected account no longer shows the scary warning:
- `ok: usesLocalSimulation || selectedBrokerAccount?.agenticAllowed !== false`
- detail: explicit-false → "not available"; found+true → "available"; not-found → soft
  "Could not re-verify the account with the broker just now; agentic execution uses the selected account."

Execution gates are left strict (fail-closed) — only the readiness badge was loosened from "must prove
allowed" to "warn only when proven disallowed."

## Verification
- `npx tsc --noEmit` clean · `npm test` 1254 passing · `npm run build` clean.
- (UI-only predicate; no dashboard-client unit harness — oxc/jsx limitation, consistent with prior
  decisions. The logic table: found+true→ok·available, found+false→warn·not-available,
  undefined→ok·soft-note.)

## Follow-up (deeper, not done here)
The root fragility is `snapshot.accounts` depending on a live broker enumeration that can transiently
return empty. A more thorough fix: in `dashboard.ts`, when `getAccounts()` fails/returns empty, fall
back to the stored connected accounts (deriving `agenticAllowed` from the account type) so the snapshot
always includes the active account. Deferred to keep this fix low-risk and UI-scoped.
