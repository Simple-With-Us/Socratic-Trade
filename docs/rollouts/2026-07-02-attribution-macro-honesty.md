# 2026-07-02 — Per-proposal model attribution + macro placeholder honesty

Branch: `claude/strategy-attribution-macro-honesty` (isolated worktree off `origin/main` @ `da07d4bc`).
Two verified-open, money-path-adjacent follow-ups landed together.

## Summary

**T3 — Persist `proposedByModel` (and red-team model) on each proposal.**
- `TradeProposal` (src/lib/types.ts) gains optional `proposedByModel?: string`, and its
  `redTeamVerdict` object gains optional `model?: string`. Proposals persist as JSON so the new
  optional fields ride along — no schema migration.
- `src/lib/strategy.ts` stamps `proposedByModel` with the FAILOVER-AWARE served Green model
  (`bullServedModel`) when mapping `rawBullProposals`, and RE-stamps it on `bearProposals`
  (survivors are re-emitted through the Bear's strict schema, which strips unknown fields — the
  origin model is still the Bull's served model). The high-conviction debate attach site now
  includes `redTeamVerdict.model` when the debate resolved a model.
- `src/lib/red-team.ts`: `RedTeamDebateResult` gains `model?: string`, set on every return path of
  both the OpenAI-compatible and the cross-provider Anthropic debate (absent only on the
  "LLM not configured" skip, where no endpoint served anything).
- `app/console/components/approval-card.tsx` now prefers the PERSISTED `p.proposedByModel` /
  `p.redTeamVerdict.model` and falls back to snapshot policy values only for legacy proposals;
  the stale "not yet persisted — fast-follow" comment is replaced, and the "(policy default)"
  annotation no longer shows when a persisted attribution exists.
- Legacy dashboard (`app/dashboard-client.tsx`): its Bear Review block renders verdict + reason
  only — **no model attribution is rendered there**, so no mirror change was needed (verified by
  grep: `redTeamLlmModel` appears only in the policy-config model selectors).

**T6 — Stop feeding the strategist placeholder FRED constants / placeholder-curve regime.**
- `src/lib/macro.ts`: `DEFAULT_MACRO` (hardcoded 5.25% fed funds vs 4.20% 10Y — a fabricated
  INVERTED curve — plus a fake 15.00 VIX etc.) is replaced by `BLANK_MACRO` (every field `""`,
  asOf `"unavailable"`). All three no-FRED paths now blank instead of fabricate:
  1. `fetchVixOnlyFallback` success → live `vix` + real `asOf`, every FRED field `""`;
  2. `fetchVixOnlyFallback` failure → all blank, asOf `"unavailable"`;
  3. the outer fetch `catch` (~line 227) → all blank, asOf `"unavailable"` (previously carried
     DEFAULT_MACRO strings into the prompt even though the regime was Unknown).
  Effects: `determineMarketRegime`'s `parseFloat("")` is NaN so the placeholder curve-inversion
  no longer distorts the regime (VIX-only 12 → Risk-On instead of "Cautious (Inverted Curve)";
  18 → Neutral instead of inversion-tipped Risk-Off), and `deriveMacroMetrics`' `pctToNum("")`
  returns undefined so no placeholder metric enters the prompt.
- `pruneMacro` now drops empty-string fields from the strategy prompt payload entirely (they are
  neither sent as `""` nor listed in `omitted`): the strategist never sees a blank or placeholder
  reading presented as data.
- `MacroData.fredSourced` semantics and the console's client-side blanking are intact:
  `app/console/macro/indicators.ts` `mv()` already treats `""` as em dash, and the legacy
  `app/ui/macro-panel.tsx` `str()` helper does too — the legacy panel actually gets MORE honest
  (it never gated on `fredSourced`, so it used to show the placeholders).

## Why

- T3: the approval card's model attribution was policy-derived (the model configured NOW), so it
  went stale/wrong when the owner swapped models between proposal and review, and it could never
  show a failover-served model. This closes the fast-follow the card's own comment promised.
- T6: in no-FRED setups the strategist's prompt and the deterministic regime classifier both
  consumed fabricated constants presented as data — directly against the repo's "never show or
  feed fabricated numbers" rule. Blank-and-drop is the existing partial-fetch convention.

## Files

- `src/lib/types.ts` — `TradeProposal.proposedByModel?`, `redTeamVerdict.model?`.
- `src/lib/strategy.ts` — bull/bear proposal stamping; debate-verdict model stamping.
- `src/lib/red-team.ts` — `RedTeamDebateResult.model?` set on all served paths.
- `app/console/components/approval-card.tsx` — persisted-first attribution reads.
- `src/lib/macro.ts` — `BLANK_MACRO` replaces `DEFAULT_MACRO`; all three fallback paths blank;
  `pruneMacro` drops `""` fields; doc comments updated.
- Tests: `test/strategy-llm-failover.test.ts` (proposal carries fallback-served model),
  `test/strategy-money-path-f-g.test.ts` (persisted `proposedByModel` + `redTeamVerdict.model`
  round-trip), `test/red-team.test.ts` (verdict `model` on OpenAI + Anthropic paths),
  `test/macro.test.ts` (VIX-only regime not distorted by fabricated inversion; pruneMacro drops
  `""` incl. MACRO_ALWAYS_KEEP fields), `test/macro-metrics.test.ts` (VIX-only shape derives
  nothing), `test/cache-provenance.test.ts` (fallback shapes assert `""`, not placeholders),
  `test/alternative-data.test.ts` (no-key path returns blanks, network-blocked for determinism).
- Docs: `STATUS.md`, `PLAN.md`, this note.

## Verification

- `npm run lint` — 0 errors (295 grandfathered warnings).
- `npx tsc --noEmit` — clean.
- `npm test` — full suite green (see STATUS entry for counts).
- `npm run build` — green.
- Targeted first: `npx vitest run test/macro.test.ts test/macro-metrics.test.ts
  test/cache-provenance.test.ts test/alternative-data.test.ts test/red-team.test.ts
  test/strategy-money-path-f-g.test.ts test/strategy-llm-failover.test.ts
  test/strategy-bear-fail-closed.test.ts` — 8 files / 53 tests passed.

## Follow-ups

- The Results/learning views don't yet surface `proposedByModel` (per-model hit-rate attribution
  is now possible once persisted proposals accumulate).
- `regime-watch.ts` audit payloads will carry `""` for vix/fedFunds/dgs10 in no-FRED setups —
  honest, but a consumer of those audit rows should treat `""` as missing.
- The pre-existing `test/alternative-data.test.ts` `mockFetcher` tsc note in AGENTS.md did not
  reproduce here (tsc clean); left as-is.
