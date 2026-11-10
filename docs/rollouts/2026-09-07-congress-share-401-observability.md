# 2026-09-07 - congress-share 401 observability + auth circuit breaker

## Summary

- ST's highest-volume live production error, first-hand from `/app/data/litestream-runtime.log`
  on the prod host: `[congress-share] import failed: HTTP 401 {"error":"unauthorized"}` —
  3,096 occurrences, continuous 2026-08-29T15:55Z through 2026-09-07T14:11Z, still firing at the
  last log line. Logged with `console.error` ONLY — no Sentry, no health signal, no alert, no
  backoff, for nine days and getting worse (a 2026-08-31 board audit recorded 914x/48h; the rate
  has climbed since). Board row `8620cad8` (P1).
- Root defect was NOT "the token happens to be wrong" (that is an operator action, see below) —
  it was that `shareWithCongressTrade` (the single choke point every congress-share caller funnels
  through) had no observability and no circuit breaker, so a permanent auth failure retried at
  full cadence forever with zero automated visibility.
- Fixed the observability hole: every attempt now logs into the shared `api_health_log` pipeline
  via `logApiHealth`, the SAME generic mechanism "roic" and "congress.trade" already use to
  surface a degraded `/api/health` dependency and (after 5 consecutive hard failures) a Sentry
  capture + admin alert — no new alerting code, just plugged into the existing one.
- Added an auth-specific circuit breaker: HTTP 401/403 (permanent failure — the shared bearer
  token is wrong) trips a 6h (configurable) cooldown that short-circuits the network call for
  every subsequent caller (scan-hook + the rest of an in-flight nightly-batch chunk loop + future
  runs) until the cooldown elapses, at which point one real probe is allowed through. A
  transient failure (5xx/timeout/network) does NOT trip it — those stay on the existing
  per-caller backoff (the nightly batch already had its own generic 60-minute failure backoff).
  While tripped, the cached failure is still replayed into the health log at the caller's normal
  cadence (no live retry) so the 5-consecutive-failure Sentry/degraded threshold is still reached
  quickly instead of only once per cooldown window.

**Codex round-1 review (post-merge-gate, fixed in this same PR before merge):**

- **Test isolation (P1) — already addressed.** Fixed by commit `bb0ef9689` (already on this
  branch before the review landed): `api_health_log` lives in the one per-file SQLite DB every
  test in `congress-share.test.ts` shares, so three new tests asserting an absolute row count
  (`toHaveLength(1)`/`toHaveLength(3)`) only held in isolation. Now reads the N most-recent rows
  (`getServiceHealthLog` orders `ts DESC, rowid DESC`) instead.
- **Breaker had no identity for the tripping token (P2).** An operator resyncing
  `CONGRESS_TRADE_TOKEN` before the 6h cooldown elapsed stayed blocked for the rest of it — a
  container restart does not help since the breaker lives in the persistent settings DB.
  `CongressAuthBreakerState` now stores a non-secret sha256-prefix fingerprint of the token that
  tripped it; `activeCongressAuthBreakerState` auto-clears a breaker keyed to a different token.
- **Nightly collection not gated on the breaker (P2).** `runCongressDailyShareUnlocked` only
  checked the breaker at the final `shareWithCongressTrade` POSTs — `fetchCongressPriceNeeds`
  (itself an authenticated App A request), the SPX/per-ticker OHLC fetches, and the screener refs
  fetch all still ran every time the nightly job was due, hourly, for the whole cooldown. The
  breaker check now gates the entire collection phase up front.
- **Post-cooldown probe not serialized (P2).** Concurrent overlapping callers (scan-hook firing
  while the nightly batch is mid-run) each treated an expired cooldown as their own independent
  probe, recreating a burst of 401/403 requests. `claimCongressAuthBreakerProbe` now claims the
  single half-open probe slot atomically (read-then-write with no `await` between them, so it is
  atomic against any other same-process caller reaching the same window).
- **Verification state overclaimed (P1).** The original "Verification State" section below listed
  commands without recording any actual output. Replaced with real results (see below).
