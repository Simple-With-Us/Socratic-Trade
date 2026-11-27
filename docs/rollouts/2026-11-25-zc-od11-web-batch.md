# 2026-11-25 — ST-4686 OD-11 web console batch (W11-W34)

## Context & Objective

Owner approved the OD-11 recommendations Tue, Nov 24, 2026, 11:26 PM CT ("all recommendations").  This lane lands the web-console slice as child issue ST-4686: modifier-protected hotkeys (W11), the reload-free guarded account switch (W16), the 1s brand-row hold (W17), one toast system with sonner winning (W23), Decisions in the nav plus framework proposals on Lessons (W25), orphaned skeleton and AllocationCard removal (W14, W28), the welcome-page Sign in call to action (W34), and the minimum coherent versions of chart interactivity (W30), filter chips (W31) and the flat notification checkbox grid (W33).  Deferred by OD-11 itself and NOT implemented here: W26 run stepper and W29 Human Counterfactual scorecard (both wait "after the data is defined").

## Changes Made

High level: every bare global hotkey gained a modifier; both account-switch call sites stopped reloading the page and now rescope in place behind an account-keyed remount plus a guard test; the console's custom toast stack was retired in favor of sonner; the nav and Lessons surfaces grew the missing destinations; two dead component files and the dead AllocationCard were deleted; and each design-taste item got the smallest honest implementation that satisfies the OD-11 default.

- **W11 hotkeys** (`app/console/components/command-palette.tsx`): Run Once now fires on ⌘/Ctrl+Shift+R (preventDefault also stops the browser hard-reload shortcut from racing the dispatch); navbar hotkeys 1-6 and approvals A now require Shift, which hijacks no built-in browser chord on any major browser.  Palette kbd labels updated, including an apple-aware run-once label.
- **W16 account switch**: new pure steps module `app/console/lib/account-switch.ts` and hook `app/console/lib/use-account-switch.ts` implement activate -> snapshot refresh in place, with `busyId` holding the switch affordance inert while the scope change is in flight.  `app/console/components/chrome.tsx` (ScopeSelector) and `app/console/settings/brokers.tsx` (Load button) both dropped their `window.location.reload()` and route through the hook.  `app/console/components/shell.tsx` keys the routed `<main>` subtree by the ACTIVE ACCOUNT id, changing only on a real A -> B scope change (no first-load remount), preserving the reload's guarantee that account-scoped editors remount from the new account's snapshot.  Guard test: `test/console-account-switch.test.ts` (behavioral activate->refresh ordering, no refresh on failed activation, non-fatal refresh failure, plus a source guard against reintroduced reloads in the switch path and its two call sites).
- **W17 brand row** (`app/console/components/shell.tsx`): MOBILE_BRAND_HOLD_MS 3000 -> 1000, per the owner decision "hold the brand row 1s".
- **W23 toasts**: new `app/console/lib/sonner-toast.ts` adapts the console's kind semantics onto sonner (neg errors persist until dismissed via duration Infinity + closeButton; pos/warn/info auto-dismiss).  All 26 consumer files were converted off `useToast` (127 call sites renamed), ToastProvider was removed from the shell, `app/console/ui/toast.tsx` and its CSS (`.con-toasts`, `.con-toast*`, `.con-toast-dismiss`) were deleted, and the two dependent tests were rewritten (`test/console-ux-smalls.test.tsx`, `test/console-brokers-account-visibility.test.tsx`).  The adapter is the only console surface that imports sonner.
- **W25 nav + lessons** (`app/console/components/nav.tsx`, `app/console/lessons/framework-proposals.tsx`, `app/console/lessons/page.tsx`, `app/console/page.tsx`): Decisions joins DESTINATIONS in the Review group (rail and ⌘K palette pick it up automatically).  FrameworkProposalList was extracted from the Home page into `lessons/framework-proposals.tsx` and a new `FrameworkProposalsPanel` (pending-count chip, honest empty state) renders on Lessons; Home now imports the shared component.  The Lessons rail row carries a pending-count badge (`frameworkCount` threaded through shell -> DesktopRail).
- **W14 skeletons**: deleted `app/console/components/approval-card-skeleton.tsx` and `app/console/components/portfolio-overview-skeleton.tsx` — zero consumers; only archived docs referenced them.
- **W28**: deleted `app/console/components/allocation.tsx` — AllocationCard had no consumers anywhere (multi-pattern grep).
- **W34 welcome** (`app/welcome/page.tsx`): the hero gains a Sign In ghost action (-> /login) beside Request Access.

Minimum coherent W30/W31/W33:

