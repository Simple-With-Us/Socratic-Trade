# 2026-07-03 — Remove paper-as-default + Test mode (owner directive)

## Summary
Owner directive, repeated and emphatic: this is a **real trading app**, the owner accepts 100% risk,
and the paper-mode reverence + local "Test mode" simulator must go — along with any "protect the
owner's money from agent bugs" paternalism. This lane executes it in two steps.

**Step 1 (this commit — rules, the root cause):** `AGENTS.md` (== `CLAUDE.md` symlink) rewritten:
- Deleted the Don't-rule *"Don't place real trades or toggle `paperMode:false` while testing — Paper
  mode is the default for a reason."*
- Deleted the *"defaults to Test mode (a local SQLite simulator)"* framing; clarified `DATABASE_URL` /
  `data/app.db` is app **infrastructure** (settings/proposals/users), not a fake execution mode.
- Added a top **"Product philosophy — real trading, owner's risk"** section: an account is an account
  (a broker paper account is just a connected account by `environment`, not a safe-mode); no
  Test-mode/local-sim; don't protect the owner from accepted risk; **harden CORRECTNESS + multi-user
  safety, NOT obedience** — guardrails are the owner's overridable preferences (the
  `iraWashSaleHandling: "disregard"` setting is the template), never an immovable cage or a scolding
  ritual.

This is the root-cause fix: the paper/test paternalism was encoded in the agent rules themselves, so
every tool (Claude, Codex, …) kept re-imposing it. Deleting the rule stops the loop.

**Step 2 (in progress — code, separate PR):** remove the execution-layer implementation:
- `src/lib/execution-mode.ts` — `deriveExecutionState` currently returns `test/local`
  (`usesLocalSimulation: true`) whenever `policy.paperMode` is set OR no account is connected. Collapse
  to: account present ⇒ `broker/paper` | `broker/live` by `account.environment`; no account ⇒ the app
  cannot place orders (no local-sim fallback). Drop `usesLocalSimulation` / the `test/local` mode / the
  `Test` label / mock theme.
- Cascade: `strategy.ts` (the `usesLocalSimulation` paper-fill branch + `getPaperPortfolioProjection`),
  `dashboard.ts` (local portfolio projection), `preflight-live-guard.ts`, `defaults.ts` (`paperMode`
  default), `db-profiles`, `synthetic-stops`, `tax`, `scheduler`, `mobile-api`, and the `paperMode`
  policy field.
- ~36 test files rely on Test mode to run without a broker — rewrite them onto a connected test/mock
  broker account (`TestBrokerGateway`) so the suite still runs. Keep `DATABASE_URL`/temp-DB (infra).
- Land in coherent, individually-green pieces (money-path; not one reckless bang).

## Why
The owner has said this for weeks. The behavior persisted because it was baked into the agent rules
and the execution layer. Fixing the rules stops re-imposition; removing the code delivers the actual
product change (the app trades through a real broker connection, paper or live, with no fake mode).

## Files (Step 1)
- `AGENTS.md` (philosophy section + deleted rules), `STATUS.md`, `docs/EFFORT-LOG.md`,
  `docs/rollouts/2026-07-03-remove-paper-default-test-mode.md`.

## Verification (Step 1)
Docs-only (no source touched). `npx tsc --noEmit` clean · `npm run lint` 0 errors · `npm run build`
green. **`npm test`:** initially RED for a **pre-existing, unrelated** reason — today (2026-07-03) is
the observed US July 4 market holiday, so `isTradingDay()` was false and `runStrategyOnce`'s
market-closed guard (`src/lib/strategy.ts:252`) skipped every non-manual run, failing the ~17 strategy /
persistence assertions that expect a run to execute (llm-failover, money-path-f-g,
moneypath-drawdown-flip, rationale-collapse, bear-fail-closed, bull-truncation, persistence-notification,
redteam-observability). Those tests don't mock the calendar, so they were time/holiday-dependent — and
weekends would keep CI red through Mon, blocking #339, the rebrand, and the Step-2 PR.

