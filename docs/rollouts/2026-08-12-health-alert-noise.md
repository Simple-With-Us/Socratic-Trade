# 2026-08-12 - health-alert-noise

## Context & Objective

Sentry carried ~28 distinct `"<name> connection failed"` issues, almost none of which corresponded
to a real outage.  The goal was to make connection-health alerting fire on OUTAGES and stay silent
on BLIPS, without weakening any genuine-outage signal.  Seven root causes were identified and
adversarially verified before this branch; this note records the implementation.

## Changes Made

Seven independently reviewable fixes, kept separate in the diff:

1. **Streak gate (the dominant noise source).**  `src/lib/db-health.ts` gated the alert on
   `lane.stoppedWorking`, which is set by THREE conditions: the hard 5-consecutive-failure streak
   and two SOFT heuristics ("active in past hour but no successful call ever" / "…no success in
   60 min").  On a low-frequency lane the very first transient failure satisfies a soft heuristic
   instantly — one call this hour, zero successes — so a single blip paged with no streak at all.
   The gate now requires `lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES`.  The soft heuristics
   are untouched: they still paint the lane in Admin Connections, they just no longer page.

2. **Sentry fingerprint fragmentation.**  Both capture helpers fingerprinted by message text, and
   those messages embed a DISPLAY name that drifts ("Voyage" vs "voyage", "OpenRouter" vs
   "OpenRouter embed" vs "OpenRouter rerank"), so one RAG embed lane fragmented into six issues.
   `captureHealthSentryMessage` now sets `["api-health", service]` and `captureRagSentryMessage`
   sets `["rag", lane ?? provider]` — stable lane ids that survive any future title rewording.

3. **Rate-limit asymmetry.**  `db-health` has always passed `skipSentry` for 429/rate-limit-shaped
   text, but the RAG path had no equivalent, so OpenRouter 429s paged while the identical failure
   on every other provider did not.  `alertRagConnectionFailure` now computes `ragLimitStatus`
   BEFORE the capture and skips Sentry when it is `rate_limited`.  The `provider_degraded`
   notification and the `alertUsageLimitHit` escalation (the right channel for a rate limit, with
   its own cooldown and recommendation) both still fire.

4. **Self-sustaining re-probe loop.**  `health-lane-reprobe.ts` passed `soft: true` only on
   429-shaped probe failures.  A re-probe is SYNTHETIC traffic generated precisely because the lane
   is already known-red; logged hard, each probe failure re-satisfied the alert gate, re-armed the
   6h cooldown, and kept the lane in the probe candidate set — a loop that alerted forever about a
   lane no product code was calling.  All probe failures (both the `probe_fail` branch and the
   thrown-probe catch) are now soft.  Rows are still `ok=0`, so the lane still reads red in
   Connections and the probe cadence is unchanged.

5. **Retired vendors still alerting.**  `logApiHealth`'s alert guard now also excludes
   `isIntentionalOffHealthService` (FMP / Quiver / Unusual Whales).  Admin Connections already
   renders these as muted OFF; a residual call site must not additionally page about a vendor the
   product deliberately stopped using.

6. **Timeout too tight.**  `usage-budget.ts` and `usage-monitor-knobs.ts` both defaulted to 2500ms
   for a cross-internet read whose failure is explicitly fail-open, while the health-lane re-probe
   against the same host already allows 8000ms — so the probe passed while the real read timed out.
   Both defaults are now 8000 (still overridable via `USAGE_BUDGET_TIMEOUT_MS` /
   `USAGE_MONITOR_KNOBS_TIMEOUT_MS`), and both catch blocks now pass `soft: true`, since a
   fail-open read that changes no behavior must not report at `level=error`.

7. **Mislabelled local fault.**  `storeContexts`'s catch reported a LOCAL SQLite receipt /
   commit-finalize failure as an error-level `"RAG vector store failed"` vector-store event — the
   same mislabel class as the 2026-08-09 "Pinecone connection failed / database is locked" pushes
   (`docs/rollouts/2026-08-09-pinecone-lock-mislabel.md`), one seam further in.  See the deviation
   note below for why the obvious edit would have been a no-op.

### Files

- `src/lib/db-health.ts` — streak gate, retired-vendor guard, api-health fingerprint
- `src/lib/vector-db.ts` — rag fingerprint, 429 Sentry skip, local-fault attribution in `storeContexts`
- `src/lib/local-db-fault.ts` — new `localDbFaultReason`, cause-chain walking
- `src/lib/health-lane-reprobe.ts` — all probe failures soft
- `src/lib/usage-budget.ts` — 8000ms default, `soft: true`
- `src/lib/usage-monitor-knobs.ts` — 8000ms default, `soft: true`
- `test/health-alert-noise-gate.test.ts` — new
- `test/local-db-fault-classification.test.ts` — cause-chain case
- `test/vector-db-backlog-c-integration.test.ts` — fingerprint assertion, 429 case, `setFingerprint` on the scope mock
- `test/vector-db-document-receipts.test.ts` — local-fault attribution case

## Decisions & Trade-offs

- **Deviation on item (7).**  The brief warned that a naive `isLocalDbFaultError(err)` at the
  `storeContexts` catch could be a no-op.  It is: both local seams rethrow as
  `new Error("document-receipt-write-failed" | "document-local-commit-finalize-failed", { cause })`
  (`src/lib/vector-db.ts:3309` and `:3335`), so the wrapper's own message matches no SQLite pattern
  and carries no `code`.  Classifying the wrapper alone would silently do nothing.  The implemented
  equivalent adds `localDbFaultReason(error)` to `local-db-fault.ts`: it walks the `cause` chain
  (bounded to 3 links, so a self-referential chain terminates) and returns the RAW SQLite text, so
  the audit row and the "local database contention" advisory quote the real error instead of the
  opaque wrapper label.  `isLocalDbFaultError` is now defined in terms of it, which also makes the
  existing `withRagApiHealth` classifier at `vector-db.ts:1589` see through wrapping.  Control flow
  is unchanged at both sites: the same result object / the same rethrow.
- **Fingerprints are guarded on the key being present.**  An absent `service`/`lane` falls back to
  Sentry's default (message-text) grouping rather than collapsing every unkeyed event into one
  issue.
- **Soft is not silent.**  Every change in items (4) and (6) still writes `ok=0` health rows.  The
  Admin Connections view is unchanged; only the paging behavior is.
- **`scope.setFingerprint` is called unguarded** (matching how `setLevel`/`setTag`/`setContext` are
  already called).  The existing `typeof captureMessage !== "function"` guards in those helpers
  exist for the ESM-interop module shape, not the scope shape.  The one test harness that stubs a
  scope object gained a `setFingerprint` spy.

## Genuine outages still alert — confirmed

The two Sentry issues that represent REAL upstream failures are covered by explicit regression
guards in `test/health-alert-noise-gate.test.ts`:

- **congress.trade 502s (SOCRATIC-TRADE-B / -8 / -1P)** — a genuine upstream outage produces a run
  of hard 5xx within minutes, reaching the 5-hard streak, so the alert still fires.
- **filingapi 401 (SOCRATIC-TRADE-1G)** — a broken credential fails every call, so it reaches the
  hard streak too; a 401 is not soft-classified, so nothing suppresses it.

Both guards pass with AND without the fix (they must), which is the point: they fail loudly if a
future change over-suppresses.  Discrimination was verified by reverting each source change and
re-running: 8 of 11 cases in the new file fail on the pre-fix code, as do all four new/updated RAG
cases.  The three that pass either way are exactly the two outage guards plus the `quotaResetAt`
single-signal path.

## Verification State

Run with `/opt/homebrew/opt/node@24/bin` first on `PATH` (the Mac's default node is v26, whose ABI
mass-fails `better-sqlite3`):

```
npm run lint      # 0 errors, 750 warnings (pre-existing grandfathered backlog)
npx tsc --noEmit  # clean
npm test          # see PR body
npm run build     # see PR body
```

## Next Steps & Blockers

- None blocking.  After this lands, the ~28 open Sentry issues can be bulk-resolved; anything that
  reopens is by construction a lane with a real 5-hard streak.
- Optional follow-up: the two soft "no-success" heuristics still mark lanes stopped in
  `getServiceHealthSummaries`, which several non-alerting consumers count.  Nothing in this change
  depends on revisiting that, but it is the next place noise would surface if it does.
