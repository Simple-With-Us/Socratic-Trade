# 2026-07-03 - Socratic Trade autonomy UI/runtime implementation

## Summary

Built the Socratic Trade autonomy direction into real app surfaces on branch
`codex/socratic-trade-autonomy-mockup`.

- Reworked `/console` into an Autonomy Desk centered on thesis, delegated action,
  evidence/RAG contribution, dissent, outcome learning, coaching, and framework
  improvement proposals.
- Added durable Socratic decision-case and framework-proposal persistence.
- Added `/api/socratic/*` routes for decision reads, coach-note appends, framework
  proposal reads, and framework proposal status updates.
- Wired strategy runs to record Socratic decisions for proposed, placed, blocked,
  broker-refused, human-review, and Socratic-override cases.
- Captured structured RAG attribution from retrieved chunks and exposed it in the
  dashboard snapshot and console.
- Added best-effort institutional-memory indexing for each strategy-recorded Socratic
  decision so proposed, blocked, and placed cases can be retrieved later as private
  RAG documents.
- Added Socratic override policy fields and runtime semantics: the agent may override
  owner preference gates in propose/execute mode, but hard broker/account/integrity/tax
  gates remain refusals.
- Added a coded product/site overview at `/design/socratic-trade`, made it public,
  and included it in sitemap/robots metadata.
- Reframed `/welcome` and `/how-it-works` around autonomous market reasoning and made
  both routes available by default.
- Replaced old production-domain references with `socratictrade.com`.
- Aligned active runtime/source identifiers and the iOS starter with Socratic Trade.

## Why

The owner wants Socratic Trade to behave like a delegated market-reasoning desk: it
should be able to make independent calls inside granted authority, show as much of its
"why" as possible, identify what retrieval/RAG contributed, record dissent, learn from
successes and failures, accept coaching, and propose improvements to its own framework.
This branch now implements the first durable pass behind that product contract instead
of leaving the UI as a static frame.

## Implementation Notes

- New `socratic_decisions` rows store the case-file: thesis, action, status, evidence,
  RAG attribution, dissent, outcome hooks, conflicts, override thesis, coach notes, and
  linked proposal/order/run ids.
- New `socratic_framework_proposals` rows store agent-authored framework changes with
  `proposed`, `accepted`, `rejected`, and `applied` states.
- `/console` reads persisted Socratic data first and falls back to current snapshot data
  when no case-file history exists yet.
- `/console/guardrails` now includes a Socratic override section for
  `socraticOverrideMode` and `socraticOverrideMaxPctOfNav`.
- `resolveSocraticOverride` separates overrideable owner-preference policy blockers
  from non-overrideable broker/account/integrity/tax refusals.
- `applySocraticOverrideSizing` can raise opening notional from available cash when a
  proposal includes `autonomyOverride.cashDeploymentPct`, capped by policy.
- Strategy prompts now include an `autonomyOverride` contract so the LLM can explicitly
  state when it wants to dissent from configured preferences and what would invalidate
  that decision.

## Files

Primary app/runtime files:

- `app/console/page.tsx`
- `app/console/console.css`
- `app/console/components/chrome.tsx`
- `app/console/components/nav.tsx`
- `app/console/components/shell.tsx`
- `app/console/guardrails/field-defs.ts`
- `app/console/guardrails/page.tsx`
- `app/api/socratic/decisions/route.ts`
- `app/api/socratic/decisions/[id]/coach/route.ts`
- `app/api/socratic/framework/route.ts`
- `app/api/socratic/framework/[id]/route.ts`
- `app/dashboard-types.ts`
- `app/welcome/page.tsx`
- `app/how-it-works/page.tsx`
- `app/strategy/page.tsx`
- `app/layout.tsx`
- `src/lib/db.ts`
- `src/lib/db-socratic.ts`
- `src/lib/dashboard.ts`
- `src/lib/defaults.ts`
- `src/lib/socratic-memory.ts`
- `src/lib/socratic-runtime.ts`
- `src/lib/strategy.ts`
- `src/lib/types.ts`
- `src/lib/account-deletion.ts`

Design/rebrand/supporting files:

- `app/design/socratic-trade/page.tsx`
- `app/design/socratic-trade/socratic-trade.module.css`
- `.gitignore`
- `app/sitemap.ts`
- `app/robots.ts`
- `middleware.ts`
- `.env.example`
- `ios/SocraticTrade/*`
- active identifier/domain cleanup files already listed in git status for this branch.

