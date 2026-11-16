# 2026-07-04 — Drawdown breaker re-scoped to ADVISORY default (owner correction) (Monet)

## Summary
Re-scopes the account-level drawdown / daily-loss breaker from the (mistaken) **hard-halt default**
that shipped in #343 to an **advisory default**, matching the owner's corrected governing philosophy:
*"nothing is hard except which account to work in; agent decides, logs everything."* Every guardrail is
an advisory input to the agent's judgment; the only absolute is the account boundary.

Branch `claude/drawdown-advisory-rescope` (off `origin/main`). Owner reassigned this lane to **Monet**
(swap: Fable → memory/RAG, Monet → risk engine).

## What changed
- **`src/lib/types.ts`** — `RiskRules.drawdownBreakerAction` is now `"advisory" | "close_only" | "halt"`,
  **default `"advisory"`** (was `"halt" | "close_only"`, default `"halt"`). Doc comment rewritten.
- **`src/lib/strategy.ts`** — the breaker block:
  - **`"advisory"` (default):** does NOT change `systemState`. It writes a `policy_violation_drawdown`
    receipt (`action: "advisory"`, no `revertedTo`) and sets a run-scoped `drawdownAdvisory` that is
    threaded into the strategist's `userContent` (a labeled "ADVISORY, not a block" block with
    drawdown %, equity, high-water mark, detail) so the agent can choose to de-risk. No halting.
  - **`"close_only"` / `"halt"` (explicit opt-in):** unchanged hard-enforcement path — flip
    `systemState`, persist to the target account, kill-switch notification.
  - `drawdownAdvisory` threaded through `proposeTrades(...)` → `userContent.drawdownAdvisory`.
- **`app/api/policy/route.ts`** — `validatePolicy` accepts `advisory|close_only|halt` (message updated).
- **UI copy** (`app/console/guardrails/field-defs.ts`, `app/dashboard-client.tsx`) — drawdown/daily-loss
  breaker hints now describe the advisory default (receipt + agent context, no auto-halt).
- **Tests** — `test/strategy-moneypath-drawdown-flip.test.ts`: the default case now asserts systemState
  is UNCHANGED (`"active"`) + `action: "advisory"` + no `revertedTo`; the `close_only` opt-in case
  still asserts the flip. `test/drawdown-breaker-action-api.test.ts`: accepts `advisory`; updated the
  rejection message assertion.

## Why
#343 recorded owner decision #1 as "drawdown → hard-halt" from a multiple-choice question the owner
later said they didn't understand. The owner then stated the philosophy plainly (advisory, agent
decides, logs everything). A hard-halt default is a re-paternalization contrary to that; this reverts
it to advisory while keeping hard enforcement available as an explicit, owner-chosen opt-in.

## Verification
`npx tsc --noEmit` clean · `npm run lint` 0 errors (pre-existing warnings only) · `npm test`
**2375 passed / 245 files** · `npm run build` green.

## Follow-ups
- Thread `drawdownAdvisory` into the **Bear** context too (currently only the Bull `userContent` carries
  it) so the red-team also weighs the drawdown.
- Per the owner's plan, the broader per-gate hard-block sweep (spend caps, sizing) goes back to the owner
  as plain-language questions before flipping any other defaults — NOT bundled here.
- Coordinated with Fable on Slack `#claude-monet-sync` (lane split + the composite-review-doc collision).
