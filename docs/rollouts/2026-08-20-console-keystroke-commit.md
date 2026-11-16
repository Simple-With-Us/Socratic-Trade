# 2026-08-20 — Console numeric fields: commit on blur, and stop writing a fallback on an emptied field

## Context & Objective
Slice of review cluster `console-ia-forms-blotters` (`docs/reviews/2026-08-18-full-app-expert-review.md`).  Two console numeric fields PATCHed the server on **every keystroke**, against the blur-commit pattern every sibling numeric field already uses, and an emptied field silently wrote a fallback value as a real setting.

These are risk and strategy knobs on a real-money trading app, so the harm is the **silent wrong write**, not the extra network traffic.  Typing `120` into a keystroke-PATCH field saves `1`, then `12`, then `120`; clearing it to retype saves the fallback in between.

## Changes Made
Local draft state while the field is focused; `onValueChange` updates only that draft; `onBlur` decides whether to PATCH.  Blank or unparseable text on blur commits **nothing** and the field reverts to the last saved value.  No new form abstraction and no page refactor — this matches the pattern already used by `llm-budget.tsx`, `tax-settings.tsx`, `learning-review.tsx` and `strategy/page.tsx`'s scoring weights.

- `app/console/settings/page.tsx` — `DataSourcesCard` number rows: added `numberDrafts` state and `commitNumberRow`; the pure decision lives in the new `app/console/lib/number-commit.ts` (see the page-export trap below).
- `app/console/strategy/overlays-panel.tsx` — "Max Active": replaced a plain `TextInput type="number"` that PATCHed on every `onChange` with `RawNumInput` plus `maxActiveDraft`, `resolveMaxActiveCommit`, `commitMaxActive`.
- `test/console-settings-number-commit.test.ts` (new, 9 tests)
- `test/console-overlays-max-active-commit.test.ts` (new, 10 tests)

## Decisions & Trade-offs

**Empty field reverts rather than blocking.**  On blur, blank input writes nothing and the field snaps back to the last saved value.  It does not show an invalid state or trap the user in the field.  This matches `RawNumInput`'s own behavior (its `editText` resets to `null` on blur, redisplaying the caller's `value` prop) and matches how the sibling fields behave once they stop writing a fallback.  Deliberately no confirmation dialog or "are you sure" — per the repo's product philosophy, guardrail values are the owner's adjustable preferences and correctness fixes must not add ceremony.

**The commit decision is extracted as a pure exported function** (`resolveSourceFeatureNumberCommit` in `app/console/lib/number-commit.ts`, `resolveMaxActiveCommit` in `overlays-panel.tsx`) purely so the no-fallback-on-empty rule is testable without a DOM.  This is factoring out logic that was previously inline, not a new generic abstraction.

**Honest limitation on test strength.**  The commit *decision* is tested behaviorally — the pure functions are called with real inputs (`""`, `"   "`, `"abc"`, `"-"`, `"0"`, `"-5"`, unchanged values) and their real outputs asserted.  The *wiring* (that `onBlur` reaches the commit path and `onValueChange` only touches the draft) is pinned by asserting against source text, which catches shape rather than runtime behavior and is brittle under renames.

That is a deliberate choice, not an oversight: this repo has **no DOM test tooling at all** — no `@testing-library/*`, no `jsdom`, no `happy-dom`, no `environment` set in `vitest.config.ts`, and no existing DOM-rendering test anywhere under `test/`.  Adding a DOM harness is a real dependency decision that should be made on its own merits, not smuggled in under a two-file bug fix.  Flagging it so a future reader knows the wiring assertions are a stand-in for a test we cannot currently write.

## Trap worth remembering: a `page.tsx` may not export arbitrary symbols

The first version of this change exported `resolveSourceFeatureNumberCommit` directly from
`app/console/settings/page.tsx` so the test could import it.  That type-checks locally in isolation
but fails the real gate against the generated `.next/types`:

```
error TS2344: Type 'OmitWithTag<typeof import(".../app/console/settings/page"), "default" | ... >'
  does not satisfy the constraint '{ [x: string]: never; }'.
  Property 'resolveSourceFeatureNumberCommit' is incompatible with index signature.
    Type '(raw: string, committed: number) => number | null' is not assignable to type 'never'.
```

Next.js App Router allows only a fixed set of exports from a `page.tsx` (`default`, `metadata`,
`dynamic`, `revalidate`, `generateViewport`, …).  Anything else fails the build.  The helper moved to
`app/console/lib/number-commit.ts`, which carries a comment saying why so it is not moved back.

Note that `overlays-panel.tsx` is a component, not a page, so exporting `resolveMaxActiveCommit`
from it is legal and it was left in place.

## Verification State
Failing-first proven: the two production files were reverted to their pre-fix state and the new tests rerun, producing 19 failures across 2 files (`resolveMaxActiveCommit is not a function`, plus unmatched blur/no-fallback assertions against the old keystroke-PATCH source).  Restoring the fix returns 19/19 green.  Three pre-existing adjacent suites (`console-use-overlay`, `data-sources-breadth`, `overlay-router`, 32 tests) still pass.

Full gate results recorded in the PR.

## Corrections to the review
The review states that clearing the field "saves the fallback `2`".  That is exact for `overlays-panel.tsx` — `Math.max(1, Number("") || 2)`, where `Number("")` is `0` and therefore falsy, so it falls through to the literal `2`.  It is **not** exact for `settings/page.tsx`, where the value written on an emptied field is each row's own `defaultValue` (5, 16, 7, 24, 4, 30, 60, 0.35, 0.5, 6, …), never literally `2`.  Same bug class, different constant.

## Next Steps & Blockers
A **third** site has the identical bug and was deliberately not fixed here, because this slice was scoped to two files while peer PRs #2793 / #2795 / #2828 hold the rest of the console: `app/admin/operations/operations-client.tsx:208` PATCHes server operations knobs on every keystroke and writes each knob's default on an emptied field.  Filed as issue #2958, unclaimed.

That issue also records three milder sibling sites (`tax-settings.tsx`, `learning-review.tsx`, `strategy/page.tsx`) which already blur-commit but still pass only the coerced value into draft state, so a blur-while-blank commits their fallback.  Strictly less severe, same root cause — worth one pass over all four rather than four separate fixes.
