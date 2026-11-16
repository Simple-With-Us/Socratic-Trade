# 2026-07-02 — Console: a complete ground-up trading UI at `/console` (Claude)

## Summary

Built a **greenfield, complete trading interface** as a new route group
`app/console/` — desktop and mobile, light and dark — wired to the real
existing APIs, with **zero changes to any existing file** (no edits to
`src/lib/**`, `app/api/**`, `middleware.ts`, or the legacy UI; the legacy
dashboard code was deliberately never read — design blindness was a hard
constraint of the task).

Screens: **Home** (portfolio value, honest day P&L, daily spend meter,
needs-attention inbox, positions with per-position protection status, latest
run), **Approvals** (receipt-style cards; approve/reject wired; LIVE approvals
implement the server's typed `LIVE_CONFIRMATION_REQUIRED` contract verbatim),
**Activity** (unified feed / runs with per-run proposal forensics / fills /
notification events, day-grouped), **Strategy** (prompt editor, models,
scoring weights, preset library with copy-not-link Apply), **Guardrails**
(essentials first, advanced rulebook grouped by domain; review-and-commit diff
sheet with LOOSER/TIGHTER classification and typed CONFIRM only when loosening
on LIVE; Autopilot behind a typed ritual, Ask-first one tap), **Results**
(bucketed performance that never merges practice and real money, SPY
benchmark, thesis/regime scorecards, tax estimates incl. wash-sale lockouts
and days-to-long-term), **Settings** (scope-split THIS ACCOUNT vs ALL YOUR
ACCOUNTS, visibly tagged).

Global chrome on every screen: word-first money-reality banner (TEST/PAPER
practice money, LIVE real money + viewport frame), account scope selector,
run-state × authority chip in plain words, **one-click STOP that never sells**
(honest copy: app-managed synthetic stops pause; broker-held brackets keep
resting; Close-only offered as the middle verb; wind-down typed because it
sells), wired Run-once (disabled with reason when the LLM key or readiness is
missing), theme toggle, and a freshness strip (data as-of, scan age, next run,
daily spend meter).

## Why

Owner asked for a complete ground-up UI synthesized from three blind design
studies (novice-first "Steadyhand", operator-first "TradeDeck",
explainability-first "Ledgerline") — taking their convergent safety spine
(word-first reality, asymmetric friction, decision receipts, narrated
fail-safes, honest absence) and the best of each elsewhere. The synthesis
rationale is documented in `app/console/README.md`. Mid-build, the owner
upgraded light mode from optional to **required**; the token system was
refactored to complete light+dark semantic palettes before further screens
were built.

## Design/implementation decisions

- **One data layer**: `app/console/lib/useConsoleData.tsx` polls
  `GET /api/dashboard` every 15 s (paused when the tab is hidden), refreshes
  after every mutation, and keeps the last good snapshot on errors with a
  visible "refresh failing" notice — errors never blank the screen.
- **Mutations** (`app/console/lib/api.ts`): `POST /api/strategy/run`
  (`{manual:true}` — server forces propose), `POST /api/strategy/pause`
  (STOP), `POST /api/strategy/enable` (start; server-verified preconditions
  surface verbatim), `PUT /api/policy` (close_only/liquidating, guardrails,
  prompt, weights, notification/tax/scan settings),
  `POST /api/proposals/[id]/approve` + `/reject`,
  `POST /api/connected-accounts/[id]/activate`,
  `POST /api/profiles/[id]/activate`, `POST /api/settings/auto-resume`,
  `POST /api/notifications/test`.
- **Live approval contract** mirrors `assertLiveApprovalConfirmation`
  (src/lib/strategy.ts): payload `{proposalId, accountNumber, executionMode:
  "broker/live", estimatedNotional, typedText}`; a 409
  `LIVE_CONFIRMATION_REQUIRED` response's `reasons` + `expectedText` render
  verbatim (server is the authority); paste disabled on the typed field.
  The 409 `system_stopped` refusal is narrated on the Approvals page.
- **Client reality derivation** mirrors `deriveExecutionState` (paperMode /
  active connected account / environment) — words: TEST · practice money,
  PAPER · practice money, LIVE · real money, each with its clarification
  sentence (Test is the app's simulator, not broker paper).
- **Protection column honesty**: a position shows "Broker stop" only when a
  working stop order for the symbol exists in the snapshot's orders; else the
  app-managed stop rule (explicitly "paused" while Stopped); else `—`.
- **Day P&L honesty**: computed only when a prior-calendar-day snapshot exists
  in the current bucket's equity curve; labeled "vs last snapshot before
  today" with the exact baseline on hover; otherwise `—`.
- **Theming**: semantic `--con-*` tokens, complete light (base) + dark sets;
  dark via `[data-theme="dark"]` or `prefers-color-scheme` (unless
  `[data-theme="light"]`); explicit choice persisted under localStorage key
  `console:theme`; soft fills/borders derived with `color-mix`; no raw hex in
  components (grep-verified); palettes aim WCAG AA.

## Files (all new; nothing outside these was touched)

- `app/console/console.css` — scoped two-theme design tokens + component classes
- `app/console/layout.tsx` — route-group layout (imports console.css)
- `app/console/page.tsx` — Home
- `app/console/approvals/page.tsx`, `activity/page.tsx`, `strategy/page.tsx`,
  `guardrails/page.tsx`, `results/page.tsx`, `settings/page.tsx`
- `app/console/lib/` — `useConsoleData.tsx`, `api.ts`, `derive.ts`,
  `format.ts`, `useConsoleTheme.ts`
- `app/console/ui/` — `primitives.tsx`, `toast.tsx`, `sheet.tsx`
- `app/console/components/` — `shell.tsx`, `chrome.tsx`, `nav.tsx`,
  `approval-card.tsx`, `positions.tsx`, `needs-attention.tsx`,
  `policy-form.tsx`, `equity-chart.tsx`
- `app/console/README.md` — design-synthesis documentation
- `docs/rollouts/2026-07-02-console-ground-up-ui.md` (this note),
  `STATUS.md`, `PLAN.md` — handoff docs

## Verification (commands actually run)

```
npm run lint       # 0 errors (280 pre-existing warnings + 1 new grandfathered
                   #   react-hooks/set-state-in-effect warn on the poll bootstrap)
npx tsc --noEmit   # clean
npm test           # 225 files / 2189 tests, all passed
npm run build      # passes; all 7 /console routes prerendered static
```

Runtime smoke test (`npx next dev --webpack`): `/console`, `/console/approvals`,
`/console/activity`, `/console/strategy`, `/console/guardrails`,
`/console/results`, `/console/settings`, and `/api/dashboard` all answered 200.
No browser was available in this environment (Playwright download blocked by
the proxy), so hydration/visual checks still need a human pass.

## Notable pre-existing issue found (NOT from this branch)

`npm run dev` (Turbopack, Next 16 default) **500s on every route** on current
main: Tailwind v4's content scanner picks up the literal string
`shadow-[var(--shadow✱)]` (with a real asterisk where the ✱ is — reproduced
here with a lookalike so THIS note doesn't re-trigger it) from
`docs/rollouts/2026-07-01-ux-ia-aesthetics.md` (line ~133) as a class
candidate, emits it, and the generated CSS fails to
parse (`Unexpected token Delim('*')`). Reproduced with `app/console` removed
entirely. `next dev --webpack` and the CI build (`next build --webpack`) are
unaffected, which is why the verify gate stays green. Cheapest fix: break up
or backtick-escape differently that literal in the doc, or add `@source not`
for `docs/` — left to a follow-up since editing that historical rollout note
was out of this task's scope.

## Follow-ups

- Human visual pass (no browser available here): both themes, mobile
  breakpoints, and a real LIVE-account approval walkthrough.
- Fix the pre-existing Turbopack dev 500 (see above).
- Possible enhancements: SSE (`/api/events/stream`) to replace/augment the
  15 s poll; watchlist + price-alert management; chat/assistant surface;
  learning-approvals inbox (pending learned-context) alongside trade
  approvals; per-run full `signal_snapshot` forensics when an API exposes it.
- The console links nowhere from the legacy UI (by design). Entry point is
  `/console` directly.
