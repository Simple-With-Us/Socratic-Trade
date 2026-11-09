# 2026-07-07 — Strategy execution / stops / LLM-timeout fixes (MONET)

Owner-directed after production forensics on Alpaca-paper `PA33IDTHMFK9`. Four
money-path fixes, all owner-approved ("do all") with per-area refinements.

Branch `monet/strategy-exec-stops-llm-fixes` off `origin/main` @956c717f.

## Summary

Production diagnosis (from the live DB + audit trail) found four real defects:

1. **DeepSeek Green/Bear time out** — the inline Green (`strategy.ts`) and Bear
   calls used `llmFetch` with no `signal`, inheriting a hard **60s**
   `LLM_TIMEOUT_MS`, while the app silently upgraded DeepSeek to
   `reasoning_effort:"high"` (9500-tok budget, no streaming). A fast model was
   being made slow, then aborted at 60s ("Green Team proposal timed out after
   60s using DeepSeek deepseek-v4-pro").
2. **MU exit deadlock** — an LLM Risk-Exit went out as a GFD **limit** @ $991
   that never filled as MU fell to -8%; the stale unfilled order then held all
   shares (`availableQuantity:0`) so `proposal_blocked_broker_held_exit` blocked
   every re-exit for ~a day until the broker expired it. `limit_order_stale`
   fired 38× fleet-wide — same class of bug.
3. **One-size-fits-all stops** — every position got the flat
   `trailingStopPct`/`stopLossPct`; the ATR-stop, beta-scaling, and
   LLM-proposed-stop machinery all existed but were OFF/unwired (the Bull/Bear
   schemas didn't even expose a per-trade stop field).
4. **Historic `ALLOW_LIVE_TRADING` gate + broken notifications** — every live
   order was blocked by an opt-in env gate (contradicts "account boundary is the
   only hard rule"); and `notify.error` fired 45× ("fetch failed" email/push,
   "Webhook Not Configured") with no retry, so block/timeout alerts were
   silently dropped and the owner never saw any of the above.

## Changes

### §1 DeepSeek/LLM (`llm-request.ts`, `strategy.ts`)
- `normalizeReasoningEffortForModel` DeepSeek branch: a sub-high request
  (none/minimal/low/medium — incl. the "medium" default) now resolves to the
  FAST `none` tier instead of a silent upgrade to `high`. High-effort DeepSeek
  thinking is opt-IN (high/xhigh/max). The settings UI resolves the displayed
  effort through the **same** function, so the effort shown always equals the
  effort sent (owner refinement: no un-honored value selectable).
- New `strategyLlmTimeoutMs(model, effort)` — reasoning-class-aware, env-tunable
  (`STRATEGY_LLM_TIMEOUT_MS`, `STRATEGY_LLM_REASONING_TIMEOUT_MS`, default 150s
  when thinking is on). Threaded via an explicit `signal` into the Green
  (`strategy.ts:4188`) and Bear (`strategy.ts:4548`) calls, and into the two
  humanize error-message sites. No separate fallback model added (owner
  refinement).

### §2 Exit correctness (`strategy.ts`, `order-replacement.ts`, `scheduler.ts`, `types.ts`, `defaults.ts`)
- **Fix 2a:** `coerceProtectiveExitToMarket` — a Risk-Exit sell/cover limit /
  stop_limit is routed as a **market** order (chained in `sanitizeProposals`).
  A protective exit can no longer rest unfilled.
- **Fix 2c:** `autoRemediateStaleExitOrders` (in `order-replacement.ts`, wired
  into the scheduler stale-order tick) cancel-replaces a stale **exit** limit
  with a market order. Scoped to exits only (entries are never forced to
  market); defers to human typed-confirmation on a live account with
  `requireTypedConfirmation` on; opt-out via `policy.autoRemediateStaleExits`
  (default true).
- **Fix 2b (guard cancel-replace):** intentionally NOT implemented — with 2a
  (exits never rest as limits) and 2c (stale exits auto-remediated at 15m), a
  *stale* held order no longer blocks re-exit, and blocking on a *live* held
  exit is correct double-sell protection. Documented rather than added, to avoid
  extra complexity in the execution loop.

### §3 Per-trade intelligent stops (`defaults.ts`, `types.ts`, `strategy.ts`, `strategy-prompts.ts`)
- `atrStops` and `betaScaledStops` now default **ON** — proactive risk exits and
  the position-heat budget become per-symbol immediately.
- Bull/Bear output schemas now expose `bracketStopLoss` / `bracketTakeProfit`
  (they were stripped by strict `additionalProperties:false`); the Bull prompt
  instructs the model to set a per-trade stop from the setup's structure
  (support/ATR/thesis-invalidation), not a fixed percent. `enrichOpeningProposal`
  already honored a pre-set bracket via its `== null` guards; it now also
  **validates** an LLM stop (must sit on the correct side of entry) and makes the
  fallback **per-symbol** (ATR from the threaded map, else beta-scaled via the
  scan's beta, else flat) — matching `generateProactiveRiskProposals` precedence
  (ATR > beta > flat) so a name gets the same intelligent stop on its opening
  bracket as on its proactive exit. `sanitizeProposals` carries/validates the
  new fields.
- **Follow-up:** the synthetic *trailing* stop still uses the flat
  `trailingStopPct` — making it per-symbol needs beta/ATR plumbed into the
  scheduler-tick monitor (`runSyntheticStopMonitor`), which has no market-data
  access today. Deferred to avoid adding network fetches to that tick.

### §4a Remove the ALLOW_LIVE_TRADING gate (`preflight-live-guard.ts`)
- Flipped `ALLOW_LIVE_TRADING` from opt-IN to opt-OUT: `liveTradingEnabledByEnv`
  returns true unless the env is exactly `"false"`. Live accounts now trade on
  their environment alone (account boundary stays the only hard rule); the env
  flag survives as a documented escape hatch. **CONSEQUENCE:** once deployed, a
  connected live account (the Robinhood live acct) will place real orders without
  the flag — surfaced to the owner explicitly.

### §1b LLM latency capture — soft timeout, never sever a paid reply (`llm-request.ts`, `strategy.ts`)
Owner follow-up: "if the app is making the llm call and paying for it anyway then we should get the
reply even if way later ... the response and the time it came in and/or how long it took." The old
behavior `AbortSignal.timeout`-severed the connection at the wall, discarding both the reply and the
evidence of how long the model actually needed (we could not answer "would 75s have finished it?").
- New `llmFetchCapturing(url, init, {softTimeoutMs, hardCapMs, onOutcome})`: resolves normally within
  the soft timeout; past it, REJECTS with TimeoutError (the tick's existing timeout/fallback path runs
  unchanged) but the request KEEPS RUNNING (hard-cap leak backstop max(2×soft, 300s)) and the eventual
  outcome — duration, status, and the late Response — is reported via `onOutcome`.
- `recordLlmOutcome` in strategy.ts audits **every** Green/Bear call as `llm_call_latency`
  (durationMs, softTimeoutMs, late, ok, status) — builds the real latency distribution so the timeout
  can be tuned from data. On the LATE path only, it also drains the reply we paid for into an
  `llm_late_response` audit (4000-char text snippet + token usage + duration). Fast responses are
  never body-read by the recorder (the normal flow owns the body — reading twice was a review-caught
  race that broke the 429-failover test).
- Late replies are capture-for-debug ONLY — a stale proposal from a prior tick is never traded on
  (confirmed default; owner can revisit).

### §2-review Double-sell guard (adversarial-review Finding 1, HIGH)
The stale-exit auto-remediation pass was fire-and-forget: a slow broker cancel (>60s tick) could let
the next tick re-remediate the SAME order → a second market sell / accidental short. Two defenses:
a per-account in-flight guard in the scheduler (`staleExitInFlight`, mirroring `stopMonitorInFlight`)
+ a per-order 5-min cooldown in `autoRemediateStaleExitOrders` (`recentlyRemediatedExits`, marked
BEFORE the attempt). Test: a second pass on the same still-working order places NO second market sell.
(Review Finding 2 — timeout derived from raw vs interactive-clamped effort — was a false positive:
`strategyLlmTimeoutMs` is binary thinking-on/off and both efforts resolve to the same bucket.)

### §4b Notification delivery (`notify.ts`)
- Per-channel **retry with backoff** on transient delivery failures (the ~7%
  "fetch failed"/timeout/5xx/429 seen in prod); permanent 4xx fail fast. Env
  `NOTIFY_RETRY_ATTEMPTS` (3), `NOTIFY_RETRY_DELAY_MS` (400). A single blip no
  longer drops a critical "Sell blocked" / "LLM timed out" alert.

## Files
- `src/lib/llm-request.ts`, `src/lib/strategy.ts`, `src/lib/strategy-prompts.ts`,
  `src/lib/defaults.ts`, `src/lib/types.ts`, `src/lib/order-replacement.ts`,
  `src/lib/scheduler.ts`, `src/lib/preflight-live-guard.ts`, `src/lib/notify.ts`.
- Tests: `test/llm-request.test.ts`, `test/preflight-live-guard.test.ts`,
  `test/run-budget-and-live-guard.test.ts`, `test/notify.test.ts`,
  `test/order-replacement.test.ts`, `test/protective-exit-coercion.test.ts` (new),
  `test/persistence-notification.test.ts`, `test/strategy-hardening.test.ts`.

## Verification
- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — 0 errors (grandfathered warnings only).
- `npx vitest run` — **2888 passed** (284 files), 0 failures (final run incl. the double-sell-guard,
  cooldown, and llmFetchCapturing fast/late tests).
- `npm run build` — succeeds.
- Adversarial review (independent agent over `git diff origin/main...HEAD`): 1 HIGH finding
  (cross-tick double-sell) — fixed + tested; 1 LOW finding — analyzed as a false positive (see §2-review).

## Follow-ups / risks
- Per-symbol synthetic **trailing** stop (needs beta/ATR in the monitor tick).
- §4a live-trading now default-on: owner should confirm the Robinhood live
  account should indeed start trading on deploy (or set `ALLOW_LIVE_TRADING=false`
  to keep it gated).
- DeepSeek default is now thinking-off (fast); pick High/Max explicitly for deep
  analysis (now with real 150s headroom).
