# Current Status

## 2026-07-12 — Whole-app audit reconciled, merged, and production-verified (CODEX)

The canonical 34-finding inventory is restored in both effort boards after PR #1459's follow-up
commit incorrectly deleted the issue-level rows. PR #1459 merged as `f066ea9d`; hosted verify,
smoke, and gitleaks passed. Production release `17b707ff` contains that merge and reports healthy
DB, scheduler lease/tick, and Litestream replication; Alpha Vantage remains the known noncritical
daily-cap degradation.

Current issue truth is **8 resolved/live, 13 partially mitigated but open, and 13 unresolved**. Five
of eight P0s are resolved; broker-health admission, account draining, and stale-exit replacement
remain partially mitigated and explicitly open. Node stays on 24 LTS; Node 26 remains a future
coordinated canary/migration after it reaches LTS, not a fix for mixed native-module artifacts.
Rollout: `docs/rollouts/2026-07-12-app-wide-audit-closeout.md`.

## 2026-07-12 — Raise RAG Ingestion Limits and Deepen Filing Lookback (Antigravity, branch `agent/antigravity-rag`)

Raised RAG ingestion daily caps (`RAG_INGEST_MAX_TEXTS_PER_DAY` to 1,000,000, `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY` to 10,000,000) and deepened the SEC filing lookback depth (`fetchRecentFilings` pulls 10 historical 10-K and 10-Qs, `DEFAULT_PAID_MAX_FILINGS_PER_RUN` bumped to 200) to allow massive historical ingestion of information into Pinecone.
Verified full health via `tsc`, `lint`, and 3896 passing tests.
Rollout: `docs/rollouts/2026-07-12-rag-ingestion-limits.md`.
## 2026-07-12 — Quiver Quant API Integration & FMP Endpoint Expansion (AG, branch `agent/antigravity`)

Integrated the Quiver Quant API into the backend application. Added Quiver Quant key support in `src/lib/db-api-keys.ts` and `app/api/keys/route.ts`. Created `QuiverQuantEnrichmentProvider` in `src/lib/data-providers.ts` and injected it into the main cascading enrichment workflow. Expanded the existing `FmpEnrichmentProvider` to utilize `/v3/key-metrics-ttm` and `/v3/financial-growth` endpoints. Updated `MarketQuote` and `SymbolEnrichment` structures in `src/lib/types.ts`. All test suites updated to reflect the new 6-endpoint FMP fetch count.
Passed 3896 tests and clean build.
Rollout: `docs/rollouts/2026-07-12-quiver-quant-fmp.md`.

## 2026-07-12 — Web App UI Refresh (Antigravity, branch `agent/antigravity`)

Successfully migrated the web application settings pages to use an iOS native-inspired aesthetic ("Inset Grouped" lists, edge-to-edge content on small viewports, semantic grouping) to match the new native iOS app design. Overhauled `app/ui/ios-components.tsx` and all files under `app/console/settings/*.tsx`.
Verified full health via `tsc`, `lint`, 349/3896 passing tests, and clean production build.
Rollout: `docs/rollouts/2026-07-12-ios-ui-refresh.md`.


## 2026-07-12 — Merge origin/main, resolve .gitignore conflict (CLAUDE, branch `claude/fleet-skills`)

Merged latest `origin/main` to resolve CONFLICTING merge state on PR #1470. Only conflict was
`.gitignore` (PR branch tracks `!.claude/skills/`, main had the old blanket `.claude/` ignore —
kept PR branch version). All Codex review threads were already resolved; no new findings to
address. Verify trio: tsc clean, 349 files / 3896 tests passed, build clean.
Rollout: `docs/rollouts/2026-07-12-codex-triage-fleet-skills.md`.

## 2026-07-11 — Fleet-procedure skills: land-lane/unstick-pr/codex-triage/pickup-seat/deploy-verify (CLAUDE, branch `claude/fleet-skills`)

