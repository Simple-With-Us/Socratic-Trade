# 2026-07-09 — Alert triage (all ~75 Attention alerts) + AV key pool + alert lifecycle (MONET)

Owner asked: "review the 75+ alerts the app has now and address all of them; change
the Infisical setting for voyage; can we use 2-4 keys for alpha vantage?" A 9-agent
triage workflow (per alert family + 2 design scouts, adversarial verification on the
load-bearing lanes) root-caused every alert in production, then a 6-lane fix fleet +
2-lens adversarial review + 3-agent fix round implemented the remedies.
Branch: `monet/alert-triage-av-multikey`.

## What the "75+" actually was

The Alert Center Attention pill counts run_failed/provider_degraded/kill_switch/
budget_alert + failed rows over the latest 100 notification_events (was unscoped);
it sat at 54–76 all day. Root causes, verified against the prod DB (snapshot
2026-07-09T01:03Z) and the deploy timeline:

1. **76× run_failed = ONE bug**: gemini-3.5-flash rejects the Bull proposal schema
   (HTTP 400 INVALID_ARGUMENT) because it can't accept `type:["number","null"]`
   unions + `anyOf`-with-null (`autonomyOverride`). Bear's simple schema succeeds
   46/46 on the same model/account — proof it's the request shape. DeepSeek had a
   carve-out in `openAiChatResponseFormat()`; Gemini had none. Roth IRA (the only
   isActive live account) produced ZERO proposals all day.
2. **11× run_failed**: Robinhood "Agentic" (~$4–5 NAV) retried a ~$0.22 AAPL
   concentration trim hourly; Robinhood's $1 minimum rejects it every time, and
   `reviewEquityOrder()` never read the `order_checks.alertType` field where
   Robinhood pre-announces exactly this.
3. **provider_degraded (73)**: the 07-08 21:10Z rate limiter verifiably fixed
   finnhub (500/500 ok after) and yahoo; twelvedata was never wrapped (100% 429);
   tiingo fails with **403 (auth/entitlement — owner action, not pacing)**;
   alpha-vantage = daily cap (multi-key below); congress SSE fixed live by the
   sibling session (subscription provisioned + restart).
4. **limit_order_stale (40 alerts = 36 distinct orders)**: mostly informational
   churn — BUT it exposed an ACTIVE money-path bug (below).
5. **MU: definitively closed at $938.29** at the 07-08 open. Synthetic-stops
   hardening verified live (fire_generation present, no stuck stops, no 422s).

## ACTIVE money-path bug found & fixed (naked-short remediation)

