# 2026-06-24 — Market-data paid-tier watchdog (lapse/change detection + email + auto-throttle)

## Summary
Raising the Massive client limit to 100/min (paid Starter) introduced a failure mode: if the
subscription lapses back to free (5/min), the app would 429-storm. This adds a nightly watchdog that
detects each market-data key's actual tier and protects + alerts on a lapse or change.

- **`src/lib/provider-tier.ts`** (new):
  - `probeMassiveTier` / `probeFmpTier` — cheap capability probes (~2 calls each; neither provider
    exposes a "what plan am I on" endpoint). Massive: free is capped at 5/min + ~2yr history, so a
    >2yr daily-aggregate query for AAPL returns data on paid and is empty/403 on free (a single-call
    429 also = free). FMP: best-effort — only asserts "free" on an explicit premium/upgrade/limit
    error or 429. Both bias to **"unknown" (no action)** on any ambiguous/transient signal, so a
    working paid key is never wrongly clamped.
  - `runProviderTierCheck` — probes both keys, persists the result (`providerTier:status` internal
    setting + audit), and on a **lapse OR change** (either direction; skips →unknown and the
    first-ever "paid") fires the alert via the in-app feed (`sendNotification`, type
    `provider_degraded`) **and** the multi-channel dispatcher (`notify` → push/webhook/**email**/SMS).
  - `isProviderTierCheckDue` / `runProviderTierCheckIfDue` — cadence-gated (default 24h,
    `PROVIDER_TIER_CHECK_INTERVAL_HOURS`), **anchored to overnight ET** (1–6am) with a 1.5×-interval
    catch-up so it never stalls. Wired into the always-on scheduler tick.
- **Auto-throttle** (`market-signals/massive.ts`): the rate limiter reads the detected tier (cached
  60s) and clamps to the free-safe **5/min** whenever Massive is detected free, then restores 100
  when it sees paid again. Detection can only ever LOWER the cap.
- **Health surface** (`app/api/health/route.ts`): adds `checks.dataProviders` (per-key tier + reason
  + timestamp) and `checks.dataProvidersDegraded` — the integration point for the status/admin/health
  tool. The tool can also import `getProviderTierStatus()` directly. A "free" detection marks the
  section degraded but does NOT fail the liveness probe.
- **Email**: reuses the existing Resend email channel in `notify.ts`. New notification type
  `provider_degraded` (types/defaults/Settings toggle).

## Operator action (to receive the emails)
1. Set `RESEND_API_KEY` + `NOTIFY_EMAIL_FROM` (e.g. `alerts@jays.services`) in `.env.local`.
2. In Settings → Notifications, enable the **Email** channel and set your address (stored in
   `notification_prefs`). Then `pm2 restart trading --update-env`.
(Without these, the watchdog still auto-throttles + records the in-app event; it just can't email.)

## Why
The user upgraded Massive + FMP and asked: are the caps right (yes — FMP 30 = full scan; Massive 100
is a safe guard under "unlimited"), can the key self-report its plan (no endpoint, but detectable via
probe), and can we check nightly and email on a lapse/change. This delivers all of it, defensively.

## Files
- new `src/lib/provider-tier.ts`; `src/lib/market-signals/massive.ts` (tier-clamp); `src/lib/scheduler.ts`
  (nightly hook); `app/api/health/route.ts` (dataProviders); `src/lib/types.ts` + `src/lib/defaults.ts`
  (`provider_degraded` type/default); `app/dashboard-client.tsx` (Settings toggle); `.env.example`
  (watchdog cadence + Resend/notify channels); `test/provider-tier.test.ts`.

## Verification
- `npx tsc --noEmit` clean · `npx vitest run` 1146 passed (+17) · `npm run build` green.
Built in isolated worktree off `origin/main`; landing via PR.

## Follow-ups
- The status/admin/health tool (separate session) should render `checks.dataProviders` /
  `getProviderTierStatus()` — data is ready for it now.
- FMP detection is best-effort (notify-only, no auto-clamp) since free↔Starter isn't cleanly probeable;
  revisit if FMP exposes a clearer signal. Could also extend the watchdog to other keyed providers.