**Fixed here (2026-07-03), on this same #339 branch, centrally — NOT per-test-file:** `isTradingDay`
now takes an optional date and, for the no-argument "today" call only, returns true when
`AGENTIC_TEST_FORCE_TRADING_DAY=1`. That flag is set ONLY by `vitest.config`'s `test.env`, never in
production; an explicit-date call always uses the real calendar, so `market-hours.test.ts` /
`token-budget-ceiling.test.ts` still assert real closures. This is deliberately **zero test-file
edits** so it does NOT collide with the in-flight Step-2 branch (`claude/remove-paper-test-mode`),
which owns those ~36 test files. Files: `src/lib/market-calendar.ts`, `vitest.config.ts`. Re-verified:
full suite **2365 passed**, tsc clean, lint 0 errors. Step-2 should therefore NOT re-add per-file
`isTradingDay` mocks — the calendar is already deterministic in tests.

## Codex review round (2026-07-03, commit after 10140b5)
Two P2 review comments on #339, both addressed:
1. **Guard the test-only trading-day override** — the seam could defeat the real market-closed guard if
   `AGENTIC_TEST_FORCE_TRADING_DAY` ever leaked into a dev/prod shell. Fixed: the override is now ALSO
   gated on `process.env.VITEST` (a signal only the Vitest runner sets, never present in a real
   runtime), so it is inert outside tests regardless of any stray flag. `market-calendar.ts` +
   `vitest.config.ts` comments updated to match.
2. **Remove the conflicting Cursor rule** — `.cursor/rules/handoff.mdc:39` still said "Never place real
   trades or set `paperMode: false` — Paper is the default," which Cursor auto-loads and which
   re-imposes the exact paternalism this PR deletes. Rewrote that guardrail to the new philosophy (real
   trading, owner's risk; no Test-mode/`paperMode` default; an account is an account; keep the
   typed-confirm ritual before a live toggle; harden correctness, not obedience). Historical
   `docs/reviews/2026-07-01-audit-work-split.md` copies are point-in-time records, left as-is.

## Step 2 (this commit set — code removal, same branch `claude/remove-paper-test-mode`)

Delivers the code change Step 1's rules promised. Merged `origin/main` (bringing in #339's CI
holiday-flake fix and the Socratic Trade rebrand) partway through so the branch builds on top of both
rather than diverging.

