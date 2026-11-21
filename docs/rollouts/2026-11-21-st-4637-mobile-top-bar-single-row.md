# ST-4637 — Mobile top bar single-row rework + fleet UX/performance audit

## Context & Objective

The owner reported (screenshot, 2026-11-21 8:47 AM, iPhone) that the account dropdown
("Alpaca Paper — MFK9") in the "iOS app" had grown too wide, pushing the bar's icon
controls onto a second line that filled only a small right-aligned part of its row —
wasted whitespace on both lines. The owner asked for a narrower dropdown, resized or
consolidated buttons, or a deliberate two-line design, plus a broader expert audit of
UI/UX/performance across the iOS app, web console, and backend.

**Critical platform fact surfaced by the audit:** the screenshot is the **mobile web
console** (`app/console/**` rendered at phone width), not the SwiftUI app. Every string
in the screenshot exists only in `app/console/components/chrome.tsx` + `shell.tsx`; the
native app's chrome is already compact (inline title + bell/gear toolbar). The fix
therefore lands in React/Tailwind.

**Root cause:** `shell.tsx` split phones into two chrome rows (`basis-full` scope row +
`w-full justify-end` icon row) while `chrome.tsx` kept `flex-1` on the scope wrapper —
a stretch rule written for the old single-row bar, where it "absorbed the leftover next
to the icons". After the split it stretched the picker across ~70% of a row it no
longer shared, and the icon row left ~120pt dead on the left.

## Changes Made

Adopted **Option 1 (variant packing)** from `docs/audits/2026-11-21-zc-ios-ux.md` —
phone chrome collapses to ONE control row:

```
[account scope (flex-1, capped)] [● Autopilot] ←slack→ [🔔 51] [⋯] [⃠ STOP]
```

with Search, ⚡ Run Once, and the account/theme/sign-out block inside the new ⋯
overflow menu. Banner and freshness rows are unchanged; the `sm:` (≥640px) desktop/
iPad bar is byte-for-byte unchanged in behavior and ordering.

- `app/console/components/shell.tsx` — ChromeBar: removed the `basis-full` two-row
  split; phone row is now scope+chip leading, bell/⋯/STOP trailing; desktop wrappers
  (`hidden sm:block`) keep the exact pre-change desktop order; RunOnceButton is a
  single mounted instance (hidden on phones) whose `console:run-once` listener serves
  the overflow menu; comments rewritten (the old ones documented the pre-split bar).
- `app/console/components/chrome.tsx` —
  - `ScopeSelector` wrapper: `min-w-0 flex-1 max-w-[46vw]` below `sm` (the old
    `min-w-[120px]` floor would overflow the single row at ≤360px; `max-w-[46vw]` is
    the re-hog cap), desktop `sm:` floors untouched; trigger suffix unified to one
    space (` — MFK9`, was three spaces — matched the menu rows).
  - `StateChip`: word/mode spans gained `con-state-word`/`con-state-mode` hooks.
  - `UserMenuBody` extracted (identity + theme + sign-out) shared by `UserMenu` and
    the new menu so the two surfaces cannot drift.
  - New `BarOverflowMenu` (phone-only, `sm:hidden`, `con-bar-ctl` 44px ⋯ trigger,
    portaled right-aligned panel via `useAnchoredMenu`): Search (dispatches
    `console:open-command-palette`), ⚡ Run Once (dispatches `console:run-once`),
    divider, `UserMenuBody` (or a fallback note when no session identity).
  - `RunOnceButton`: `size`/`iconOnly` props removed (no callers left); labeled
    primary button on desktop; on phones the hidden instance still runs the event.
- `app/console/console.css` — `@media (max-width: 360px)` collapses the state chip to
  its tone dot so the single row never wraps on iPhone SE-class widths; full wording
  stays in the chip tooltip, ControlSheet, and Home strategy card.
- `app/console/approvals/page.tsx`, `app/console/lib/api.ts` — comments updated to the
  new Run Once location/flow (no behavior change).