`autoRemediateStaleExitOrders` (PR #1036, live since the migration deploy) treated
the broker-HELD protective-exit leg of a NOT-YET-FILLED bracket entry as a stranded
stale exit → cancel + market-sell of shares that don't exist. Production damage
(Alpaca paper): short 12 PG opened at the 07-08 open (~-$1,780); order `d642d572`
(93-share T market sell, NO position) resting for the 07-09 open; `d5e28482` set to
sell the real 2-share UNH position. Owner push-notified to cancel before the open.
Fix (src/lib/order-replacement.ts, adversarially reviewed twice):
- held-state legs are excluded in BOTH the auto loop and the shared
  `replaceStaleLimitOrderWithMarket` (manual route) — 409 + audit receipt;
- position-backed guard: no market replacement without a directional position
  covering the remaining qty (`stale_exit_remediation_skipped_no_position`);
- post-cancel re-verify (TOCTOU) — aborts placement with
  `stale_exit_replacement_aborted_post_cancel` if backing shrank after cancel;
- one in-flight lock spans auto + manual paths (no double-processing).

## Everything else fixed in this batch

- **Gemini schema shaping** (`src/lib/llm-call.ts`): recursive transform of
  nullable-union/`anyOf`-null constructs into Gemini's `nullable:true` dialect;
  OpenAI/xAI/Anthropic byte-identical; DeepSeek downgrade preserved.
- **Robinhood minimums**: `order_checks` parsed → `ReviewedOrder.preflightBlock`;
  known-impossible sub-minimum trims are skipped with ONE cooldown-gated alert
  (24h) instead of hourly failures; whole-position dust exits exempt (Robinhood
  allows selling an entire fractional position); wired at both strategy call
  sites with `positionQuantity`.
- **Alpha Vantage key pool** (`src/lib/alpha-vantage-key-pool.ts`):
  `ALPHAVANTAGE_API_KEYS` (comma-separated; falls back to `ALPHAVANTAGE_API_KEY`);
  sticky-until-daily-cap rotation (discriminator: the "detected your API key"
  message shape — burst warnings do NOT rotate); per-key exhausted-until-reset
  memory persisted via internal settings (sha256 fingerprints, never raw keys);
  midnight-ET reset assumption env-tunable; pacing stays GLOBAL serial ≥1.1s
  (keys multiply the DAILY budget, not the rate); all-exhausted fast-fail (no
  more N×1.1s guaranteed-fail scans); scrubbing covers every pool key; per-key-set
  pool registry (no cross-context singleton corruption). ToS note: aggregating
  free keys is the owner's call.
- **Alert lifecycle**: `acknowledged_at` migration; per-row + bulk acknowledge
  (account-scoped, user-scoped API); lazy auto-ack sweep (orphaned
  pending_approval — 137 in prod — and run_failed whose account has a LATER
  successful run, EXCLUDING broker-verification alerts which demand a human);
  run_failed repeat-dedup (6h, symbol-aware signature) so one broken model shows
  as ONE Attention item, not 76.
- **Hygiene**: twelvedata limiter (8 credits/min free tier → 10s serial spacing,
  abort timer armed inside the pacer); bearUnavailable 6h alert cooldown;
  Pinecone/Voyage double-alert consolidated; push channel no longer drops
  messages with em-dashes (ByteString char-8212 crash — transliterate to
  Latin-1); stale-run sweep threshold raised (11min falsely "crashed" a live run
  that completed 5s later and placed 4 trades).

## Owner-side / config actions

- DONE by MONET: `VECTOR_EMBED_BATCH_DELAY_MS=2000` created in Infisical prod (was
  absent = free-tier throttle); live since the congress-SSE restart re-fetched
  Infisical the same night. 2000 vs the 5000 threshold: 5000 is the tier boundary,
  2000 also speeds actual batch pacing 2.5× for the 515-symbol backfill.
- DONE by sibling session: congress SSE subscription (ok:true verified).
- Owner: cancel `d642d572` (+ decide PG short / UNH sell) before the 07-09 open —
  push-notified; add AV keys #2–4 to `ALPHAVANTAGE_API_KEYS` when ready; check
  tiingo key/plan (403s are entitlement, not rate).

## Verification

Full gate on the assembled branch (exact commands, real exit codes):
`npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build` — results
recorded in the PR. Per-lane: order-replacement 19/19; notification-lifecycle
18/18; AV pool + minimum guard 51/51; full suite 3077/3077 at the last lane
snapshot. Two adversarial review rounds (Fable money-path + Sonnet regressions)
caught and fixed: held-leg manual-path bypass (HIGH), auto-ack swallowing
broker-verification alerts (HIGH), TOCTOU on the position guard, AV pool
singleton cross-contamination, cross-symbol dedup collapse, ack-all account
scoping, sub-$1 whole-position exemption, mid-chunk exhaustion, build-breaking
duplicate import.

## Files

See PR diff. Core: src/lib/order-replacement.ts, llm-call.ts, robinhood.ts,
broker-minimum-guard.ts (new), alpha-vantage-key-pool.ts (new), db-notifications.ts,
db.ts (migrations), provider-rate-limit.ts, data-providers.ts, strategy.ts,
notifications.ts, notify.ts, db-execution.ts, types.ts,
app/api/notifications/ack/route.ts (new), app/console/components/alert-center.tsx,
app/console/lib/api.ts, + 8 test files.

## Follow-ups

- Threading connected_account_id through llm_step/llm_call_latency audit rows
  (attribution parity with llm_usage).
- Stale-run sweep: consider a heartbeat signal instead of a pure threshold.
- Tiingo 403 (owner: key/plan) and AV paid-tier decision remain open.
- Watch first market-hours session post-deploy for synthetic-stops + remediation
  regressions (none expected; guards fail toward inaction + receipts).

## 2026-07-11 correction — canonical admin health lane

The provider and persisted health rows use `alpha-vantage`, but the admin connections-health
expected-lane inventory retained the API-key slug `alphavantage`. That did not affect provider calls,
key selection, pacing, or daily-cap detection; it only injected an empty `alphavantage:env` card next
to the real `alpha-vantage:env` lane. Branch `codex/alpha-health-lane-fix` corrects the inventory to
the canonical provider service name and adds authenticated route coverage proving the canonical lane
is deduplicated and the legacy spelling is absent. This supersedes any implication in this rollout
that `alphavantage` is a valid health-service identifier; it remains only the API-key storage slug.

Separately, PR #1392 (`32783b12`) superseded this rollout's multi-key production design after live
evidence showed Alpha Vantage's free daily cap is enforced per source IP. Current code resolves one
singular key, or only the first entry of the legacy plural env value for compatibility; it does not
rotate six keys. The health-lane spelling fix does not reintroduce multi-key behavior.
