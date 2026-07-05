# Guardrails → overridable preferences (denylist), only the hard set stays hard (Monet risk lane)

**Date:** 2026-07-05
**Agent/seat:** MONET (risk-engine swimlane)
**Branch:** `claude/regime-enum-risk-gates` … (new branch for this change: `claude/guardrail-overridable-denylist`)
**Owner directive:** "I don't want any firm guardrails other than which account to operate in. Anything else
should be just light preferences that can be overridden anytime the agent wants if the agent has some
rationale to explain why it felt important to disregard or override."

## Summary

Inverted the Socratic self-override classifier from an **allowlist** to a **denylist**, and moved its
source of truth into the risk engine. The agent may now self-override **any** policy block with a logged
`autonomyOverride` thesis EXCEPT an explicit hard set (account boundary + physical/broker/regulatory/
accounting impossibilities). Any block not in the hard set is overridable **by default** — including new
gates added later.

- **New source of truth (`src/lib/policy.ts`):** `HARD_GATE_REASON_PATTERNS` + `isHardGateReason(reason)`,
  co-located with the gates that emit the reasons.
- **`src/lib/socratic-runtime.ts`:** `overrideableReason(reason)` is now simply `!isHardGateReason(reason)`
  (imported from `./policy`). Deleted the hand-maintained `OVERRIDEABLE_PATTERNS` allowlist, the
  `HARD_PATTERNS` list, and `reasonMatches` (all folded into the risk engine).

## Why

The philosophy ("only the account boundary is hard; everything else is a light, overridable preference")
was already ~80% built: `socraticOverrideMode` defaults to `"execute"` and `resolveSocraticOverride` lets
the agent proceed past preference gates on a structured thesis, keeping broker/account/integrity gates
authoritative. The gap was the classifier: `overrideableReason` was an **allowlist** — a reason was
overridable only if it matched one of ~25 hand-listed preference strings, so anything unlisted (or any
new gate) defaulted to **hard**. That is the opposite of the owner's intent and the same fragile
string-coupling the regime-enum work (PR #449) just removed elsewhere. It also miscategorized three genuine
preferences as hard.

Inverting to a denylist makes the DEFAULT overridable and puts the one place a gate is declared hard next
to where the gate is written, so the hard/preference decision is made at gate-authoring time.

## The hard set (stays non-overridable — "can't-do-it" facts, not guardrails)

Audited against every `reasons.push` in `evaluateTradeProposal`:

| Hard reason (substring) | Why it stays hard |
|---|---|
| `No Robinhood account is selected.` | the account boundary — the one absolute rule |
| `Sell quantity exceeds` / `Cover quantity exceeds` | accounting: can't sell/cover more than held/short |
| `exit must specify` | malformed order (no qty/amount) |
| `buying power` | broker rejects: can't spend more than available |
| `not tradable` / `broker` | broker-originated rejection |
| `does not support short selling` | broker capability (NOT the policy toggle) |
| `Fractional or dollar-based orders must be regular-hours only.` | broker execution constraint |
| `margin_minimum:` | regulatory: live margin minimum (FINRA Notice 26-10, the PDT successor) |
| `wash-sale` / `wash sale` / `PERMANENTLY` | IRA wash-sale — governed by its OWN owner control (`taxSettings.iraWashSaleHandling`), not double-overridden ad hoc |

## Reclassified hard → overridable preference (the behavior change)

- `Short proposals must carry a mandatory stop-loss (…shortStopLossPct)` — a risk rule.
- `Bracket orders require "bracket" in permittedOrderTypes …` — an order-type preference.
- `short-selling is disabled in policy` — a policy toggle (distinct from the broker-capability
  `does not support short selling`, which stays hard). The short-side gate embeds its `why` in the reason
  string, so the two cases classify correctly by substring.
- Plus the **denylist default**: previously-unlisted blocks (e.g. `System is liquidating`, and any future
  risk-preference gate) are now overridable rather than silently hard.

All of these remain **advisory** — they only ever change behavior when the agent explicitly attaches an
`autonomyOverride` thesis (its rationale, logged); nothing auto-overrides, and no order the agent didn't
intend can be placed. Broker/account/regulatory/accounting hard gates are untouched.

## Not in this change (flagged follow-ups)

- `resolveSocraticOverride` only applies to OPENING sides (buy/short) and requires `autonomyOverride.requested`.
  Extending override to exits is a separate, smaller step (exits mostly hit hard accounting gates anyway).
- **Pre-policy vetoes** (`deterministicBearFilter`, the Red Team veto) drop candidates BEFORE the policy
  gate / override even runs, so making those advisory is a second, larger step that also touches Claude's
  lane. Scoped separately.
- Longer term: tag each `PolicyDecision` reason with a structured `kind: "hard" | "preference"` at
  production time so the classifier stops string-matching entirely.

## Files

- `src/lib/policy.ts` — added `HARD_GATE_REASON_PATTERNS` + `isHardGateReason` (exported source of truth).
- `src/lib/socratic-runtime.ts` — `overrideableReason` → denylist delegating to `isHardGateReason`;
  removed the allowlist/HARD_PATTERNS/reasonMatches. (Claude's lane — minimal touch, coordinated on
  `#agent-sync`.)
- `test/hard-gate-classification.test.ts` — **new**: pins `isHardGateReason` over the full matrix of real
  reason strings, incl. the reclassified gates, the short broker-vs-policy discrimination, and the
  denylist default.
- `test/socratic-runtime.test.ts` — added: reclassified preferences (short-stop / bracket) now override;
  regulatory `margin_minimum` still refuses.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (pre-existing warnings only).
- `npm test` — full suite green.
- `npm run build` — succeeds.
- Targeted: hard-gate-classification + socratic-runtime + policy + reconciliation-risk pass.

## Coordination

Posted a claim on `#agent-sync` before touching `socratic-runtime.ts` (Claude's lane) noting the
owner-directed cross-lane change is limited to the `overrideableReason` region.
