# 2026-11-14 - /api/proxy-use Mango probe false alerts (leg2)

## Context & Objective

The VM watchdog's leg2 check reads `GET /api/proxy-use` and alerts when the app reports the residential proxy (the Mango) unreachable from the Coolify host.  Nov 13–14, 2026 it confirmed 22 failures on Nov 14 alone (flap counter 11 in 30 minutes at one point), while direct checks minutes later always found the WireGuard tunnel, tinyproxy, and the proxy itself healthy, real proxied traffic kept flowing, and Socratic Trade stayed healthy.  Confirm-to-clear gaps in the watchdog log cluster at 85–125 seconds — one watchdog cycle — which points at a single bad probe sample being read twice, not at an outage recovering.

## Changes Made

The probe moved out of the route into `src/lib/mango-probe.ts` (Next.js rejects extra exports on route modules; the repo precedent is `src/lib/health-probe-cache.ts`).  A check now makes up to 3 connect attempts, each bounded by a wall-clock deadline of 3s with a 250 ms pause between attempts; any successful connect makes the check reachable.  Verdict caching is asymmetric: successes are cached 60s as before, failures only 5s, so the watchdog's confirmation re-read ~10s later runs a genuinely fresh check instead of re-reading the failed sample.  The `mango` payload gains `attempts` and `failureKind` (`timeout` | `refused` | `error` | null): a refused connection is the real-outage signature, a timeout is path latency or loss, and `error` with `attempts: 0` means the check itself could not run (for example an unresolvable proxy URL) — the conflation the old payload forced on consumers.  `reachable` keeps its meaning: a proxy that refuses or black-holes every attempt still reports unreachable and the watchdog still alerts.  The route is now a thin handler over `getMangoProbe()` and keeps its never-throw fallback (which also carries the new fields).

- `src/lib/mango-probe.ts` (new)
- `app/api/proxy-use/route.ts`
- `test/mango-probe.test.ts` (new)
- `STATUS.md`
- `docs/rollouts/2026-11-14-leg2-proxy-use-probe.md`

## Decisions & Trade-offs

Three attempts at 3s plus two 250 ms pauses bounds one check at ~9.5s worst case, inside the watchdog's 15s read budget; the refused path answers in about a second, so a genuinely dead proxy is not delayed.  The per-attempt timeout stays 3s because healthy connects on this path measure up to ~2s; the fix is retries plus a real deadline, not a longer single wait.  The old code's `Socket.setTimeout(3000)` never bounded the connect phase — the socket inactivity timer only runs once connected — proven live on Nov 14 when the probe recorded `latencyMs` 29,260 with `reachable: true`, and the watchdog read behind that probe timed out completely (one of 29 "not assessable" reads that day).  The new connect enforces its bound with an explicit wall-clock timer and keeps `setTimeout` as a backstop.  Failure caching is shortened rather than removed so a flapping path cannot turn every watchdog read into three fresh connects.  No watchdog thresholds, Mango tunnel, tinyproxy, or host egress configuration were touched.

## Verification State

- `npx vitest run test/mango-probe.test.ts test/proxy-use-log.test.ts test/proxy-fetch.test.ts test/proxy-concurrency-gate.test.ts test/proxy-gate-slot-leak.test.ts` — 5 files, 70 tests, all passed.  The new file covers: first-attempt success; the captured incident shape (first attempt times out, retry connects at 140 ms → reachable, attempts 2); all-refused → unreachable with `failureKind: "refused"`; all-timeout → unreachable with `failureKind: "timeout"`; failure cache expiring before the watchdog's +10s confirmation read so the re-read re-probes; success cached for the full 60s; unresolvable proxy URL → `failureKind: "error"`, zero attempts, never throws.
- `npx tsc --noEmit` — exit 0.
- `npx eslint src/lib/mango-probe.ts app/api/proxy-use/route.ts test/mango-probe.test.ts` — exit 0.
- `npm run build` with `NODE_OPTIONS=--max-old-space-size=4096` — exit 0, including `stamp-csp-static-hashes` (one pre-existing Sentry Edge Runtime warning, unrelated to this diff).
- Live evidence gathered Nov 14, 19:49–20:04 UTC from the VM via the tailnet proxy: 34 fetches of `https://socratictrade.com/api/proxy-use` — 33 HTTP 200 (not one carried `reachable: false`) and one curl timeout at 30s behind the 29,260 ms probe; healthy `latencyMs` samples 117–2,008 ms; `lastHour` steady at 65 proxied / 2 proxy errors.  Direct checks in the same window: `GET /api/live` 200, Coolify app `running:healthy`, and 20/20 timed TCP connects from inside the app container to 10.99.0.2:8888 at ~140 ms.

## Next Steps & Blockers

Do not merge from this lane; merging to `main` follows the weekday RTH latch and auto-deploys.  Production behavior changes only after merge + deploy — the flapping will continue until then.  A separate defect sits in the watchdog script (outside this repo): its proxy-use summary formatter has seven `%` specifiers for six arguments, throws `TypeError: not enough arguments for format string` on every confirmed alert that carries a `latest` entry, and the shell fallback prints "proxy-use parse failed" — so that string in past alerts is the formatter, not endpoint evidence.  It is reported to the owner with this rollout; the watchdog itself was not changed here.

## Zero-Code Findings

The endpoint's probe target resolution (`resolveResidentialProxyUrl`, `proxyProbePort`, `safeProxyHostForLog` in `src/lib/proxy-fetch.ts`) is correct and unchanged.  The endpoint is served by more than one app process with independent probe caches (two distinct probes observed 26 ms apart), which is harmless under the new TTLs.  Linear: this fix was executed under an owner-approved Idea activation rather than a Linear claim; no ST issue was claimed by this seat.