- **Config knob undocumented (P1).** `CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS` is now in
  `.env.example` and `docs/congress-trade-share.md` (Safety/gating prose + Configuration table).

## Why

Diagnosed the token via non-secret fingerprint comparison ONLY (length + sha256 prefix; no value
ever printed) across Infisical prod for both apps:

- ST Infisical prod (`socratic-trade`, project `39d93bb7-76f9-498c-8b50-a7def52e072f`)
  `CONGRESS_TRADE_TOKEN`: len=64, sha256[:16]=`7b45501aca28f360`
- CT Infisical prod (`congress-trade-6-erm`, project `f61a79de-8d77-4f0b-9361-4b7208598290`)
  `INGEST_TOKEN`: len=64, sha256[:16]=`202ed3f3e0449633`
- CT Infisical prod `ADMIN_TOKEN`: len=64, sha256[:16]=`9290fbbb012e9914`

ST's token matches NEITHER of CT's two candidate ingest tokens. **CONFIRMED: token drift** — the
shared bearer token has diverged between the two apps' Infisical prod projects. This is the
proximate cause of the 401s. Rotating/resyncing the credential is an OWNER action (see Follow-ups
below); this rollout does not touch it. The production container itself was not reachable for a
third fingerprint (no SSH/Tailscale from this session) — Infisical prod is what Coolify injects
into the container at boot (per `/Users/jay/apps/COOLIFY.md`), so the Infisical-level mismatch is
the operative one regardless.

Independent of the token, nine days of a money-adjacent integration being completely dead with
nobody paged is a real defect on its own — the fix in this rollout stands regardless of when/how
the token gets resynced, and prevents the next auth drift (or any other 401-shaped failure) from
being silent again.

## Files

- `src/lib/congress-share.ts` — `logApiHealth` import; `AUTH_BREAKER_KEY` +
  `CongressAuthBreakerState` + `authBreakerCooldownMs`/`readCongressAuthBreakerState`/
  `isCongressAuthBreakerTripped`/`tripCongressAuthBreaker`/`clearCongressAuthBreaker`/
  `resetCongressAuthBreakerForTests`; `shareWithCongressTrade` now checks the breaker before
  every network attempt, logs ok/fail to `api_health_log` (service `congress-share`, keySource
  `env`) on every real attempt and every breaker-absorbed attempt, and trips/clears the breaker
  on 401/403 vs success respectively.
- `app/api/admin/connections-health/route.ts` — added `{ service: "congress-share", keySource:
  "env" }` to `EXPECTED_BACKEND_LANES` so the admin Connections UI always shows a card for this
  lane instead of only appearing after the first logged failure.
- `test/congress-share.test.ts` — new tests: health-log rows on success/failure, breaker trips on
  401/403 and short-circuits the very next call (no fetch), breaker does NOT trip on 5xx/transport
  errors, breaker-absorbed calls still replay into the health log, and the breaker clears + resumes
  real sends after the cooldown elapses and a probe succeeds. `beforeEach` now also resets the
  breaker (`resetCongressAuthBreakerForTests()`). Round-2 adds: a since-resynced token clears a
  stale breaker and probes immediately; the post-cooldown probe is serialized across concurrent
  overlapping callers; the nightly batch skips the entire collection phase (no OHLC fetch at all)
  when the breaker is tripped.
- `.env.example`, `docs/congress-trade-share.md` — round-2: documented
  `CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS`.
- `docs/EFFORT-LOG.md`, `/Users/jay/apps/TRADING-EFFORT-LOG.md`, `STATUS.md`, `PLAN.md` — handoff
  records for this lane.

## Decisions & Trade-offs

- No new alerting code. `logApiHealth` -> `alertConnectionFailure` -> Sentry `captureMessage` +
  `deliverSystemAlertToAdmins` already exists and already gates on the same "5 consecutive hard
  failures" heuristic the rest of the codebase relies on to avoid single-blip noise (see
  `db-health.ts`'s own header comment on why). Building a parallel/bespoke alert for this one lane
  would have reintroduced exactly the "two uncoordinated alerts for one event" problem `db-health.ts`
  already documents having fixed once (2026-07-07, RAG lanes).
