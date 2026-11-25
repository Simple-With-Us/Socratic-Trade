# 2026-11-24 — ST-4676 Web Console P0 Fixes

## 1. Context & Objective
ST-4676 (child of ST-4668) clears eleven P0 web-console defects from the ST-4637 audit follow-up.  The goal is correctness and honesty on the console: non-admins must not fire guaranteed-403 admin requests, every design token must resolve, account switching must stay guarded, links and labels must point at the real home, and dead placeholder copy and unused dependencies must go.

## 2. Changes Made
Admin-only operator panels are gated on the snapshot's isAdmin flag, the five undefined CSS tokens are swapped to their defined neighbours, the drawer's peer-account switch reuses the header's guarded switch, four link/label defects are corrected, the symbol drawer closes on navigation, the watchlist fails closed on 401, the alert-center placeholder rows are deleted, the decorative orbs are gated off under the console, two unused dependencies are removed and the tooltip portals into the console root, the overlays regime multi-select becomes a checkbox group, and RAG citations gain a Raw Chunk disclosure.

Exact files touched:
- `app/console/lessons/page.tsx` — client page; Learning Ledger mounts only for admins (item 1).
- `app/console/strategy/page.tsx` — Weight Tuning Preview mounts only for admins; `--con-surface-1`/`--con-text` swaps (items 1, 2).
- `app/console/strategy/tuning-dry-run.tsx` — unchanged; its `/admin/backtest-ic` link is now inside the admin-gated panel (item 1).
- `app/console/guardrails/stop-flow.tsx` — `--con-surface-1` → `--con-surface-2` (item 2).
- `app/console/ui/drilldown-sections.tsx` — `--con-ink` → `--con-fg`; Review link carries `?proposal=<id>` (items 2, 4a).
- `app/console/decisions/[id]/page.tsx` — `--con-bg-elev` → `--con-surface-2`; `all_openings` trigger label; RagItem Raw Chunk disclosure (exported for test) (items 2, 4b, 11).
- `app/console/components/model-stats-drawer.tsx` — `--con-border` → `--con-line` (item 2).
- `app/admin/enrichment-coverage/enrichment-coverage-client.tsx` — `--con-border` → `--con-line` (item 2).
- `app/console/lib/use-account-switch.ts` — NEW shared guarded account-switch hook (item 3).
- `app/console/components/chrome.tsx` — ScopeSelector reuses the shared hook; budget block points at Settings → AI Budget (items 3, 4c).
- `app/console/ui/symbol-drilldown.tsx` — PeerAccountSwitch routes through the dirty guard + shared hook (item 3).
- `app/console/guardrails/field-defs.ts` — stale limit-order hint (item 4d).
- `app/console/orders/page.tsx` — stale-threshold pointer corrected to Guardrails (item 4d).
- `app/console/ui/symbol-drawer.tsx` — close on pathname change (item 5).
- `app/console/watchlist/page.tsx` — 401 → redirectToLogin for reads and all four mutations (item 6).
- `app/console/components/alert-center.tsx` — placeholder RagInfoRow rows, grid, and not-yet-wired paragraph deleted (item 7).
- `app/globals.css` — orbs gated off under `.console-root` (item 8).
- `app/console/ui/primitives.tsx` — tooltip portals into the nearest console root; token hand-copy removed (item 9).
- `package.json` / `package-lock.json` — `motion` and `react-resizable-panels` removed (item 9).
- `app/console/strategy/overlays-panel.tsx` — regime `<select multiple>` → checkbox group (item 10).
- `test/console-web-p0-fixes.test.tsx` — NEW focused tests (items 1, 3, 4a, 4b, 5, 6, 11).

