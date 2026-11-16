# 2026-08-31 — Grok top-to-bottom full-stack audit

## Context & Objective

Owner asked for a team audit of every web size, native iOS, and backend.  Goal is a ranked catalog of still-open errors and improvements against current `origin/main`, not a code sweep.

## Changes Made

- Report-only.  No product code.
- New review: `docs/reviews/2026-08-31-grok-full-stack-audit.md`
- Claimed board `52592a4d` (P1 ST full-stack audit)
- Lane: `~/apps/trading-grok-full-audit` @ `grok/full-stack-audit` from `origin/main` `ff7a562d9`
- Effort row on live board + this mirror

Touched files:

- `docs/reviews/2026-08-31-grok-full-stack-audit.md`
- `docs/rollouts/2026-08-31-grok-full-stack-audit.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

- Did not re-file the Cursor 2026-08-23 P0/P1 rows.  Re-verified them in this tree and pointed at the existing board ids.
- Guardrails Discard and `/mobile` redirect are treated as fixed; the 2026-08-23 money-path P0s are not.
- Did not implement fixes.  Claude owns gather-budget `06df80cf`.  Hung scheduler-tick watchdog is a separate Grok lane.
- Did not run `xcodebuild` or mutate Coolify.

## Verification State

```
git -C ~/apps/trading-grok-full-audit log -1 --oneline
# ff7a562d9 docs: flip #3135 effort row to Completed...

# file:line reads on alpaca.ts callMcp, stop_market write, dashboard fills,
# order-provenance, MobileStore uniqueKeys, fetchDashboard 401, ticker-logo SSR,
# guardrails discardAllDrafts, SocraticTradeApp preferredColorScheme
```

Local tsc/test/build not run (docs-only).  `scripts/land.sh` still runs the gate.

## Next Steps & Blockers

- Land this docs PR.
- Implementation lanes should claim the existing P0 board rows (`d4cb5e75`, `ef0dccb3`, `d36c2233`) rather than opening duplicates.
- Do not HOTFIX during weekday RTH.

## Zero-Code Findings

See `docs/reviews/2026-08-31-grok-full-stack-audit.md`.  Headline: Alpaca `stop_market` write, MCP place timeout double-submit, and any-`client_order_id` provenance are still in `main`.