- New audit reports (read-only analysis, committed for the record):
  `docs/audits/2026-11-21-zc-ios-ux.md`, `docs/audits/2026-11-21-zc-ios-perf.md`,
  `docs/audits/2026-11-21-zc-web-ux-perf.md`, `docs/audits/2026-11-21-zc-backend-perf.md`.

## Decisions & Trade-offs

- **Variant packing over the agent's primary packing:** keeping Search off the bar row
  (one tap deeper in ⋯) buys the scope dropdown ~151pt at 393px — enough to show
  "Alpaca Paper — MFK9" essentially untruncated, which is the owner's headline
  complaint. STOP (money-path halt), the notifications badge, and the autopilot state
  stay permanently visible; the ⋯ menu is the future-control slot.
- **Icon-only STOP kept on phones** (audit finding W2 remains open as a follow-up):
  the ControlSheet titles itself "Stop Agent" on tap, and a micro-label would add
  chrome the single row just reclaimed. Option 2 (labeled 50/50 two-line) is the
  documented fallback if the owner misses the words.
- **`min-w-[120px]` phone floor removed** deliberately: in a one-row bar a fixed floor
  is the overflow risk PR #1708 originally warned about; `min-w-0` + truncate +
  shrink-0 suffix degrade gracefully instead.
- **RunOnceButton stays mounted (hidden) on phones** rather than hoisting its run
  logic: the mounted listener owns the blocked-run explanation sheet and toast for
  free, and `runOnce()` is already singleflighted.
- Not done here (filed as Linear follow-ups instead): the ~25 remaining audit
  findings, including the SIWA `preconditionFailure` crash path (H), the mobile
  `MobileStore`/SSE re-render amplifier (H), `api_health_log` retention (owner
  decision), and the unbounded scan audit payloads.

## Verification State

- `npx tsc --noEmit` — clean after the UserMenuBody extraction repair.
- `npm test` (vitest, full suite) — 10,866 passed / 42 skipped / 4 failed locally.
  All 4 failures were run down: 2 were `test/copy-rules-lint.test.ts` catching a
  REAL regression in this diff — the pre-existing admin-link `title` lost its
  U+00A0 sentence gap when re-typed during the ChromeBar rewrite (typed NBSP
  normalized to two plain spaces); fixed byte-exactly via script and the lint
  suite is 17/17 green. The other 2 (`test/cpuprofile-summary.test.ts`) are
  environmental: the test spawns `node src/lib/cpuprofile-summary.ts`, which needs
  Node 26's native type stripping; this lane host has Node 22 and no nvm.
  That file is untouched by this diff and CI's `verify` (Node 26) is the
  authoritative gate for it.
- `npm run build` — run locally in the lane (see below).
- No vitest test references the changed components (grep-verified);
  `test/e2e/header-menus.spec.ts` exercises the scope dropdown mechanics, which are
  unchanged (trigger width only). Mobile-chrome e2e visual baselines are
  desktop-only, so no snapshot churn.
- Swift untouched — `ios-build` gate not applicable to this diff; CI `verify` is the
  merge gate as usual.

Commands run: `npx tsc --noEmit`; `npm test`; `npx vitest run --last-failed`;
`node scripts/copy-rules-lint.mjs --dir app/console`; `npm run build`.

## Next Steps & Blockers

- Land the PR (Kody review + `verify`), then confirm at phone width (320/360/393/430)
  that the bar renders one row with no wrap.
- Follow-up Linear issues filed from the four audits (see Linear team ST, filed
  2026-11-21); the two H crash/perf items (SIWA trap; SSE re-render amplifier) are
  queued first.
- Owner decision needed: `api_health_log` retention (keep-everything policy vs a
  1.8M-row table that already froze the event loop once — ST-4635).

## Zero-Code Findings

The four read-only audit reports (committed under `docs/audits/`) cover iOS UX
(including the native app's missing account switcher), iOS performance (startup gate,
per-SSE-event snapshot refetch), web console UX+perf (context re-render amplifier,
unvirtualized phone scan list), and backend perf (unbounded audit payloads,
non-sargable daily stats, headline N+1, uncached settings lookups). Prior audits
(2026-08-20 deepseek mobile web, 2026-08-31 grok full-stack, ux-improvement-program)
were read first; already-fixed items are marked and not re-filed.
