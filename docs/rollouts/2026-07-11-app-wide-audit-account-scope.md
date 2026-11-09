# 2026-07-11 - app-wide audit and account-scope write isolation

## Summary

- Started a current-main audit across production UI/runtime behavior, API/security boundaries,
  trading/data correctness, tests, dependencies, and effort-board truth.
- Confirmed a P0 console race: account-specific drafts and autosaves can outlive an active-account
  switch, while targetless policy requests resolve whichever account is active when they run.
- Added 33 further non-duplicate rows to both effort boards. With the account-scope defect, the audit
  currently records 34 findings: 8 P0, 18 P1, and 8 P2.
- Implemented the account-scope fix: origin-account targeting/ownership checks, dirty-switch
  interception, account-keyed editor remounts, full reload after active-account mutation, shared
  same-tab policy-write serialization, truthful queued-save busy state, and validation-first atomic
  prompt/policy persistence.
- Implemented three source-disjoint remediations in parallel: synthetic-stop account targeting,
  mobile initial-state/command truth, and Robinhood OAuth exact state/origin integrity.
- Adversarial review found and fixed a post-activation native-beforeunload split-brain edge and
  spoofable synthetic account-number/broker policy fields.
- Implemented the core mobile refresh reliability slice: 45-second abort deadline, coalesced trailing
  refresh, freshness-gated commands, explicit stale state, and focus/visibility/online recovery.

## Why

- Mandates and Framework explicitly promise that their values apply to "this account only". The
  existing client and route contract did not preserve that promise across an account switch or an
  in-flight autosave.

## Files

- `app/api/policy/route.ts`
- `app/api/auth/robinhood/callback/route.ts`
- `app/console/components/chrome.tsx`
- `app/console/components/policy-form.tsx`
- `app/console/guardrails/page.tsx`
- `app/console/lib/api.ts`
- `app/console/lib/useAutoSave.tsx`
- `app/console/lib/useDirtyGuard.tsx`
- `app/console/settings/brokers.tsx`
- `app/console/strategy/page.tsx`
- `app/console/strategy/tax-settings.tsx`
- `app/mobile/mobile-pwa-client.tsx`
- `src/lib/db-settings.ts`
- `src/lib/mcp-oauth.ts`
- `src/lib/public-origin.ts`
- `src/lib/synthetic-stops.ts`
- `test/console-policy-write-queue.test.ts`
- `test/mcp-oauth.test.ts`
- `test/mobile-pwa-client.test.tsx`
- `test/policy-account-target.test.ts`
- `test/public-auth-rate-limit-hardening.test.ts`
- `test/synthetic-stops.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`

## Verification

- `PATH=/Users/jay/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npx tsc --noEmit` — passed on unmodified current-main source before implementation.
- The same Node 24 TypeScript command passed after the combined implementation.
- Combined focused Vitest command across policy targeting/queue, synthetic stops, mobile PWA, OAuth,
  and public callback hardening — 6 files / 85 tests passed.
- Touched ESLint — 0 errors; 6 inherited warnings in pre-existing console/mobile paths.
- `git diff --check` — passed.
- First serialized repository gate attempt: `npm run lint` passed with 0 errors / 402 inherited
  warnings; `npx tsc --noEmit` passed. `npm test` was stopped after unrelated hook/test timeouts while
  host load was 150 (Alpaca brackets/MCP, account deletion, drawdown, circuit breaker, e2e money path);
  build was not run. The same unrelated set still timed out in a six-file rerun at load 59. Per the
  canonical protocol, neither load-contaminated run is treated as code evidence.
- Production Browser smoke: `/console` and `/console/orders` rendered with no console warnings or
  errors; command-palette open/close and Orders navigation worked. Mobile viewport override was not
  honored by the available browser backend, so mobile rendered QA remains pending.
- `curl https://socratictrade.com/api/health` — `ok=true`, exact release `4c5a246b`, DB/scheduler/
  Litestream healthy; Alpha Vantage is the only reported degraded dependency.

## Follow-ups

- Run the serialized full repository gate, land through a ready PR, and verify the auto-deployed exact
  revision/health before marking implemented rows complete.
- Add health-aware fallback polling for a confirmed mobile SSE outage; the rest of the mobile
  freshness/ordering row is implemented here.
- Address the remaining 29 rows in priority/source-disjoint follow-up lanes; do not blur Planned,
  implemented, merged, and live states.
- Reconciled stale UI wave #1277 and loading-permafix #1339 rows to their ancestor-verified merged state;
  the older 55-finding UI inventory still needs a dedicated row-by-row mirror cleanup.
- Run the ordered full gate only after the active serialized `drizzle-kit` gate clears.

## Blockers

- The prior drizzle cleanup claim was correctly treated stale, but multiple API Usage Monitor/shared
  package/build/cleanup lanes then overlapped despite fleet HEADS-UP messages. The first full-test run
  hit load 150; macOS `secd`/`syspolicyd`/`trustd` indexing remains load-dominant after those commands
  stopped. Wait for load below ~30, post a fresh gate claim, then rerun test/build before push/PR.