## 3. Decisions & Trade-offs
- Item 1 gates the panel MOUNT, which is what stops the ledger's mount-effect fetch (the guaranteed 403).  The `/admin/backtest-ic` link lives inside the gated tuning panel, so it is admin-only without a second gate.
- Item 3 extracts the header's activate → bypass-unload → reload logic into `useGuardedAccountSwitch` and reuses it in both places; the full reload is preserved (removing it is a separate owner decision).  The drawer's switch affordance is split into a `PeerAccountSwitch` child so its toast/guard hooks run only inside the console shell — /admin mounts the drawer without ToastProvider.
- Item 8 uses `body:has(.console-root)` to drop the orbs.  This is pixel-safe for the captured console surfaces because `.console-root` paints an opaque `--con-bg` across the full viewport, so the z-index -1 orbs were never visible behind console content.
- Item 9 resolves the tooltip's portal target in the layout effect and stores it in state, because refs may not be read during render (the eslint react-hooks rule).  `npm uninstall` also reclassified 55 transitive packages as dev-only (they were production-reachable only through `motion`); no package version, resolved URL, or integrity changed.
- Item 11 moves `RagItem` to `app/console/decisions/rag-item.tsx`, because Next route modules reject extra exports  the first full build failed there (`.next/types/app/console/decisions/[id]/page.ts(14,13)` TS2344 — `OmitWithTag` does not satisfy the `{ [x: string]: never }` constraint).  The citation anchor is also gated to `http(s)` schemes (a `javascript:` href is an XSS vector), matching the fleet's iOS citation gate.  Tests import the component from its new module.  No ApprovalCard link was added (it needs an out-of-scope lookup), and tests keep the repo's node-only vitest patterns (static render, capture harness, source wiring) — no jsdom or testing-library is installed.

## 4. Verification State
Commands run in the lane (Node 22; CI uses Node 26):
- `npx tsc --noEmit` — PASS (exit 0).
- `npm run lint` — PASS (exit 0; 0 errors, 914 pre-existing grandfathered warnings).
- `npx vitest run test/console-web-p0-fixes.test.tsx` — PASS (16 tests).
- `npx vitest run` over 15 existing suites covering the changed modules (operator-diagnostics-ui, console-decisions-index, drilldown-disclosure, console-ux-smalls, console-drilldown, console-overlays-max-active-commit, alert-center-incident-grouping, alert-mutes, model-stats-drawer, stop-flow-model, console-a11y, console-batch-a2-ux, console-home-proposal-confirm, copy-rules-lint, console-policy-diff) — PASS (196 tests).
- `node scripts/copy-rules-lint.mjs` — no NEW violations in touched files; the budget-note gap was fixed. The remaining reports are the pre-existing backlog (report-only title-case heuristic, and the peer-locked chrome.tsx sentence-gap backlog on untouched lines).
Lead full gate (Node 22 on this box; CI uses Node 26):
- `npm run build` — first run FAILED on the route-module export (TS2344 above); PASS (exit 0) after the `RagItem` extraction.
- Full `npm test` — ran green except the two environmental `cpuprofile-summary` failures (Node-22 env capture).
- `npx tsc --noEmit` — PASS (exit 0).
- Targeted suites after the fix — `console-web-p0-fixes` (16), `console-decisions-index` + `past-decision-cases` (25) — PASS.
- The Playwright e2e visual smoke is left to hosted CI (no change renders inside any captured surface).
## 5. Next Steps & Blockers
- Lead: gate is green (build PASS after the `RagItem` extraction; the full test run carries only the environmental `cpuprofile-summary` failures).  Push and open the PR (Fixes ST-4676), then queue for merge.  origin/main had moved to a61b531789 and #5474/#5475 merged since, so the push carries the upstream merge on top.
- Needs baseline regeneration for the listed `test/e2e/visual.spec.ts` captures: NONE.  No changed string or style renders inside the captured `/console`, header account/notifications/profile dropdowns, `/console/connections` api-keys delete confirm, or `/login` surfaces.
- Separate consideration: `test/e2e/admin-enrichment-coverage-visual.spec.ts` (not in the listed captures) may need regeneration because item 2 makes its table borders resolve to the defined `--con-line` token instead of an undefined var.  That is the intended fix, not a regression.
- The pre-existing copy-rule backlog (45 sentence-gap, 132 report-only title-case) is untouched; chrome.tsx is peer-locked and its backlog lines were not edited.

## 6. Zero-Code Findings
None.
