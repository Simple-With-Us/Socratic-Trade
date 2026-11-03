# 2026-11-03 - st-proxy-pacing

## Summary

- Proxied data-source requests now pass through one process-wide concurrency gate in `createProxiedFetch`, so a provider burst can no longer arrive at the Mango's tinyproxy all at once.  The default cap is 4 in flight, set by `PROXY_MAX_CONCURRENCY`.
- The proxy leg timeout default rose from 3000ms to 15000ms, matching ~10s-class residential latency, with `RESIDENTIAL_PROXY_LEG_TIMEOUT_MS` as the override.  fail_soft / fail_closed semantics are unchanged.
- Time spent queued for a gate slot never counts against the leg timeout: the leg timer is only created after a slot is granted.  The wait is reported on the request's proxy-use entry as `queueWaitMs` when it is measurable.

## Why

- The data-provider cascade dispatches concurrent waves (Promise.all across providers) and every proxied call funnels through the one tinyproxy on the Mango.  Per-provider pacers exist, but nothing paced the proxy itself, so bursts pushed legs past the old 3s cap, the app fell back to direct egress (fail_soft), and the watchdog's leg2 probes failed in the same window before self-clearing in ~90s.  The Mango itself is idle-healthy (verified from the owner's Mac on 2026-11-03: admin page 200 in 54ms, a proxied request in 0.28s), so this is burst congestion, not a device fault.  The owner authorized changing how ST uses the proxy on 2026-11-03.

## Files

- `src/lib/proxy-fetch.ts` — `ProxyConcurrencyGate` (FIFO, abort-aware) plus the shared globalThis-pinned instance, `resolveProxyMaxConcurrency`, `resolveProxyLegTimeoutMs`, `PROXY_LEG_TIMEOUT_MS` default 15000, gate wiring inside `createProxiedFetch` (slot held until the body settles via the extracted `wrapBodyUntilSettle`), `onQueueWait` callback.
- `src/lib/data-source-fetch.ts` — leg timeout now resolved through `resolveProxyLegTimeoutMs(deps.env)`; the default proxied-fetch factory forwards queue waits into the proxy-use entry.
- `src/lib/proxy-use-log.ts` — optional `queueWaitMs` field on `ProxyUseEntry`.
- `test/proxy-concurrency-gate.test.ts` — new: resolver coverage, gate cap/FIFO/abort/idempotent-release coverage, the queue-wait-vs-leg-timeout regression test, and end-to-end dataSourceFetch tests against a local proxy server (cap serialization + logged wait; env leg timeout + fail_soft fallback).
- `STATUS.md` — snapshot entry for this change.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run test/proxy-fetch.test.ts test/data-source-fetch.test.ts test/proxy-use-log.test.ts test/proxy-use-route.test.ts test/proxy-concurrency-gate.test.ts test/data-sources-breadth.test.ts test/user-proxy-settings.test.ts` — 7 files, 108 tests, all pass.
- `npx eslint src/lib/proxy-fetch.ts src/lib/data-source-fetch.ts src/lib/proxy-use-log.ts test/proxy-concurrency-gate.test.ts` — clean.
- Full `npm test` (TMPDIR pointed at the lane because the suite generates >4 GB of temp DBs and the VM's /tmp is a 512 MB tmpfs): 879 files, 9,947 tests — 9,902 passed, 42 skipped, 3 failed.  All 3 failures are environmental, proven against a pristine-main baseline worktree: `test/egress-guard.test.ts`'s real-DNS case fails identically on main in this sandbox (no direct DNS egress), and `test/rth-deploy-latch.test.ts`'s two CLI cases fail only when the spawned tsx IPC pipe path overflows the socket-path limit under this lane's deep TMPDIR (and when /tmp fills under the default TMPDIR) — the file passes 24/24 in this lane with a short TMPDIR, and the latch script itself returns the expected exit codes when run directly.

## Follow-ups

- Not pushed and no PR opened from this lane: Muse-Assist (MA) reviews, pushes via the Mac route, and opens the PR.
- After deploy, watch `/api/proxy-use`: bursts should show a handful of entries with `queueWaitMs` set instead of fail_soft fallback spikes, and the watchdog leg2 alerts should stop tracking ST scan bursts.
- The Linear claim and #Work-In-Progress posts for this lane are MA's to make under the fleet protocol.
