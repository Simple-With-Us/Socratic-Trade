# 2026-07-09 — Short stop-loss default (8%) + surface short settings in main Essentials

PR: (opened via `scripts/land.sh`; see `STATUS.md` / `docs/EFFORT-LOG.md` for the number)

## Summary

Two owner-directed edits to the short-selling risk config, done together because
they're coupled (the second makes the first visible):

1. **Real default, not a fallback.** `DEFAULT_RISK_RULES` (`src/lib/defaults.ts`)
   now sets `shortStopLossPct: 8`, mirroring the long `stopLossPct: 8`. Because
   `DEFAULT_POLICY.riskRules` is `DEFAULT_RISK_RULES` directly and `mergePolicy`
   (`src/lib/db-profiles.ts`) deep-merges `riskRules` against `DEFAULT_POLICY.riskRules`,
   every policy that doesn't explicitly override `shortStopLossPct` now carries 8%
   out of the box. The short-selling gate (`src/lib/policy.ts:433`, which rejects
   any short proposal when `!riskRules.shortStopLossPct || <= 0`) previously always
   fired for a fresh policy — enabling short selling with no other change meant
   every short was rejected for "must carry a mandatory stop-loss." That gate logic
   is unchanged; only the default that feeds it changed. No `?? stopLossPct`
   fallback was added anywhere — this is a genuine default value, not a gate
   workaround, per the owner's explicit instruction.

2. **Surfaced, not hidden.** The four short-selling fields (`shortSellingEnabled`,
   `maxShortOrderNotional`, `maxShortExposurePct`, `riskRules.shortStopLossPct` —
   the `SHORTS` field-def group) previously rendered only inside a collapsed
   `<AdvancedGroup title="Short selling">` in the "Advanced rulebook" card on
   `/console/guardrails`. They now render as the last rows of the main
   "Essentials" card, directly below the existing essentials list, using the same
   row shape (`PolicyFieldRow` + the `maxShortExposurePct` utilization meter) the
   page already uses elsewhere. The `AdvancedGroup` wrapper for "Short selling" was
   deleted from the Advanced rulebook card.

3. **Copy update.** The `riskRules.shortStopLossPct` field hint
   (`app/console/guardrails/field-defs.ts`) changed from "Mandatory for any short —
   a short without one is rejected." to "Defaults to 8%. Every short carries a
   stop — a short without one is rejected." — reflects the new default instead of
   reading like an unmet requirement. The other three `SHORTS` hints are untouched.

## Why

Owner report: enabling short selling with otherwise-default settings rejected
every short proposal, because the mandatory short-stop gate had nothing to pass
by default (`shortStopLossPct` was `undefined` unless a user explicitly set it).
Owner's exact instruction: "just set the default to some amount like 8%, don't
make a fallback number. also, short options shouldn't be hidden... they should be
among the main options shown at the bottom." A real default (not a
`?? stopLossPct`-style computed fallback) closes the trap without changing the
gate's semantics; moving the short fields into the main Essentials list makes the
setting (and its new default) discoverable instead of buried in a disclosure.

## Files

- `src/lib/defaults.ts` — added `shortStopLossPct: 8` to `DEFAULT_RISK_RULES`.
- `app/console/guardrails/page.tsx` — moved the `SHORTS.map(...)` block (with its
  `maxShortExposurePct` utilization meter) from the "Short selling" `AdvancedGroup`
  in the Advanced rulebook card to the end of the Essentials card's `divide-y`
  list; deleted the now-empty `AdvancedGroup title="Short selling"` wrapper.
- `app/console/guardrails/field-defs.ts` — updated the `riskRules.shortStopLossPct`
  hint copy.
- `STATUS.md` — new snapshot entry.
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — Completed
  effort-log row.

No changes to `src/lib/policy.ts` (the gate itself), no changes to the three
other `SHORTS` field defs' copy, no changes to `SHORTS`/`ALL_DEFS` composition in
`field-defs.ts` (only visual placement moved — `ALL_DEFS`, used by the save-bar's
diff computation, was already a flat list that didn't encode UI grouping).

## Verification

Run from `/Users/jay/apps/trading-monet-short-defaults` (fresh worktree off
`origin/main`, `npm ci`'d):

```bash
npx tsc --noEmit   # clean, no errors
npm run lint       # 0 errors (368 pre-existing warnings, none new)
npm test           # 306 files / 3168 tests passed
npm run build      # succeeded, /console/guardrails compiled
```

Grepped `test/` for assertions tied to the old shape/copy — none found that
needed updating:
- No test asserts `DEFAULT_RISK_RULES`/`DEFAULT_POLICY.riskRules` by strict
  `toEqual` (so adding the new key didn't break a shape check).
- The one test that expects the short-stop gate to actually reject a short
  (`test/hard-gate-classification.test.ts`, `test/policy.test.ts` "short without
  a mandatory stop-loss is rejected when short selling is enabled") explicitly
  overrides `riskRules.shortStopLossPct: 0` to force the rejection path — those
  tests are unaffected by the new default and still pass.
- `test/guardrails-essentials.test.ts` covers a *different* "Essentials" concept
  (`app/settings-search.ts`'s `GUARDRAILS_ESSENTIALS`, a settings-search index),
  not the guardrails page's own `ESSENTIALS` field-def group — unrelated to this
  change and untouched.
- No test references the "Short selling" `AdvancedGroup` title string or asserts
  DOM placement of the `SHORTS` rows.

Sanity-checked the actual bug fix with a throwaway script (`tsx`, deleted after
use) calling `evaluateTradeProposal` against a policy built from
`{ ...DEFAULT_POLICY, shortSellingEnabled: true }` (no `shortStopLossPct`
override) with a short proposal sized inside all other caps:
- Before this change (implied by prior gate behavior): rejected with "Short
  proposals must carry a mandatory stop-loss."
- After this change: `approved: true`, `reasons: []` — confirmed the "no naked
  short" invariant still holds (the gate itself didn't change) while the
  out-of-the-box trap is gone.

## Follow-ups

None identified. The three other `SHORTS` field hints already read correctly
("Also requires the broker to allow shorting on this account. Every short must
carry a short stop-loss." for `shortSellingEnabled`) and were left as-is per the
task scope.