### What changed
- **`policy.paperMode` deleted** from `TradingPolicy` (`src/lib/types.ts`), `DEFAULT_POLICY`
  (`src/lib/defaults.ts` — also dropped `paperStartingCash`), every read/write site, `/api/policy`
  (via `src/lib/mobile-api.ts`'s `normalizePolicyPatch` forbidden/numeric field lists), and the
  console + legacy Settings/Guardrails UI toggles. Legacy stored-JSON policies still carrying
  `paperMode`/`dryRun`/`paperStartingCash` are stripped on load by `mergePolicy` in both
  `src/lib/db.ts` and `src/lib/db-profiles.ts` (documented as intentional legacy-shim, not new
  functionality).
- **`test/local` execution mode deleted.** `ExecutionMode` (`src/lib/types.ts`) is now just
  `"broker/paper" | "broker/live"`. `usesLocalSimulation`, `getPaperPortfolioProjection`
  (`src/lib/performance.ts`, ~85 lines), the local paper-fill auto-execute branch in
  `runStrategyOnce`/`executeProposal` (`src/lib/strategy.ts`), and the local portfolio projection in
  `src/lib/dashboard.ts` are gone.
- **`deriveExecutionState` (`src/lib/execution-mode.ts`) rewritten as the sole hub.** Single signature
  `deriveExecutionState(policy, activeAccount?)` (dropped the boolean overload). With a connected
  account: mode is `broker/paper`/`broker/live` purely from `account.environment`. With **no**
  connected account: returns `{ mode: undefined, label: "No account", submitsBrokerOrders: false,
  clarification: "No connected broker account. Connect a broker account (paper or live) before the
  app can place orders." }` — an honest terminal state, not a fake-fill fallback.
- **Order-placement paths now explicitly refuse to run with no account**, instead of silently
  defaulting to the test gateway: `runStrategyOnce`, `executeProposal`
  (`src/lib/strategy.ts`), `withLivePreflight`/`resolveGateway` (`src/lib/broker.ts` — throws "No
  connected broker account..." for an unrecognized/absent `activeBroker` instead of falling back to
  `TestBrokerGateway`), `order-replacement.ts`, `synthetic-stops.ts`.
  `preflight-live-guard.ts`'s `LivePreflightInput` simplified to just `{ mode, allowLive?, symbol?,
  side? }` — the `ALLOW_LIVE_TRADING` env gate for `broker/live` is kept (legitimate correctness
  hardening, not paternalism).
- **Correctness bug found and fixed along the way**: broker-paper fills were mislabeled "Test"
  throughout the Activity feed and notification titles (`src/lib/dashboard-feed.ts`,
  `src/lib/dashboard-ui.ts`) purely because they shared `FillSource: "paper"` with the removed local
  simulator. Now labeled "Paper", matching the real broker-paper account they came from. Also removed
  the `isLocalTestMode` bypass in `dashboard.ts`'s `accountReadinessForSnapshot` — a `broker:"test"`
  account now goes through the exact same readiness path as any other broker, no special-case.
- **Console UI**: renamed the "test" reality tone to "none" throughout (`app/console/lib/derive.ts`,
  `app/console/components/chrome.tsx`, `app/console/ui/primitives.tsx`,
  `app/console/console.css` — `con-chip-test`→`con-chip-none`, `--con-test*`→`--con-none*`); copy
  changed from "Local Simulation"/"TEST · practice money" to "No Account Connected"/"NO ACCOUNT · no
  account connected". `app/console/orders/page.tsx` and `app/console/assistant/draft-card.tsx` copy
  updated similarly. `app/dashboard-client.tsx` had dead code removed (`requestModeSwitch`, an
  unreachable live-confirm modal) and its `executionModeLabel`/`getPortfolioAccountSubtitle`/
  `executionBanner` updated for the "No account" state; also fixed a latent bug where the P&L side
  shown was `usesLocalSimulation ? "paper" : "live"` (always "live" for a real broker-paper account)
  — now correctly `executionState.mode === "broker/live" ? "live" : "paper"`.
- **`TestBrokerGateway`/`broker: "test"` intentionally kept** as TEST INFRASTRUCTURE only (so the unit
  suite runs without hitting real Alpaca/Robinhood) — comments in `src/lib/db-api-keys.ts` and
  `src/lib/robinhood.ts` clarify it is not a product-facing mode. ~36 test files that relied on
  `paperMode: true` (⇒ old local sim) were migrated to instead create a connected test-broker account
  (`broker: "test"`, `environment: "paper"`, via `upsertConnectedAccount`) so execution flows through
  the normal broker path via `TestBrokerGateway`, exercising the real code paths instead of a bypass.

### Files
Full list in commit `aceff17`: `src/lib/{types,defaults,execution-mode,preflight-live-guard,broker,
broker-protective-stops,dashboard,dashboard-feed,dashboard-ui,db,db-profiles,db-api-keys,mobile-api,
order-replacement,performance,post-mortem,red-team,strategy,strategy-prompts,strategy-tuning,
synthetic-stops,execution-cost,observability,robinhood}.ts`; `app/{dashboard-client,ui/strategy-flow,
console/lib/derive,console/components/chrome,console/orders/page,console/ui/primitives,
console/assistant/draft-card,console/console.css}`; ~36 `test/*.ts` files migrated off
`paperMode`/`test/local`. Plus two post-merge test fixes (`test/dashboard-feed.test.ts`,
`test/dashboard-fill-batching.test.ts`) needed after merging `origin/main`'s unrelated changes, and
the `AGENTS.md` stale in-progress warning replaced with a pointer to this note.

### Verification
`npx tsc --noEmit` clean · `npm run lint` 0 errors (303 pre-existing grandfathered warnings) ·
`npm test` **2349/2349 passing across 238 files** · `npm run build` green (full route manifest
generated, no new errors).

### Follow-ups
- Re-scanned `STATUS.md`/`docs/EFFORT-LOG.md`/`AGENTS.md`/`PLAN.md`/`README.md` for stale "Test
  mode"/"paper default" language as part of this same doc pass.
- Watch for Codex review comments on the PR; the pattern from #339 was 1-2 rounds of hardening
  suggestions on the seam/edge cases.
