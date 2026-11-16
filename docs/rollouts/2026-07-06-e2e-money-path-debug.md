# 2026-07-06: E2E Money-Path Test Debugging

## Summary
Added `test/e2e-money-path.test.ts`, an end-to-end integration test that drives the
full autonomous money path — market scan -> Bull/Bear/Red-Team LLM calls (all mocked
via a stubbed `fetch`) -> risk/decision -> broker order placement through the
`TestBrokerGateway` — and asserts the AAPL order reaches the terminal `placed`
status. (2026-07-08: hardened per Copilot review — see below.)

## Why
Reaching the money-path execution branch under Vitest requires several conditions that
the test now sets up explicitly:
- **Trading-day determinism:** `runStrategyOnce(..., { manual: false })` skips execution
  when `isTradingDay()` is false, so the test sets the VITEST-only seam
  `AGENTIC_TEST_FORCE_TRADING_DAY=1` (`src/lib/market-calendar.ts`) to stay off the
  calendar — otherwise it would flake red on weekends/market holidays.
- **Autonomy:** the run uses `manual: false` with `strategyAuthority: "decide"` so the
  autonomous authority check permits placement rather than routing to human approval.
- **Live-capital pre-flight:** `setupBrokerLiveAutonomous` connects a `broker: "alpaca" /
  environment: "live"` account and sets `ALLOW_LIVE_TRADING=true` (via `vi.stubEnv`, so
  `vi.unstubAllEnvs()` restores it and it can't leak into other test files), clearing the
  `preflight-live-guard` check.

## Files Touched
- `test/e2e-money-path.test.ts` (new)
- `docs/rollouts/2026-07-06-e2e-money-path-debug.md` (this note)

(No `STATUS.md` / `docs/EFFORT-LOG.md` change is bundled in this PR; the earlier PR
description that mentioned them has been corrected to match the actual diff.)

## Copilot review hardening (2026-07-08)
- Force `AGENTIC_TEST_FORCE_TRADING_DAY=1` so the run never skips on non-trading days.
- Set `ALLOW_LIVE_TRADING` via `vi.stubEnv` instead of a raw `process.env` assignment
  (auto-restored by `vi.unstubAllEnvs()`; no cross-test leak).
- Use an in-vocabulary `tradeThesisTag: "Momentum-Breakout"` (a real `THESIS_PLAYBOOK`
  tag from `src/lib/strategy-prompts.ts`) instead of the out-of-schema `"Momentum"`.
- Tighten the terminal assertion to `expect(status).toBe("placed")` — the broker/live
  decide path only ever surfaces `"placed"` in `result.proposals` (the `"placing"` /
  `"filled"` states are DB-only and never pushed there), so the loose set assertion
  masked non-placement outcomes.
- Drop the debug `console.dir(auditLogs)` / `console.log(status)` noise.

## Verification
```bash
npm run lint
npx tsc --noEmit
npm test test/e2e-money-path.test.ts
npm run build
```
The 2026-07-06 authoring pass ran the trio locally (test reaches `placed`). The
2026-07-08 review-hardening pass + the `origin/main` merge-forward are verified by the
required `verify` CI job on the PR (this fix-forward lane has no local `node_modules`).

## Follow-ups
Wire `congress-score-eval` go/no-go into the scan/scoring.