Tests:

- `test/socratic-runtime.test.ts`
- `test/socratic-db.test.ts`
- `test/socratic-memory.test.ts`
- `test/how-it-works-redirect.test.ts`
- `test/middleware-auth.test.ts`
- `test/account-deletion-coverage.test.ts` coverage remains green with new tables.

Docs updated:

- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-8-cockpit-ui.md`
- `docs/phase-10-signals-learning-ui-v2.md`
- this rollout note.

## Verification

Commands run:

```bash
npx tsc --noEmit
npx vitest run test/socratic-memory.test.ts test/socratic-runtime.test.ts test/socratic-db.test.ts
npx vitest run test/socratic-runtime.test.ts test/socratic-db.test.ts
npx vitest run test/socratic-runtime.test.ts test/socratic-db.test.ts test/account-deletion-coverage.test.ts
git diff --check
npm run lint
npm test
npm run build
pm2 restart trading-codex
node <route probe for /welcome, /how-it-works, /strategy>
node <playwright screenshot/status probe for /design/socratic-trade>
node <authenticated probe for /console and /api/socratic/*>
node <playwright screenshot/status probe for /console, /console/guardrails, /welcome, /how-it-works>
grep -nP '[^\x00-\x7F]' scripts/*.sh
perl -ne 'print "$ARGV:$.:$_" if /[^\x00-\x7F]/' scripts/*.sh
perl -ne 'print "$ARGV:$.:$_" if /[^\x00-\x7F]/' scripts/fetch-prod-ops-snapshot.sh
```

Results:

- `npx tsc --noEmit`: passed.
- Focused Socratic memory/runtime/db tests: passed.
- Focused Socratic tests: passed.
- Focused Socratic plus account deletion tests: passed.
- `git diff --check`: passed.
- `npm run lint`: passed with 0 errors and 303 existing warnings.
- `npm test`: passed after the Socratic memory and middleware public-route updates,
  243 files and 2361 tests.
- `npm run build`: passed after the public-route gate fix.
- `pm2 restart trading-codex`: passed; Codex preview is `http://localhost:4101`.
- `grep -nP '[^\x00-\x7F]' scripts/*.sh`: failed on macOS because BSD `grep`
  does not support `-P`.
- `perl -ne 'print "$ARGV:$.:$_" if /[^\x00-\x7F]/' scripts/*.sh`: found
  pre-existing non-ASCII in older scripts.
- `perl -ne 'print "$ARGV:$.:$_" if /[^\x00-\x7F]/' scripts/fetch-prod-ops-snapshot.sh`:
  passed with no output for the operator script touched by this branch.
- Route probe after restart: `/welcome` 200, `/how-it-works` 200, `/strategy` 307 to
  `/how-it-works`, `/design/socratic-trade` 200.
- Authenticated probe after restart: `/console` 200, `/api/socratic/decisions` 200,
  `/api/socratic/framework` 200.

Browser review:

- Desktop 1440x1000 and mobile 390x844 screenshots were captured for `/console`,
  `/console/guardrails`, `/welcome`, `/how-it-works`, and `/design/socratic-trade`.
- `/design/socratic-trade` Playwright pass: desktop and mobile returned 200,
  title `Socratic Trade Site · Socratic Trade`, H1 `An autonomy desk for decisions
  that can explain themselves.`, and no mockup text.
- `/welcome` and `/how-it-works` initially rendered 404 because they were still gated
  by `LANDING_PAGE_ENABLED`; the gate was removed and both routes now return 200 by
  default. `/strategy` now redirects to `/how-it-works` by default.
- Final public-page screenshots:
  - `artifacts/welcome-desktop.png`
  - `artifacts/welcome-mobile.png`
  - `artifacts/how-it-works-desktop.png`
  - `artifacts/how-it-works-mobile.png`
  - `artifacts/socratic-site-desktop.png`
  - `artifacts/socratic-site-mobile.png`

## Follow-ups

- Final land/PR still needs normal branch packaging once the owner is ready to merge
  this implementation branch.
- Production should only be updated through the normal PR/verify/deploy path.
- The next strategy improvement should score Socratic decisions against realized
  outcomes and use that score to rank future framework proposals.