- **W30 chart** (`app/console/components/equity-chart.tsx`, `app/console/lib/equity-drawdown.ts` new, `test/equity-drawdown.test.ts` new): pointer hover shows a dashed crosshair and a date/value/drawdown readout snapped to the nearest persisted snapshot point (no interpolation); the region below the running VISIBLE-window peak is under-shaded with the warn token.  The drawdown math is a pure windowed helper (running peak, fraction-below-peak, deepest drawdown), never a fabricated all-time baseline.
- **W31 chips**: Scan table (`app/console/scan/scan-table.tsx`) gains All / Held filter chips (Held = symbols in the active account's open positions, passed from `app/console/scan/page.tsx`).  Guardrails (`app/console/guardrails/page.tsx`) gains section chips (All / Autonomy / Essentials / Protective stops / Advanced rulebook) that collapse the page's sections; purely visual, drafts and values untouched.  Positions card (`app/console/components/positions.tsx`) gains All / Long / Short chips over both the stock and option tables, with honest counts.
- **W33 grid** (`app/console/settings/page.tsx`): the Event notifications card is now a flat single-line-per-event checkbox grid (checkbox - label - hint on one row, truncating gracefully); the full hint remains in the row title.

## Decisions & Trade-offs

- The A and 1-6 nav hotkeys take Shift rather than ⌘/Ctrl because ⌘/Ctrl+1-6 collides with browser tab switching everywhere; any modifier satisfies the owner's "hotkeys need a modifier" ruling.  Shift+A fires only outside inputs (the existing isInput guard).
- W23 keeps the console's push(kind, title, detail) call shape as a thin typed adapter instead of rewriting 127 call sites inline; the provider stack, viewport, pausable countdown and CSS are gone, so sonner is the single engine and the diff stays reviewable.  The retired stack's "a failure must not vanish unread" rule is preserved (neg -> duration Infinity plus closeButton).
- The shell remount key ignores the first scoping so a normal page load never double-mounts route data; only a real account switch remounts.
- Guardrails filtering hides whole sections; hidden fields keep their values and in-flight drafts (PolicySaveBar still shows what is unsaved).  Tax settings travel with the Advanced filter because they sit directly above the rulebook and are referenced by it.
- Sequence note: the ST-4676 lane (PR #5480, open) also edits chrome.tsx and adds its OWN `app/console/lib/use-account-switch.ts` (a reload-based drawer helper).  This lane derived its reload-free version in parallel without depending on #5480; whoever merges second must reconcile that filename and the chrome.tsx hunks.
- Visual-baseline surfaces that legitimately change: the desktop nav rail (new Decisions row, possible Lessons badge), the /welcome hero (Sign In button), the scan-table toolbar, the guardrails header, the positions card, the settings Event notifications card, and the equity chart's at-rest under-shading (hover elements never render in captures).  The lead regenerates baselines through the e2e workflow input.
- Mobile: the phone bottom bar is capacity-bounded (4 slots, explicit default list), so Decisions lands on the desktop rail and in ⌘K but not on the phone bar; that is deliberate.

## Verification State

Lint, type-check, targeted vitest and the copy-rules lint in this lane; the serialized full gate is left to the lead (this box also hosts production).

- `npx tsc --noEmit` -> clean.
- `npm run lint` -> 0 errors (917 grandfathered pre-existing warnings); changed files add no errors.
- `npx vitest run test/console-account-switch.test.ts test/equity-drawdown.test.ts test/console-ux-smalls.test.tsx test/console-brokers-account-visibility.test.tsx` -> 17 passed (4 files).
- `npx vitest run test/scan-table-columns.test.ts test/learned-context-account-scope.test.ts test/console-a11y.test.ts` -> 21 passed (3 files).
- `node scripts/copy-rules-lint.mjs --dir app/console` -> per-file counts byte-identical to the HEAD baseline for every touched file; the five new files add zero violations (46 sentence-gap / 109 title-case pre-existing across the console).
- Full `npm test` and `npm run build` were NOT run here, per the lane brief (production host; lead runs them once, serialized).

## Next Steps & Blockers

- Lead gate (Nov 25, ~11:35 AM CT): merged origin/main clean, tsc PASS, full vitest carries only the two known Node-22 `cpuprofile-summary` environmental failures (CI Node 26 is authoritative), npm run build PASS (exit 0).  This amendment is the real tip commit so the Kody re-review has a changed head.
- Merge coordinator: this lane's `app/console/lib/use-account-switch.ts` (reload-free) shares its filename with ST-4676 PR #5480's version — whoever merges second must reconcile; #5480's rollout documents the same.
- Visual baselines to regenerate for the changed surfaces (nav rail Decisions row/badge, /welcome hero, scan/guardrails/positions chips, settings Event notifications card, equity chart shading) via the e2e visual workflow input.

## Zero-Code Findings

None.  Every OD-11 web item either changed code, moved code, or deleted dead code as described above.