Owner-directed: encoded five pickup-era fleet procedures as on-demand Claude Code skills under
`.claude/skills/` (`land-lane`, `unstick-pr`, `codex-triage`, `pickup-seat`, `deploy-verify`)
instead of re-spelling them per-prompt. `.gitignore` now carves out `!.claude/skills/` from the
otherwise-ignored `.claude/` directory (per-agent local settings/hooks stay ignored) so these five
files are tracked. Skills are Claude Code-only — cross-agent rules remain in `AGENTS.md`, which
every skill cites as canon alongside the relevant rollout notes. Rollout:
`docs/rollouts/2026-07-10-fleet-procedure-skills.md`.
## 2026-07-11 — Native iOS App Overhaul (Antigravity, branch `agent/antigravity`)

Completely replaced the legacy iOS starter app with a modern SwiftUI application (`ios/`). Initialized via `xcodegen`. Built the initial SwiftUI scaffold (`ios/`) with tabbed views: Dashboard, Proposals, and Watchlist. Implemented `MobileStore` for persistence and `MobileAPIClient` for API communication. Auth flow (OAuth via `ASWebAuthenticationSession`) and `/api/mobile/auth-redirect` route are still pending implementation on the `agent/antigravity` branch. Assessed Cloudflare hosting for the mobile backend vs. Hetzner, deciding to keep it on Hetzner to avoid database splitting. Verified build via `xcodebuild`. Rollout: `docs/rollouts/2026-07-11-native-ios-app.md`.


## 2026-07-11 — Settings + LLM telemetry sweep (CLAUDE, branch `claude/settings-llm-usage-sweep`)

