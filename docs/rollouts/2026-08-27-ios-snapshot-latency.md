# 2026-08-27 — iOS "Couldn't load your workspace": snapshot latency + first-load retry

## Context & Objective

After a successful native Apple sign-in, the iOS app could land on the full-screen
"Couldn't load your workspace" state while the mobile website worked.  Root cause
(high confidence, from code trace + Sentry spans + prior in-repo documentation): a
**timeout/retry asymmetry**.  iOS makes exactly one `/api/mobile/snapshot` attempt
with a flat 30s timeout and no retry, and a fresh sign-in has no cached snapshot to
soften a miss.  Server-side, `getDashboardSnapshot` chained three sequential broker
deadlines — portfolio bundle (16s + 8s retry), then option positions (16s), then
equity quotes (16s) — a worst case far past 30s, and Sentry showed real 13-20s loads
during the current degraded-liveness window (P0 06df80cf).  The web console was
hardened for exactly this on 2026-08-12 (35s per-attempt + retry, slow-notice instead
of failure card — `docs/rollouts/2026-08-12-load-screens-and-lato.md`), and that
note's "parallelise the broker chain" follow-up was never landed; iOS never got the
equivalent tolerance.

## Changes Made

- **`src/lib/dashboard.ts`** — option positions now fetch concurrently with the
  portfolio bundle (they only need the account number), instead of chaining a second
  16s deadline after the bundle's 24s worst case.  Equity quotes still follow the
  bundle (they need the position symbols).  Worst case drops from 56s toward 40s, and
  the common degraded case lands well under the app's timeout.  This half helps
  already-installed builds as soon as it deploys.
- **`ios/SocraticTrade/MobileStore.swift`** — `load()` gives the **no-snapshot-yet**
  case one retry: on a network-class failure with nothing cached, wait 1.5s and try
  once more with a 45s window before surfacing the failure screen.  Refreshes with
  data present keep failing soft (stale banner) exactly as before.

## Decisions & Trade-offs

- Deliberately did not retry on 5xx (avoid doubling load on a struggling backend) or
  add a "still loading" UI state (the 2026-08-12 web treatment) — smallest change that
  removes the false-failure; the UX polish is a follow-up.
- Server parallelization is scoped to options ∥ bundle only; `computeSpyBenchmark` and
  activities deadlines (4s each) left as-is.

## Verification State

- `npx tsc --noEmit` clean; full gate (tsc → vitest → build) via `scripts/land.sh`.
- Swift change compiles + tests on hosted `ios-build` (no local xcodebuild).
- Real-world confirmation once deployed: fresh Apple sign-in during the degraded
  window should load instead of failing (server half is live immediately; the iOS
  retry arrives with the next TestFlight ship).

## Next Steps & Blockers

- The underlying slow-broker degradation is the gather-budget P0 (06df80cf, claimed
  by another seat) — this change removes the false-failure amplification, not the
  degradation itself.
- Follow-up candidates: web-style slow-notice state on iOS; parallelize the
  benchmark/activities tail of `getDashboardSnapshot`.
