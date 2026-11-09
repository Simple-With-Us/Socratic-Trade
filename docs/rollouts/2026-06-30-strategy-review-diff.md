# 2026-06-30 - Strategy review diff clarity

## Summary

Strategy Studio's LLM Strategy Review now shows what will actually change before
the user applies it:

- Prompt proposals display the current prompt and the exact replacement prompt.
- Strategy Studio values show current -> proposed scoring-weight changes.
- Risk and automation settings show current -> proposed values and the settings
  area where the value lives.
- The apply button is disabled when a review returns no effective patch.

The tuning system prompt was also tightened so models still return null
`scoringWeights` fields for the JSON schema below the closed-lot gate, but are
instructed to describe that to users as no scoring-weight changes until there is
enough evidence.

## Why

The previous UI collapsed a prompt patch to `Prompt rewrite proposed` and listed
policy values as only `Field -> new value`. That made it hard to tell what prompt
would replace the current one, whether a setting was changing from a meaningful
current value, and whether the setting lived in Strategy Studio or another
policy area.

## Files

- `app/dashboard-client.tsx`
- `src/lib/strategy-review-display.ts`
- `src/lib/strategy-tuning.ts`
- `test/strategy-review-display.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/rollouts/2026-06-30-strategy-review-diff.md`

## Verification

- `npm test -- strategy-review-display` - pass
- `npx tsc --noEmit` - pass
- `npm run lint` - pass, 0 errors and 256 existing warnings
- `npm test` - pass, 161 files / 1557 tests
- `npm run build` - pass

## Follow-ups

- Consider moving strategy tuning proposals into a persisted proposal/history
  rail if users need per-field accept/reject instead of one manual apply button.
