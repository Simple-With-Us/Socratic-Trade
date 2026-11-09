# 2026-09-08 — Transport blips stop paging as provider outages

## 1. Context & Objective

A dozen Sentry issues in `socratic-trade`, all titled `"<service> connection failed"`, ran from
2026-08-13 to 2026-09-08 across a dozen unrelated integrations, and two of them paged PagerDuty
(#108 `roic`, #112 `congress-share`).  The common thread was never a vendor: Node's `fetch()`
collapses a dead keep-alive socket, a DNS hiccup, or an `ECONNRESET` into a bare `"fetch failed"`
whose real reason hides on `err.cause`, and that bare string matched none of `db-health.ts`'s
soft-failure shapes.  A burst lane that issued five requests seconds apart during one upstream
hiccup therefore produced five consecutive HARD failures, tripped
`HEALTH_REASON_CONSECUTIVE_FAILURES`, and captured at Sentry `error` — which is what pages.

Objective: stop a socket that died and came back from waking anyone, without making a real
network outage silent.  This is the API-health path only.  No order-placement, brokerage, or
money-path code is touched.

## 2. Changes Made

A third failure class between "expected limit" and "hard", plus retry shaping at the one shared
fetch boundary that already owns provider retries.

- `src/lib/db-health.ts`
  - `HEALTH_TRANSIENT_FAILURE_PREFIX` (`[transient-network] `) and `isTransientHealthFailure()`
    — narrow Node/undici transport shapes only (`fetch failed`, `UND_ERR_SOCKET`,
    `other side closed`, `socket hang up`, `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`,
    `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`).  An expected
    limit or a caller abort is never reclassified: `isSoftHealthFailure` wins.
  - `logApiHealth` stamps the prefix on a transport failure.  It stamps, it does not soften — the
    row still counts toward the hard consecutive-failure streak.
  - `getLaneHealth` now also returns `transientStreak` (every row of the hard streak is a blip)
    and `streakStartedTs` (start of the entire consecutive hard-failure run — walk past last-5
    until a success/soft break — so a busy lane can still escalate past warning).
  - `HEALTH_TRANSIENT_ESCALATION_MS` (10 min, override
    `HEALTH_TRANSIENT_ESCALATION_MINUTES`).  A hard streak made entirely of blips that has not yet
    lasted that long captures at Sentry `warning`, skips the operator push, and arms a cooldown of
    only the escalation window instead of the standard 6 h — on a separate `:transient` cooldown
    key so a later hard failure is never suppressed.
  - `alertConnectionFailure` gained `transientBlip`, and every capture now carries a
    `health.failure_class` tag (`transient-network` | `hard`).
- `src/lib/network-errors.ts` — the transport text shapes now live here as one exported classifier
  (`isTransientNetworkErrorText`), which `isTransientNetworkError` also uses.  Explicit `HTTP ###`
  status errors are rejected before the transport substring patterns so a provider body containing
  `fetch failed` stays hard.  Also `isIdempotentRequest()` (GET/HEAD/OPTIONS; `fetch()` defaults to
  GET so a method-less `init` is replayable) and `jitteredBackoffMs()`
  (`TRANSIENT_RETRY_JITTER_RATIO` = 0.3).
- `src/lib/vector-db.ts` — the RAG lanes have their own alerter and are excluded from the generic
  path above.  `ragLimitStatus`'s soft `"transient"` arm was **narrowed**: it no longer matches
  `fetch failed` / `UND_ERR_SOCKET` (those soft-stamped the health row and returned before
  escalation).  Transport shapes are classified by `isTransientNetworkErrorText` /
  `describeNetworkError` (cause-chain aware for PineconeConnectionError wrappers) so a short blip
  stays `warning` and a sustained outage escalates to `error` after the shared window —
  `SOCRATIC-TRADE-1X` (56 events) and `-22`.  Health row stays hard (not soft); streak +
  `provider_degraded` notification unchanged.
- `src/lib/data-providers.ts` — `fetchWithRetry` replays a transport error only for a replayable
  method or an explicit `retryNonIdempotent`, and both its transport and 429 backoffs are now
  jittered.  The one existing POST caller (the news `/search` query) opts in, so its behavior is
  unchanged.
- `src/lib/alpaca-account-insights.ts` — its own bounded retry uses the shared jittered backoff.
- `test/health-transient-network-classification.test.ts` — new (transport class, durable streak, RAG tags).
- `test/pinecone-metadata-and-rag-limits.test.ts` — `ragLimitStatus` no longer soft-classifies fetch failed.
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md` — coordination mirrors for this effort.
- `docs/rollouts/2026-09-08-transient-network-health-classification.md` — this handoff.

## 3. Decisions & Trade-offs

- **A blip is not "soft".**  Folding transport errors into `HEALTH_SOFT_FAILURE_PREFIX` was the
  obvious one-line fix and it is wrong: soft rows are excluded from the hard streak entirely, so a
  provider that became genuinely unreachable would never page again.  A blip is a *candidate*
  outage — it counts, it just does not get to page on its own within the window.
- **Escalate on elapsed time, not on a bigger count.**  The two prod shapes differ by cadence, not
  by volume.  A burst lane produces its whole five-failure streak inside one hiccup; a
  low-frequency hourly probe spreads five consecutive failures over hours and so clears a 10-minute
  window on its very first alert — a real outage there still pages exactly as it does today.  A
  larger count threshold would have silenced the low-frequency lanes instead.
- **Shorten the cooldown for a non-escalated blip, on a separate key.**  Arming the standard 6 h
  cooldown on a warning-level blip would silence a real outage that started two minutes later.
  The blip arms only the escalation window on a `:transient` cooldown key, so a later hard failure
  (HTTP 401/500) is never suppressed, and the next failure in an unbroken streak escalates on
  schedule.
- **The idempotency gate is a behavior change, deliberately narrow.**  `fetchWithRetry` previously
  replayed a transport error for any method.  Only one caller sends a POST through it (a read-only
  news search), and it is opted back in explicitly, so nothing regresses — but the default is now
  safe, because a transport error is indistinguishable from "the far side processed it and the
  reply was lost".
- **The RAG lane gets a level change, not a suppression.**  Widening `ragLimitStatus`'s transient
  arm was rejected (soft-stamp + early return would silence a sustained outage).  Instead that arm
  was **narrowed** to drop `fetch failed` / `UND_ERR_SOCKET`, and `alertRagConnectionFailure` uses
  `isTransientNetworkErrorText` (plus nested-cause flattening) for warning→error escalation.
- **Not changed:** `retries: 0` at the `massive` and `roic` recommendation call sites (deliberate,
  left alone), `congress-share`'s POST import (non-idempotent — must not be replayed), and
  `tradier.ts` (brokerage; out of scope by instruction).

## 4. Verification State

Worktree tip (fixer, 2026-09-09): `/workspace/st-rebase/3195` on
`claude/sentry-getjson-soft-failures`.  Local `node_modules` is not present in this checkout, so
the ordered AGENTS.md `lint` → `tsc` → `test` → `build` sequence cannot be run here.  Hosted
`verify-hosted` on the tip SHA is therefore the gate before merge — do not treat this tip as
locally green.

Targeted classification coverage intended once deps exist (or on hosted):

```
npx vitest run test/health-transient-network-classification.test.ts
```

That suite now also covers: HTTP-status bodies are not transport-transient; `streakStartedTs`
anchors to the full consecutive hard-failure run (not last-5 only); a hard failure after a
transient-blip warning is not suppressed by the transient cooldown key.

## 5. Next Steps & Blockers

- Watch the twelve `"<service> connection failed"` issues after deploy.  The expected outcome is
  that they keep receiving events at `warning` and stop producing `error`-level events (and so stop
  paging), with `health.failure_class` separating the two classes in Sentry search.
- If a lane still pages at `error` with `health.failure_class:hard`, that one is a genuine
  provider/auth failure and needs its own fix — this change deliberately leaves those alone.
- `congress.trade` (`SOCRATIC-TRADE-1W`) already logged its transport errors `soft: true` before
  this change; its remaining `error`-level events come from HTTP 5xx responses, which stay hard by
  design.  Do not expect that one to go quiet.

## 6. Zero-Code Findings

`SOCRATIC-TRADE-28` (`alpaca-account-insights`) was already fixed on `main` by the
`claude/web-401-routes-to-login` lane; this change only moves its retry onto the shared jittered
backoff.
