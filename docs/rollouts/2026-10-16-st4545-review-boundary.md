# ST-4545 review boundary follow-up

## Context and objective
Audit PR #4789 reviews against live 549aba947, fix real boundary/timeout/error-suppression gaps, and inspect integrated API-key route chips.

## Changes
- src/lib/llm-reasoning.ts: pure model/reasoning exports extracted; llm-request re-exports for compatibility.
- Six app/console consumers now import the pure module.
- src/lib/code-cli.ts: server-only marker; preserve caller cancellation/deadline, 150s fallback.
- src/lib/strategy.ts: exact known unconfigured CLI error skip with audit; unexpected errors propagate.
- test/code-cli.test.ts: caller signal and timeout regression.
- test/e2e/code-cli-chips.spec.ts: actual Connections page with mocked status-only keys; screenshot artifact.
- STATUS.md, PLAN.md and broker contract updated.

## Decisions and tradeoffs
Sentinel and chat schema unchanged per scope (the chat schema was later made strict; see the review sweep below).  Prior unguarded parse/chat userId/fallback crash reports were stale.  Strict limited envelope suggestion would reject valid role/finish_reason.  Browser test is actual integrated card, not an isolated selector.  Animated background canvas is hidden for deterministic card pixels.  No pixel baseline asserted; screenshot artifact plus functional assertions do not replace the existing visual baseline workflow.

## Verification
- npm run lint -> 0 errors, 871 existing warnings (full run, CLAUDE sweep after merging main)
- npx tsc --noEmit -> ok
- npx vitest run test/code-cli.test.ts test/code-cli-routing.test.ts test/chat-llm.test.ts test/llm-request.test.ts test/llm-reasoning.test.ts test/strategy-llm-failover.test.ts test/red-team-empty-failover.test.ts test/copy-rules-lint.test.ts -> 143 pass
- npm run build -> ok (compiled with existing warnings; CLAUDE sweep after merging main)
- npx playwright test -c /tmp/st4545-playwright.config.cjs -> 1 pass (ECHO, installed local Chrome, isolated local built app)
- git diff --check -> ok
- Visually inspected actual desktop 828px card and 390px mobile viewport; chips/selectors legible and wrapped.  Mobile fixed nav can overlay below viewport; not a new route-control defect.

## Next steps and blockers
Maintainer owns workflow approvals/review/merge.  Broker source remains untracked staging, not part of this commit or ready for activation.  No credentials, live provider requests, production writes or workflow approvals.

## All-comment audit follow-up
Read all eleven inline Kody comments, thirteen review entries and five conversation comments at head 0c7e6c19e.  Existing test/llm-request.test.ts already exercises these extracted helpers through the compatibility re-exports, so the claim of zero coverage is overstated.  Added test/llm-reasoning.test.ts with 25 direct tests for capability families, fast-tier clamping, GPT-5.5 override, rotation fail-closed resolution and reviewer fallback.  Focused ESLint and npx tsc --noEmit pass; 57 tests across four focused files pass.  No runtime changes.

Screenshot comments remain partially addressed: the integrated real-page spec asserts chips and selectors and retains inspected PNGs, but has no committed toHaveScreenshot baseline.  Do not claim it meets the pixel-regression requirement.  Baseline must be generated and reviewed using the CI browser/platform.  Sentinel and strict response schema suggestions remain disputed and unchanged under current scope.  The strict suggested envelope omits the adapter's legitimate role/finish_reason fields.  Request bodies are explicitly reconstructed before broker forwarding; arbitrary caller properties do not cross.

## Review sweep (CLAUDE, October 16)
- Merged origin/main into the branch (no conflicts).
- CI was red on this PR's own copy: `test/copy-rules-lint.test.ts` found three sentence gaps in the new route `title` strings (`api-keys.tsx`, `llm-route-select.tsx`).  They now use U+00A0 plus a space, matching main.
- `src/lib/code-cli.ts`: the inbound body and the broker reply are parsed with Zod instead of `as` assertions.  The request schema is not `.strict()` because callers send sampling fields such as `temperature` (red-team.ts), and the broker payload is still rebuilt from an allowlist.  The two existing rejection messages are kept.
- `src/lib/chat/llm.ts`: `CodeCliChatResponseSchema` is now strict and exact.  It declares `role: "assistant"` and `finish_reason`, which `fetchCodeCli` always emits, so the earlier objection to a strict envelope no longer applies.
- The broker contract doc no longer claims an independent 60-second cap.  The caller deadline is forwarded, and the 150-second bound applies only when no signal is given.
- Still open: a committed `toHaveScreenshot` baseline for the API-key chips (it must come from the CI browser), and the sentinel key, which is only issued to a `codeCliReady` owner.
