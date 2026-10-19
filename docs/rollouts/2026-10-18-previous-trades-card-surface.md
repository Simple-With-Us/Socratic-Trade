# Previous Trades rows had no visible card surface (2026-10-18)

## Context & Objective

Owner reported (2026-10-18) that the **Previous Trades** section of the console autonomy desk
rendered its rows with no background color, so they read as bare strips on the page rather than
as cards. The first screenshot in the same report showed a transient
`Snapshot failed (500)` full-screen card; that one self-heals on the console's own retry and is
NOT part of this change (see "Out of scope").

## Root cause

`ProposalRow` hard-coded its own fill to `--con-surface-2`:

```tsx
<div className="... bg-[color:var(--con-surface-2)]">
```

That token is defined in `app/console/console.css:27` as `#f4f6fa`. The console page background
is `--con-bg: #f1f4f6` (`console.css:25`). **Those two colors are three RGB steps apart**
(`244,246,250` vs `241,244,246`), so at every breakpoint the row was effectively invisible
against the page.

The same component is rendered in two places:

| Call site | Container | Correct fill |
|---|---|---|
| `app/console/page.tsx:252` — "Latest Strategy Run" | inside a `.con-card` (white `--con-surface`) | `--con-surface-2` reads as a recessed lane — correct |
| `app/console/page.tsx:358` — "Previous Trades" | bare on `--con-bg` | `--con-surface-2` is invisible — the bug |

So the value was never wrong; it was right for one caller and wrong for the other. `--con-surface-2`
is only ever correct as an *inset within a white card*.

## Changes Made

`ProposalRow` gained an optional `surface?: "inset" | "raised"` prop, defaulting to `"inset"` so the
in-card caller is unchanged. `"raised"` selects `--con-surface` (white, same token `.con-card` uses),
which is what a page-level card needs. The focus-ring offset color is derived from the same choice
so the ring never paints a mismatched halo.

Both class names are emitted as **literal strings** in a ternary, not interpolated tokens, so
Tailwind's scanner sees both variants (an interpolated `bg-[color:var(--x)]` would be purged).

### Files changed

- `app/console/page.tsx`
  - `ProposalRow` signature: added `surface = "inset"` + the prop's type + its doc comment.
  - `ProposalRow` body: added `rowBg` / `rowRingOffset`; applied to the row wrapper and the
    `focus-visible:ring-offset-*` on the row button.
  - "Previous Trades" call site: passes `surface="raised"`.

No CSS token was changed, so nothing else that consumes `--con-surface-2` moved.

## Decisions & Trade-offs

- **Fixed at the component, not the token.** Recoloring `--con-surface-2` to be more distinct from
  `--con-bg` would have been a one-line change but would have restyled every other consumer
  (inputs, selects, evidence cards, nav hover, the sheet's `con-actions` bar) as collateral.
- **Prop over a second component.** Two call sites with genuinely different contexts justify a
  variant; splitting the component would duplicate the ~120-line approval/sheet body.
- **Default is the existing behavior**, so any future caller that forgets the prop gets today's
  (correct-where-used) inset rendering rather than a surprise.

## Verification State

```
npx tsc --noEmit    # clean
npm run lint        # 0 errors (868 grandfathered warnings)
npm test
npm run build
```

Note per `AGENTS.md`: **none of these compile Swift or run Playwright.** iOS compile + XCTest is
`.github/workflows/ios-build.yml`; this change touches no Swift.

### Visual baselines — deliberately NOT regenerated here

`test/e2e/visual.spec.ts-snapshots/console-autonomy-desk-chromium-linux.png` is the one baseline
that could move, and it is **linux**-generated. Regenerating it from a Mac produces a different
Chromium/font/build and fails the 1% budget for reasons unrelated to this change — the workflow
says so explicitly (`e2e.yml`, "Baseline regeneration lives in CI (not on a dev laptop/VM)").

Also: **Playwright Smoke is not a required merge check** (`e2e.yml:3` — "NOT a required merge check
(ruleset: verify only)"), and its PR trigger is path-filtered to `test/e2e/**`,
`playwright.config.ts`, lockfiles, and the workflow itself. This change touches none of those, so
the job does not run on this PR.

The sanctioned follow-up is a manual dispatch with `update-visual-baselines=true`, then commit the
uploaded `visual-baselines` artifact.

## Next Steps & Blockers

- Dispatch `Playwright Smoke` with `update-visual-baselines=true` and commit the regenerated PNG,
  so the autonomy-desk baseline reflects the intended white row fill.
- None for merge: the required `verify` gate covers lint + tsc + vitest + build.

## Out of scope (reported to owner, not changed)

- **`Snapshot failed (500)` on first console load** — self-heals on the console's own retry;
  `console-load-state.ts` already refuses to show the failure card while a fetch is in flight. Not
  reproduced or changed here.
- **`APNs HTTP 403: InvalidProviderToken`** on all three iPhone device tokens, and a
  `run_failure_streak` liveness episode at 56h on the Sandbox account — separate live incidents,
  investigated separately.