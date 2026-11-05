# 2026-07-08 — Model-picker labels + Red-team recommendation fix (MONET)

> **FINAL (same day, owner directive: "check the history of calls and base it on that, not on the
> wording of the model").** Two earlier rationales — #1078's "never a preview for the Red seat" and
> the first draft of this PR's "reasoning depth wins, preview is fine" — were BOTH armchair theories.
> The recommendations are now derived from this account's actual call history (`llm_step` outcomes in
> the audit trail + `llm_usage`), excluding two fixed incident classes (the Gemini bear
> unparseable-format incident, fixed 2026-07-02, and the pre-#1036 60s reasoning-timeout aborts):
>
> | model | Red (bear) record | Green (bull) record | flags |
> |---|---|---|---|
> | gemini-3.5-flash | **46/46 clean post-fix** (59/93 lifetime incl. incident) | 27/0 | Green + Red |
> | gpt-5.4-mini | 18/1 | 22/2 | Green + Red |
> | deepseek-v4-pro | 17/3 (all 3 = fixed timeout class) | 0 successes / 3 timeouts | Red only |
> | claude-sonnet-5 | zero calls ever (+ Anthropic key capped until 2026-08-01) | zero | none |
> | gemini-3.1-pro-preview | zero calls ever | zero | none |
>
> Zero-history models carry no recommendation regardless of pedigree — the flags are re-derived from
> history as it accrues. **Owner clarification (same day):** key-level quota/rate limits — the 2026-07
> Anthropic usage cap and the OpenAI rate-limit failures dominating gpt-5.5's bull record — are
> owner-adjustable account settings, not model qualities or provider outages; they are never held
> against a model, and once the owner raises a limit the affected model simply starts accruing the
> real history these flags are derived from. The role-neutral label fixes from #1078 stand; `gemini-3.1-pro-preview`'s
> label is "deepest Gemini reasoning" (parallel form; the model ID already says preview).

## Summary
Owner review of the Green/Red model pickers found (1) role-flavored, grammatically
inconsistent descriptors and (2) an incoherent Red-team recommendation. Fixed in both
catalog copies (`app/console/settings/models.tsx` + `app/ui/llm-model-catalog.ts`).

## Why / decisions
- **Labels must be role-neutral**: one catalog feeds BOTH pickers, so "premium Claude
  *critique*" (opus) and "fast Claude *review*" (haiku) baked the Red role into
  model descriptors shown in the Green picker too. Now: haiku = "fast low-cost
  Claude", opus = "premium Claude reasoning" (parallel to "deepest OpenAI
  reasoning"; forms the Anthropic ladder analysis → reasoning → most capable).
- **Red recommendations follow one principle**, now documented in a comment above
  each catalog: per provider, `recommendedGreen` = the stable fast/balanced $$
  workhorse (runs every tick); `recommendedRed` = the strongest **stable** reasoner
  at sustainable per-proposal cost. That resolved the owner-flagged inconsistency
  (Sonnet $$ vs Gemini 3.1 Pro $$$ both "recommended"): the real defect was
  recommending a ***-preview* build for the money-path adversary seat. Moved the
  Gemini Red recommendation from `gemini-3.1-pro-preview` to the stable
  `gemini-3.5-flash` (matching DeepSeek's both-roles shape); Sonnet keeps its Red
  rec (strong stable reasoning at $$, cross-family diversity from common Green
  picks). Preview models remain selectable, just unrecommended.

## Files
- `app/console/settings/models.tsx` — labels, rec flags, convention comment.
- `app/ui/llm-model-catalog.ts` — same (kept in sync per the header note).
- Flags are display-only (`model-picker.tsx` type + label suffix in
  `console/strategy/page.tsx`) — no behavior change.

## Verification
- `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `npm run build` — run via
  `land.sh` gate (results in PR).

## Follow-ups
- The in-flight `monet/single-adversary-consolidation` branch also edits
  `models.tsx` — flagged on #ag***-s**c to rebase over this.
