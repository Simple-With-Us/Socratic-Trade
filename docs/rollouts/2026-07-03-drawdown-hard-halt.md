# 2026-07-03 — Live-execution hardening: drawdown circuit-breaker → hard-halt (owner decision)

## Summary
First slice of the live-execution hardening build. Per the owner's recorded decision
(`docs/EFFORT-LOG.md` → "Drawdown circuit-breakers → HARD-HALT"), the account-level drawdown /
daily-loss circuit breaker now **hard-halts** autonomous trading on breach instead of merely going
`close_only`. Implemented as the owner's **overridable preference** (matching the repo's
"guardrails are the owner's adjustable preferences" philosophy), not a hardcoded cage.

- New `riskRules.drawdownBreakerAction?: "halt" | "close_only"` (`src/lib/types.ts`), **default
  `"halt"`**:
  - `"halt"` (default) → on breach, `systemState → "halted"`: a HARD stop. Subsequent scheduled runs
    skip entirely (`strategy.ts:242` guard) and the manual `executeProposal` path refuses
    (`strategy.ts:1876`), until the owner manually re-arms (sets `systemState` back to `"active"`).
  - `"close_only"` → the previous softer behavior: block only new entries; the loop keeps running and
    risk-reducing exits (sell/cover) still flow.
- The breaker is still **opt-in** via the thresholds (`maxDrawdownPct` / `maxDailyLossNotional`);
  unset ⇒ no breaker at all. Only the *response* changed.
- `strategy.ts` breaker block: flips to `drawdownBreakerAction ?? "halt"`, audits
  `policy_violation_drawdown` with `{ revertedTo, action }`, and sends a kill-switch notification whose
  title reflects the action ("HALTED autonomous trading (manual re-arm required)" vs "halted new
  entries (close-only)").

## Why hard-halt is safe (current-run behavior verified)
Flipping to `"halted"` mid-run does NOT crash or strand the current run, because:
- The **in-run** decide-mode execution uses `gateway.placeEquityOrder` directly (`strategy.ts:~1048`),
  which is NOT gated by the `executeProposal` halted-throw (that throw is only on the *manual* approval
  path, `strategy.ts:1876`).
- The policy gate (`policy.ts:247`) already treats `"halted"` identically to `"close_only"` for the
  current run (blocks buy/short entries, allows sell/cover exits).
So the run that trips the breaker winds down gracefully (entries blocked, its own exits still flow),
then **subsequent** scheduled runs hard-stop, and manual approvals are refused — the intended
"put a human back in the loop" semantics. Open positions during a halt rely on their **resting broker
protective stops** (already placed at the broker), which fire independently of the loop.

Scope note: only the **drawdown/daily-loss** breaker becomes hard-halt (the owner's decision). The
independent **volatility panic brake** stays `close_only` (a market-wide-panic "stop opening new risk
but keep managing" brake — a different severity than this account bleeding).

## Files
- `src/lib/types.ts` — `RiskRules.drawdownBreakerAction` + refreshed breaker doc comments.
- `src/lib/strategy.ts` — breaker block honors the setting (default halt); audit `action`/`revertedTo`;
  action-aware kill-switch notification title.
- `test/strategy-moneypath-drawdown-flip.test.ts` — first case now asserts the default hard-halt
  (`systemState → "halted"`, `action: "halt"`); added a case asserting the `"close_only"` override.
- Docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this note.

## Verification
`npx tsc --noEmit` clean · `npm run lint` 0 errors (pre-existing warnings only) · `npm test`
**2351 passed / 239 files** · `npm run build` green. `mergePolicy` spreads `riskRules`
(`db.ts`/`db-profiles.ts`), so the new field persists (no allowlist stripping).

## Codex review round (2026-07-03, PR #343)
Three P2 review comments, all addressed in a follow-up commit:
1. **`drawdownBreakerAction` broke policy validation** — `validatePolicy` (`app/api/policy/route.ts`)
   sweeps `Object.values(policy.riskRules)` as non-negative numbers; a string enum is `NaN` under
   `Number(...)`, so `PUT /api/policy` rejected any save with the field set — and, once stored, every
   later save too (it merges `...current.riskRules`). Fix: validate the enum separately and exclude it
   from the numeric sweep (`Object.entries(...).some(([key,value]) => key !== "drawdownBreakerAction" ...`).
   New `test/drawdown-breaker-action-api.test.ts` locks it, including the "stored enum doesn't break a
   later unrelated save" regression.
2. **Breaker persisted to the wrong account** — the run reads `getPolicy(userId, targetAccountId)` but
   both breakers wrote `setPolicy(policy, userId)` with no account id, which resolves the ACTIVE account.
   A scheduler run of a non-active account could therefore halt the wrong account. Fix: both the drawdown
   breaker and the (pre-existing, same-bug) volatility brake now `setPolicy(policy, userId, targetAccountId)`
   — symmetric with the read. (End-to-end multi-account run regression test deferred as a fast-follow —
   `TestBrokerGateway` account-matching setup; the fix itself is a symmetric one-liner covered by the
   existing active-account drawdown test + the per-account-isolation suite.)
3. **UI copy still said "close-only"/"Exit-only"** — with the new `"halt"` default, the console
   guardrails hint (`app/console/guardrails/field-defs.ts`) and dashboard breaker copy
   (`app/dashboard-client.tsx`) misrepresented behavior. Updated both to describe the hard-halt default
   ("autonomous trading hard-halts until you manually re-arm").
4. **Follow-on (2nd Codex pass): cap-demotion re-saved the halt unscoped.** After the breaker mutates
   the shared `policy` object to `halted`, a later blocked opening in the SAME run calls
   `autoRevertOnCapBreach(...)` (strategy.ts:805/890/905), which did `setPolicy({...policy,
   strategyAuthority:"propose"}, userId)` with no account id — re-persisting the halted policy onto the
   ACTIVE account. Fix: threaded `targetAccountId` into `autoRevertOnCapBreach` for the three
   `runStrategyOnce` call sites; the `executeProposal` call site (active-account path) stays unscoped.
   Now every `setPolicy` in the run is account-scoped.

## Follow-ups
- **Prompt-expected stop-losses** — the second half of the live-execution hardening (strengthen the
  strategist prompt + schema to expect a stop on opening proposals, with policy validation, NOT a
  schema hard-requirement per the owner's decision). Separate PR.
- **Settings UI toggle** for `drawdownBreakerAction` — functional today via the policy API and defaults
  to the owner's chosen `"halt"`; a console control is a small nice-to-have follow-up.
- Owner awareness: a hard-halt means the loop places NO further orders (including exits) until re-armed
  — position protection during a halt is by the resting broker stops. If the owner prefers the softer
  "keep managing exits" behavior, set `drawdownBreakerAction: "close_only"`.
