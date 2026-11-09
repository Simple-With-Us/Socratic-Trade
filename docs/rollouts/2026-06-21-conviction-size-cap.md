# 2026-06-21 — Conviction-mediated size cap for proven theses

## Summary

Capped how far the LLM's `confidenceScore` can size up a position in
`applyDeterministicSizing` (`src/lib/strategy.ts`). Previously
`conviction = (confidenceScore ?? 50) / 100` fed the size multiplier
(`multiplier = (winRate/100) * conviction * edgeFactor`) directly and linearly.
Now, on a PROVEN thesis whose realized edge does **not** corroborate the AI's
high confidence, conviction's UPSIDE is clamped to a configurable cap (default
`0.6`). Low confidence still shrinks size fully — only the upside above the cap
is removed.

## Why

An investment-expert panel found that `confidenceScore` is a direct multiplier
on order size, and a learned "fact" can inflate it. The existing 20-closed-lot
"evidence floor" only protects UNPROVEN theses (it pins them to the sizing
floor); a PROVEN thesis with mediocre realized stats but a high LLM confidence
could still size up on conviction alone. The owner chose the strongest mitigation:
cap confidence's size contribution unless the thesis's own realized/structured
signal independently corroborates it, even on proven theses.

## Change (precise)

In the sizing block of `applyDeterministicSizing`:

- Keep `rawConviction = (proposal.confidenceScore ?? 50) / 100`.
- Corroboration is derived from the realized stats **already computed in that
  block** — `winRate` (shrunk win rate, default 50) and `avgReturn` (shrunk avg
  return %, default 0), both sourced from `getThesisRegimeScorecard` /
  `getThesisScorecard` over closed lots:
  `corroborated = winRate >= corrobWinRate && avgReturn > corrobEdge`.
- `conviction = corroborated ? rawConviction : Math.min(rawConviction, convictionCap)`.
- When the cap BINDS (`!corroborated && rawConviction > convictionCap`) and the
  thesis is proven (not on the exploratory floor), a `[Sizing] Conviction capped
  to {cap} — thesis not yet corroborated by realized edge (winRate …%, avgReturn
  …%); AI confidence alone cannot drive size up.` note is appended to the
  proposal rationale for visibility.
- Evidence floor, ceiling, and bounded-multiplier logic are otherwise unchanged
  (unproven theses still pin to the floor and report the exploratory reason).

### Defaults (conservative, ON by default) — all tunable via `policy.tuning`

| Knob | Default | Meaning |
|------|---------|---------|
| `convictionCapUncorroborated` | `0.6` | Max conviction value when uncorroborated. |
| `corroborationWinRatePct` | `58` | Shrunk win rate (%) at/above which conviction is corroborated. |
| `corroborationEdgePct` | `0` | Shrunk avg return (%) strictly above which conviction is corroborated. |

Added to `TuningSettings` in `src/lib/types.ts` as optional fields.

### Critical invariant (held)

The cap reads **only** the realized scorecard stats already in scope
(`winRate` / `avgReturn`) plus the proposal's own `confidenceScore`. It does
**not** read or reference `learned_context` in any way — no new imports, no new
references. The learned-context plumbing lives entirely in the LLM-prompt path
(`runStrategyOnce`), not in `applyDeterministicSizing`. The Phase-0
byte-identical invariant test (`test/learned-context.test.ts`, 17 tests) still
passes.

## Behavior change for proven-but-mediocre theses

Measured in test case (a) — 20 closed lots, 10 winners (+2%) / 10 losers (-3%)
→ shrunk winRate 50% (< 58), shrunk avgReturn −0.4% (≤ 0) ⇒ uncorroborated;
confidenceScore 95 ⇒ rawConviction 0.95 clamped to 0.6:

- Corroborated-equivalent (cap disabled): **$2,375**
- Capped (cap binds, default 0.6): **$1,500**
- Delta: **−$875 (~37% smaller)** on identical realized inputs.

Corroborated theses (case (b): winRate ≥ 58 AND avgReturn > 0) are unaffected —
full conviction-scaled size, no cap note. Low-confidence proposals (case (c))
are unaffected on the downside (`Math.min` is a no-op below the cap). Unproven
theses (case (d)) still pin to the exploratory floor.

## Files

- `src/lib/strategy.ts` — conviction-cap logic in `applyDeterministicSizing` + cap-binds rationale note.
- `src/lib/types.ts` — three optional `TuningSettings` knobs.
- `test/conviction-size-cap.test.ts` — new; assertions (a)–(e).
- `docs/rollouts/2026-06-21-conviction-size-cap.md` — this note.

## Verification

```
cd /Users/jay/apps/wt-confcap
npx tsc --noEmit        # clean
npm test                # 78 files / 672 tests pass (incl. new file + learned-context invariant)
```

## Follow-ups

- Surface the three knobs in the policy/tuning settings UI (currently
  tunable via `policy.tuning` only).
- Consider whether the corroboration gate should also consult the
  sector/factor scorecards, not just thesis×regime — deferred; keeping the
  realized-stat source identical to the existing sizing inputs for now.