Implementation complete: 7-item owner batch delivering unified LLM usage labels, strategy
reviews persisted server-side with unapplied-restore on mount, account-attribution fix
(root cause: multi-account review costs were filed under `is_active` account not the
initiating account — explains owner's "missing" Fable Roth-IRA cost), cross-account
settings import with lineage tracking, framework-page grid layout fixes, strategist
model-cost drawer, and telemetry coverage closure (benchmark, eval, salience now all
recording). All gates passing (tsc, lint, focused suites 10/10+8/8+21/21+118/118),
full gate running at doc-write time. PR opening. Rollout: `docs/rollouts/2026-07-11-settings-llm-usage-sweep.md`.
## 2026-07-11 — Team display names back to Green Team / Red Team (CLAUDE, branch `claude/team-names-green-red`)

Owner-directed copy rename: console UI had drifted to "Proposer"/"Reviewer" for the two team
seats; all user-visible labels now lead with Green Team / Red Team (Framework page model pickers +
hints + fallback field + provider line + save-error titles, model-stats drawer, results veto
columns, policy-route rejection copy, llm-required message, approval-card trigger title, settings
help). Display strings only — internal identifiers/API fields/LLM prompts untouched. Rode along:
fixed the help definition that still claimed a blank Red Team "reviews itself" (wrong since the
single-adversary consolidation — blank fails closed to human approval). tsc clean; focused tests
green. Rollout: `docs/rollouts/2026-07-11-team-names-green-red.md`.

## 2026-07-11 — Metadata routes were auth-gated in prod (CLAUDE, follow-up to /framework page)

Live verification of the deployed /framework hardening (PR #1460, `0f894d16` — edge WAF 403s
scraper UAs, prose absent from HTML, noai/TDMRep headers live, content API gated) surfaced a
pre-existing production gap: `middleware.ts` auth-gated `/robots.txt`, `/sitemap.xml`, and
`/manifest.webmanifest` (anonymous 307 → /login), so robots/noai rules never reached crawlers —
a redirected robots.txt parses as "no rules". Fix: the three metadata paths added to
PUBLIC_PREFIXES + regression test (auth armed → 200). Rollout (appended):
`docs/rollouts/2026-07-11-framework-page.md`.

## 2026-07-11 — Trading-framework doc + public /framework page + AI-scrape hardening (CLAUDE, branch `claude/trading-framework-docs-713061`)

Owner-requested framework explainer shipped three ways: (1) `docs/trading-framework.md` — net-new
framework-level map of the entire trading pipeline (8-stage summary, layer-by-layer detail, core
invariants, honest weaknesses; derived from an 11-subsystem parallel code-reading pass, not from
older docs; explicitly does not supersede strategic-framework/phase-7/single-adversary). (2) A
public human-eyes-only page at `socratictrade.com/framework` following the how-it-works pattern
with three themed SVG diagrams (pipeline loop, layer stack, learning flywheel). (3) Layered
anti-extraction hardening: the prose lives in a server-only module served by a gated content API
(custom header + same-origin fetch metadata + UA gate) so it never appears in HTML or client
chunks; UA blocklist enforced in the page, the API, robots.txt AI-crawler rules, noai/noindex/
TDMRep headers, no-store, sitemap exclusion, no inbound links; PLUS live Cloudflare zone edge
hardening (ai_bots_protection=block + a /framework* WAF UA rule — Bot Fight Mode deliberately NOT
enabled to protect webhook/ops traffic). Focused tests 9/9 green; tsc clean after npm ci (stale
shared-pkg pin); dev-server curl + browser verification done (found and fixed a
background-tab-stranding rAF bug in the client fetch gate). Full Node 24 gate + land.sh pending
the fleet gate window (CODEX app-wide-audit gate active at write time). Rollout:
`docs/rollouts/2026-07-11-framework-page.md`.
## 2026-07-11 — Whole-app audit + prioritized correctness fixes (CODEX, in progress)

Current `main@4c5a246b` is live and publicly healthy, but the audit found a P0 account-isolation
race in the console. The global account selector bypasses the existing unsaved-changes guard, while
Mandates and Framework keep account-specific drafts/autosave state mounted across a scope change.
Their `savePolicy` calls carry no target account; `/api/policy` resolves the active account only when
the request executes. A draft or in-flight save that originated on Account A can therefore be shown
or committed on Account B. The primary fix is implemented on `codex/app-wide-audit-20260711`:
dirty scope switches are intercepted, account-specific editors remount, mutations carry an
ownership-validated origin account, all same-tab policy writes serialize across cards, busy state
tracks the real queue, and prompt+policy persistence is validation-first/transactional. Node 24
focused verification is green: TypeScript plus 4 policy suites / 21 tests.

Three independent read-only lanes also verified and placed **33 additional non-duplicate issues** on
both effort boards: 7 P0, 18 P1, and 8 P2 across order/fill/risk accounting, inactive-account context,
mobile truth/accessibility, OAuth and middleware composition, webhook/SSRF/resource bounds, scheduler
hangs, onboarding rollback, and health/readiness truth. Including the active account-scope defect,
the audit tracks 34 findings (8 P0 / 18 P1 / 8 P2). Five are fully implemented on this branch:
account-scope isolation, synthetic-stop account routing, mobile initial-state truth, mobile command
preservation/readiness, and Robinhood OAuth exact-state/origin/session integrity. The core mobile
refresh race is also fixed with a deadline, coalesced trailing refresh, freshness gating, and focus/
visibility recovery; only health-aware fallback polling during an SSE outage remains for that row.
Adversarial review found and closed a native-beforeunload split-brain edge plus spoofable synthetic
routing fields. Combined Node24 focused verification is green: TypeScript, touched lint 0 errors /
6 inherited warnings, and 6 files / 85 tests. Production browser smoke covered Console, command
palette, and Orders with no console errors; public health reported exact live release `4c5a246b` and
green DB/scheduler/Litestream.

The full-gate test suite has now cleanly passed: `npm run lint` (0 errors / 402 warnings), `npx tsc --noEmit` (no errors), `npm test` (all 345 suites / 3836 tests passed), and `npm run build` completed successfully. The branch is now fully verified and ready for deployment. See
`docs/rollouts/2026-07-11-app-wide-audit-account-scope.md`.

## 2026-07-11 — Truthful notification delivery status (CODEX, current-main replacement branch)
## What was just completed
- Fixed `web-sources-sec.test.ts` dynamic dating issue which was causing the 30-day cutoff to fail once the static `2026-06-12` date aged out.
- Fixed `order-replacement.test.ts` to expect `pending_cancel` logic.
- Fixed TS2345 in `congress-analytics.ts` where `null` symbols could cause crashes.
- Verified completion of P1 items: Roth IRA truncation token cap raised to 4000+, `tradeThesisTag` coalescing in DB queries, and reflection dedupe signatures scoped per account.
- Implemented and verified LLM Failover UI and architecture.

## What's blocking / unresolved
- Nothing. All P1 and P2 items specified in the current sprint are complete.

## Next Action
- Land changes to main via `land.sh`.
