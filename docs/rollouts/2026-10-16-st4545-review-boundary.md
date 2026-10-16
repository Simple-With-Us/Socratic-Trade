# ST-4545 review boundary follow-up

## Context and objective
Audit PR4789 reviews against live549aba947, fix real boundary/timeout/error-suppression gaps, and inspect integrated API-key route chips.

## Changes
- src/lib/llm-reasoning.ts: pure model/reasoning exports extracted; llm-request re-exports for compatibility.
- Six app/console consumers now import the pure module.
- src/lib/code-cli.ts: server-only marker; preserve caller cancellation/deadline,150s fallback.
- src/lib/strategy.ts: exact known unconfigured CLI error skip with audit; unexpected errors propagate.
- test/code-cli.test.ts: caller signal and timeout regression.
- test/e2e/code-cli-chips.spec.ts: actual Connections page with mocked status-only keys; screenshot artifact.
- STATUS.md, PLAN.md and broker contract updated.

## Decisions and tradeoffs
Sentinel and chat schema unchanged per scope. Prior unguarded parse/chat userId/fallback crash reports were stale. Strict limited envelope suggestion would reject valid role/finish_reason. Browser test is actual integrated card, not an isolated selector. Animated background canvas is hidden for deterministic card pixels. No pixel baseline asserted; screenshot artifact plus functional assertions do not replace the existing visual baseline workflow.

## Verification
- npx tsc --noEmit -> ok
- npm run build -> ok (existing Sentry warnings; completed TypeScript/page generation)
- npx vitest run test/code-cli.test.ts test/code-cli-routing.test.ts test/llm-request.test.ts test/strategy-llm-failover.test.ts test/red-team-empty-failover.test.ts test/chat-llm.test.ts ->97pass
- npx playwright test -c /tmp/st4545-playwright.config.cjs ->1pass (installed local Chrome, isolated local built app)
- Focused ESLint ->0errors49warnings in existing large modules
- git diff --check -> ok
- Visually inspected actual desktop828px card and390px mobile viewport; chips/selectors legible and wrapped. Mobile fixed nav can overlay below viewport; not a new route-control defect.

## Next steps and blockers
Maintainer owns workflow approvals/review/merge. Broker source remains untracked staging, not part of this commit or ready for activation. No credentials, live provider requests, production writes or workflow approvals.
