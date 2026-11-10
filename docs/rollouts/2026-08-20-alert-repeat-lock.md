# Alert repeat lock — same alert once per minute

## Context & Objective

Jay (2026-08-19 ~7:05pm CT): do not send the same alert multiple times in a single minute, and troubleshoot the other alert paths even when they are not filing more than once.  Cluster `alert-repeat-lock`.  #2865 (`6a6b447d`) made price alerts evaluate again via user-scoped `fetchFreshQuotesCascade`; the scheduler still ticks every 60s (`TICK_MS`) and calls `checkAllUserPriceAlerts` every tick.

## Changes Made

- Reused the existing `notification_events` sent-row machinery (`repeatNotificationFingerprint` + `recentRepeatNotificationSent`).  No second store.
- `price_alert`, `provider_degraded`, `budget_alert`, and `kill_switch` now share a 60s same-fingerprint lock (`DEFAULT_ALERT_REPEAT_LOCK_MS`).  Honor `NOTIFICATION_REPEAT_DEDUP_MS` when set.  Only `status='sent'` suppresses.
- `price_alert` fingerprints by alert id, not symbol.
- `block` / `pending_approval` keep the existing 6h situation window.
- Stopped same-channel double-send: health `additionalDelivery` and usage-limit operator fallback no longer re-send Pushover (or email) when that channel is already in the user's prefs.
- Usage-limit 6h cooldown now writes only after a successful user `sent` or a successful operator fallback.  A skipped/failed first attempt no longer latches silence.
- `sendDirectNotification` de-duplicates `prefs.channels` in one dispatch.

**Files touched:**
- `src/lib/notifications.ts`
- `src/lib/usage-limit-alerts.ts`
- `src/lib/db-health.ts`
- `test/notification-repeat-dedup.test.ts`
- `test/usage-limit-alerts.test.ts`
- `test/connection-health-routing.test.ts`
- `docs/phase-6-customization-risk-notifications.md`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-alert-repeat-lock.md`

## Decisions & Trade-offs

- Did not revert #2865 evaluation.  Did not take `alert-push-delivery` (iOS deep-link / badge / mark-after-success).
- Concurrent scheduler ticks are already gated by atomic `markPriceAlertTriggered` (`UPDATE ... AND status='armed'`).  The 60s lock covers the remaining cases: missing lock type, same-channel fallback, overlapping processes, and still-true non-price conditions.
- Health connection-failure still uses its 6h `healthAlertSent` cooldown (and Alpha Vantage `cooldownUntil`) so Sentry/audit stay quiet on a persistent outage.  That cooldown still writes before send; a failed first health page can stay silent for 6h.  Follow-up, not this PR — changing it would reopen the noise-gate.
- Option alerts stay on the existing once-ever `reserveOptionAlert` (sent-only).  Signal-health is once per UTC day.  Pinecone / RAG connection alerts keep their 1h KV cooldown and now also hit the 60s `provider_degraded` lock.
- `notifyBudgetSkip` (`budget_alert` + `runId`) fingerprints by normalized reason so the same over-budget skip cannot page every run inside 60s.

## Verification State

```bash
# Focused (this PR) — 6 files, 75/75 passed (2026-08-20 00:38Z)
PUSHOVER_APP_TOKEN= PUSHOVER_USER_KEY= npm test -- \
  test/notification-repeat-dedup.test.ts \
  test/usage-limit-alerts.test.ts \
  test/connection-health-routing.test.ts \
  test/health-alert-noise-gate.test.ts \
  test/price-alerts-evaluation.test.ts \
  test/notification-status-truth.test.ts

npm run lint          # exit 0
npx tsc --noEmit      # clean
npm run build         # succeeded
```

Cloud VM has live `PUSHOVER_*` secrets.  Email-fallback cases must stub those env vars empty (commit `c72eb852`); `vi.unstubAllEnvs()` restores the host tokens.

Full `npm test` on this VM is not the gate for this PR: it hits unrelated network/timeout flakes (TwelveData quota, strategy 30s timeouts, Alpaca/Finnhub 404s).  A broader notify-adjacent set was 139 passed / 1 unrelated timeout (`persistence-notification` pre-run portfolio snapshot).  CI `verify` on #2877 is the full-suite source of truth.

Rebased onto `origin/main` `0382e83f` (2026-08-20).  Replay was clean; no code conflicts.  Docs-only overlap on `PLAN.md` / `STATUS.md` / `docs/EFFORT-LOG.md` kept both sides.

## Next Steps & Blockers

- Merge; auto-deploy on `main`.  No Coolify / TestFlight / spend-cap action.
- Follow-up: health `healthAlertSent` latch-before-send (failed first page stays quiet 6h).
- Follow-up: `alert-push-delivery` (delivery-only-after-success vs the one-shot mark).
- Follow-up: duplicate `price_alerts` rows for the same user+symbol+op+price (two ids both fire; lock is per id by design).

## Other alert types (fixed vs already-gated vs follow-up)

| Type | Finding | This PR |
| --- | --- | --- |
| `price_alert` | Missing from repeat-dedup; one-shot mark is atomic but fan-out / races still looked like repeats | 60s lock by alert id |
| `provider_degraded` (health) | 6h cooldown already-gated; same-channel Pushover fallback double-sent | Skip fallback when channel already enabled; 60s lock |
| `budget_alert` (usage-limit) | 6h KV latched *before* send (failed/skipped silenced the next try); Pushover fallback could double-send | Latch after success; skip duplicate channel; 60s lock |
| `budget_alert` (run skip) | Re-emits every skipped run | 60s lock by normalized reason |
| `kill_switch` | Can re-emit every strategy run while halted | 60s lock by reason/summary |
| `option_alert` | Once-ever reservation; only `sent` latches | Already-gated |
| `signal_health` | Once per UTC day | Already-gated |
| Pinecone WU / RAG connection | 1h KV + usage-limit 6h | Already-gated; now also 60s `provider_degraded` / `budget_alert` lock |
| Health Sentry noise | Streak + 6h + retired-vendor gate (`health-alert-noise-gate`) | Already-gated; left latch-before-send as follow-up |

## Zero-Code Findings

`markPriceAlertTriggered` was already `UPDATE ... WHERE status='armed'`, so two overlapping ticks cannot both mark the same row.  Jay's repeats are explained by (1) `price_alert` not in the dedup set, (2) multi-channel + same-channel fallback looking like N copies in one minute, and (3) other types that re-emit while the condition stays true.
