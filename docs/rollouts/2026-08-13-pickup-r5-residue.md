# 2026-08-13 — Pickup r5 residue (advisory-tail + parked owner decisions)

## 1. Context & Objective

Monet's "Backend updates" chat (session af6c928f) hit the session limit after asking to
complete remaining work.  Claude's r4 toggles slice was yielded to Monet #2682 (merged).
Claude named the salvage leftover: **advisory-tail reword** + **settings-surface sweep**.
The sibling lane `grok/claude-r4-pickup` is landing the five unpushed r4 commits
(benchmarks / pullback / opspanel / dataage).  This lane implements only residue that is
well-specified **and** does not touch those files.

## 2. Changes Made

- Reworded the shared `risk_advisory` notification tail from "no state change; the agent
  is still in control" to "nothing was blocked or changed."  The old wording is only true
  for agent-originated advisories; `risk_advisory` also fires for owner-initiated actions
  (cancel-dust on `app/api/orders/cancel`).  Same honesty on the Discord fallback.
- Added body + Discord tests and a source-grep merge-gate against the force-include
  pattern coming back (adapted to #2682 names: `FORCE_INCLUDE_BACKFILL_EVENT_TYPES` +
  `notification_enabled_events_backfill`).
- Wrote honesty copy for `VECTOR_ASOF_STRICT` in `docs/FEATURE-ENABLEMENT-BACKLOG.md` and
  `.env.example`.  Did **not** flip the flag.
- Documented Claude's settings-surface sweep (zero-code: found no other lying toggles).

Touched files:

- `src/lib/notifications.ts`
- `test/notification-body-fixes.test.ts`
- `test/notification-toggle-merge-gate.test.ts` (new)
- `docs/FEATURE-ENABLEMENT-BACKLOG.md`
- `.env.example`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-13-pickup-r5-residue.md` (this file)

Not touched (sibling r4 pickup owns them): `src/lib/outcome-engine.ts`,
`src/lib/outcome-horizons.ts`, `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`,
`src/lib/server-knobs.ts`, `src/lib/types.ts`, `app/console/settings/page.tsx`,
`app/admin/operations/**`, `src/lib/dormant-features.ts`,
`src/lib/source-settings-catalog.ts`.

## 3. Decisions & Trade-offs

- Settings-surface sweep is already done in Claude's salvage commit message: no other
  overridden/lying controls.  FMP catalog toggles are an honest "intent only until
  unblock" caveat, not a silent override.  Autopilot/manual-run glossary is accurate
  scope documentation.  Left both as-is.
- Did not edit `app/console/settings/page.tsx` (`risk_advisory` helper still says
  "the agent is still in control") or the `types.ts` comment — those files are in the
  in-flight r4 pickup.  Follow-up after that PR merges.
- Did not invent Reddit/X wiring or flip `VECTOR_ASOF_STRICT`.

## 4. Verification State

```
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npx tsc --noEmit
npx vitest run test/notification-body-fixes.test.ts test/notification-toggle-merge-gate.test.ts
npx eslint src/lib/notifications.ts test/notification-body-fixes.test.ts test/notification-toggle-merge-gate.test.ts
# then scripts/land.sh (lint / tsc / test / build)
```

## 5. Next Steps & Blockers

### Owner decisions (do not invent product policy)

1. **Reddit / X social sentiment** — DSA lesson `social-sentiment-context`.  Polymarket
   context already shipped in r3 (#2666).  Reddit/X stay blocked until the owner supplies
   a real API key in `/Users/jay/.secrets/` (fleet rule: never create provider keys).
   Quiver is banned as a vendor.  No agent will provision a key.
2. **`VECTOR_ASOF_STRICT` behavior** — keep **off** (current) unless the owner wants
   fail-closed dated retrieval.  Flipping it does **not** change the live desk (chat /
   strategy omit `asOf`).  It only drops undated/un-epoch'd chunks on dated paths
   (backtest, lookahead audit, replay).  2026-07-07 backfill reported 0 undated then;
   that is not a standing proof.  Flip only after a fresh coverage receipt
   (`GET /api/admin/rag-coverage` / drop-count audit).
3. **Settings `risk_advisory` helper string** — after `grok/claude-r4-pickup` merges,
   change `app/console/settings/page.tsx` and the `types.ts` comment to match the new
   tail.  Not done here to avoid colliding with the r4 opspanel hunk.
4. **Round 5 design slices** (well-sketched, not small): strategy-overlay library,
   Bayesian trust-calibration primitive, analysis-stream budget contract, `performance.ts`
   scorecard alpha stretch from r2.  Start only after r4 lands and the owner picks one.

### Planned board row (enablement, not this PR)

- Enable `VECTOR_ASOF_STRICT` in production after a fresh as_of_epoch_ms coverage proof
  (owner flip).  Checklist: `docs/FEATURE-ENABLEMENT-BACKLOG.md`.

## 6. Zero-Code Findings

Already shipped (do not redo):

| Item | Where |
|---|---|
| r3 scorecard / lookahead / PIT / Polymarket | #2666 |
| real-toggles force-include removal | #2682 |
| APNs | #2681 |
| honest server stats | #2684 |
| FTS-mirror adaptive yield | #2680 |
| watchlist digest + `outcomeGradingMode=alpha` + signal-health auto-throttle | activated in prod (Monet chat) |
| r4 benchmarks / ATR pullback / ops panel / data-age | sibling `grok/claude-r4-pickup` (5 local commits on `agent/claude`, cherry-picked) |

Settings-surface sweep (Claude, salvage `edfb5fc1`): no remaining silent override.  The
only leftover copy lie was this advisory tail (notification body + Discord fallback).