- The breaker is a SINGLE shared circuit for the whole module, keyed off the fact that every
  outbound caller (the after-scan hook, the nightly batch's chunked payload loop, any future
  caller) already funnels through `shareWithCongressTrade`. Tripping it once silences the whole
  storm without needing separate gating per caller.
- Chose to keep replaying the cached failure into the health log while the breaker is tripped
  (rather than going fully silent) so the existing 5-consecutive-failure Sentry threshold is still
  reached at the caller's normal cadence (e.g. within a few scans), not delayed until 5 real
  cooldown-gated probes have failed (which at a 6h default cooldown would take ~30 hours). The
  trade-off: while tripped, `/api/health`'s `congress-share` dependency reflects the LAST real
  HTTP response, not a fresh one, for up to one cooldown window — acceptable since a circuit
  breaker inherently trades monitoring freshness for not hammering a known-broken endpoint, and the
  cooldown is configurable (`CONGRESS_SHARE_AUTH_BREAKER_COOLDOWN_MS`).
- 401 and 403 both trip the breaker (both are auth-class, permanent-until-fixed failures); 5xx and
  network/timeout errors do not, since those may well be transient (matches how the nightly batch's
  own existing 60-minute generic failure backoff already treats "some failure" without
  distinguishing cause — this adds the missing cause-specific fast path on top of it).
- Did not touch the public `/api/health` route itself — "roic" and "congress.trade" get their
  dependency entries purely from the generic `getServiceHealthSummaries()` walk over
  `api_health_log`, with no service-specific code in `route.ts`. Logging into that same table with
  service `congress-share` reproduces the exact same pattern with zero route.ts changes.

## Verification State

Round-2 (this session), actual results — not just the command list:

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` (`src/lib/congress-share.ts`, `test/congress-share.test.ts`) — 0 errors,
  20 pre-existing `no-unused-vars`/`no-explicit-any` warnings in test mock signatures, `warn`-only
  per `eslint.config.mjs`.
- `npm test` (vitest), targeted — `test/congress-share.test.ts`: 61 tests, all green (58 existing
  + 3 new for the round-2 fixes). A whole-repo `npm test` run was started locally but did not
  finish within this session (large suite; no failures observed in the output produced before it
  was stopped) — the `verify` CI check is the authoritative full-suite gate and runs
  automatically on push.
- `npm run build` — production build clean. First attempt failed
  (`ERR_PACKAGE_PATH_NOT_EXPORTED` on `@sentry/nextjs/config`) because this worktree's
  `node_modules` was stale relative to `package-lock.json`; `npm install` resynced it. Second
  attempt failed on `import { createHash } from "node:crypto"` — webpack could not bundle the
  `node:` scheme through the `congress-share.ts` → `scheduler.ts` → `background-worker-startup.ts`
  import graph; fixed by switching to the repo's own bare `"crypto"` import convention (matches
  `db-health.ts`). Third attempt: clean, exit 0.

## Next Steps & Blockers

- **Owner action required — credential resync.** ST's `CONGRESS_TRADE_TOKEN` (Infisical prod,
  `socratic-trade` project) does not match CT's `INGEST_TOKEN` or `ADMIN_TOKEN` (Infisical prod,
  `congress-trade-6-erm` project). Someone needs to decide which side is authoritative and either:
  1. Copy CT's current `INGEST_TOKEN` (or `ADMIN_TOKEN`, whichever CT's
     `/api/admin/securities/import` verifier actually checks) value into ST's
     `CONGRESS_TRADE_TOKEN` in Infisical prod, or
  2. Rotate CT's ingest token and update ST's `CONGRESS_TRADE_TOKEN` to match.
  Then restart the ST Coolify container (`d83b1aykr03uwr32yhgzaiay`) so it re-reads Infisical at
  boot. This rollout deliberately does not perform that rotation/resync (secret-safety + owner
  action boundary).
- After the resync, `/api/health`'s `dependencies.congress-share` should read `ok: true` (or not
  appear until the next real attempt); the admin Connections page card for "congress-share" should
  clear.
