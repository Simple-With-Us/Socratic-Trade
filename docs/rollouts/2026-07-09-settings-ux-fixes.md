# 2026-07-09 — Settings-UX fixes: universe-floor diff classification, Sheet focus stability, exposure-cap hints (MONET, landed by CLAUDE pickup)

## Summary

Three-part settings-UX change on branch `monet/settings-ux-fixes`. MONET-authored
(left uncommitted in its worktree when the Monet seat hit its usage cap);
committed and landed as-is by a CLAUDE pickup session under the owner-directed
usage-cap pickup.

1. **Real bug fix — `classify()` in `app/console/lib/policy-diff.ts`.** The
   `looserWhen` ternary had byte-identical branches for `"up"` and `"down"`
   (`up ? "looser" : "tighter"` on both sides), so every `looserWhen: "down"`
   field — the `universeFloor.*` group — was classified backwards: lowering a
   universe floor (e.g. min share price $5 -> $3, which lets MORE names in)
   showed as "Locks Down"/tighter, and raising it showed as looser. The
   `"down"` branch now inverts (`up ? "tighter" : "looser"`), with an
   explanatory comment.
2. **Sheet focus stability — `app/console/ui/sheet.tsx`.** The focus-trap
   effect depended on `onClose`, and callers pass an inline arrow
   (`() => setOpen(false)`) that is a new reference on every parent render — so
   the effect re-ran on every keystroke in a TypedConfirm field and re-focused
   the first focusable element (the header X), yanking the caret out of the
   input. `onClose` now lives in a ref (`onCloseRef`) updated each render; the
   effect depends only on `open`.
3. **Copy — `app/console/guardrails/field-defs.ts`.** Added explanatory `hint`
   tooltips to `maxGrossExposurePct` (total deployed exposure, longs + shorts)
   and `maxNetExposurePct` (directional exposure, longs minus shorts), each
   noting risk-reducing exits always pass.

## Why

Owner-visible settings-UX defects: the guardrails diff/review sheet was telling
the owner the opposite of the truth for universe-floor edits (a mislabeled
"Locks Down" on a loosening change is exactly the kind of dishonest labeling the
repo bans), and typing into a sheet's confirm field lost the caret every
keystroke. The hints round out the exposure-cap group whose other fields already
had them.

## Merge with AG #1231 (`8fd8b3ab`, Sheet focus-loop crash fix)

`origin/main` was merged into the branch after committing (merge commit; 14
commits integrated). Expected overlap in `app/console/ui/sheet.tsx` merged
CLEANLY — the two changes touch different hunks of the same `useEffect` and are
semantically complementary:

- AG's `isFocusing` re-entrancy guard + `currentSheet.isConnected` check inside
  `onFocusIn` — **preserved**.
- This lane's `onCloseRef` + `[open]`-only dependency array — **preserved**.

Both verified present in the merged file by manual read.

## Landing-session lint fix (only deviation from "committed as-is")

The full gate's `npm run lint` flagged MONET's render-time ref write
(`onCloseRef.current = onClose` in the component body) as an ERROR
(react-hooks "Cannot access refs during render"), which blocks the gate.
Mechanical fix by the landing session, semantics unchanged: the ref is now
updated in a tiny `useEffect(..., [onClose])`; the focus effect still depends
only on `open`, so MONET's caret fix is fully intact.

## Files

- `app/console/guardrails/field-defs.ts` — hints on maxGrossExposurePct / maxNetExposurePct
- `app/console/lib/policy-diff.ts` — classify() looserWhen:"down" inversion fix + comment
- `app/console/ui/sheet.tsx` — onCloseRef pattern; effect depends only on `open`
- `test/console-policy-diff.test.ts` — regression test for the classify() fix
- `docs/rollouts/2026-07-09-settings-ux-fixes.md` (this note), `docs/EFFORT-LOG.md`, `STATUS.md`

## Verification

- `npx vitest run test/console-policy-diff.test.ts test/console-sheet.test.tsx
  test/settings-search-index.test.ts test/settings-tree-scope.test.ts
  test/openSettings-relocation.test.ts` — 5 files / 35 tests passed
  (post-merge, includes the new regression test).
- Manual read of merged `app/console/ui/sheet.tsx` confirming both AG #1231 and
  this lane's changes coexist.
- Full gate before landing (this worktree, post-merge): `npm run lint` 0 errors
  (370 grandfathered warnings) -> `npx tsc --noEmit` clean (after `npm install`
  to pick up main's new `drizzle-orm` dependency from #1204) -> `npm test` 308
  files / 3211 tests passed -> `npm run build` succeeded.
- Notable: the initial `npm run lint` FAILED on the as-committed diff — the
  render-time `onCloseRef.current = onClose` write is a react-hooks lint ERROR;
  fixed mechanically (see the lint-fix section above) and the gate re-run green.

## Follow-ups

- None specific to this change. The two-design-systems Sheet/modal unification
  direction (2026-07-05 UI audit) remains the umbrella effort.
