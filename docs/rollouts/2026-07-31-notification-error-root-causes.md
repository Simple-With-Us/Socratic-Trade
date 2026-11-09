# 2026-07-31 — Notification-error root-cause fixes (Red Team / Bull empty-response failover, usage-monitor replay self-heal, repeat-notification dedup)

## 1. Context & Objective

Owner pasted the app's notification feed (Picsew PDF) covering 2026-07-28..30 and asked to
troubleshoot the recurring errors, fix what's fixable in code, and itemize what only he can fix.
The feed had five repeating clusters: (a) `Red Team unavailable` (malformed/timeout), (b)
`Strategy run failed — Empty response returned from LLM API.`, (c) usage-monitor ingest
`Idempotency key collision for "41f1fc74…"` every ~6h, (d) dozens of identical `block` /
`pending_approval` notifications for the same stuck conditions (Sell AAPL/EA/JNJ
`available 0`, staleness-gate blocks), and (e) connection failures that trace to lapsed data
subscriptions (massive/Polygon free tier, FMP 403) — owner action items, not code.

## 2. Changes Made

High level: three resilience bugs and one noise bug fixed; every fix is fail-closed-preserving
and loudly audited.

- **`src/lib/red-team.ts`** — all four malformed-content return sites (empty text, multiple
  verdict blocks, unparseable JSON, malformed verdict shape) previously declared the whole
  review `unavailable` immediately, even with `redTeamFallbackModels` configured (only HTTP
  errors/timeouts failed over). Each now `continue`s to the next planned reviewer when one
  remains; chain exhaustion still fails closed exactly as before. Root cause of cluster (a).
- **`src/lib/strategy.ts`** (`proposeTrades`, ~line 5676) — a Bull HTTP-200 with EMPTY content
  threw `Empty response returned from LLM API.` with no failover
  (`isRetryableLlmError` deliberately doesn't match it), killing whole runs. Now fails over
  like any other transient attempt failure, with
  `audit("strategy_llm_failover", { reason: "empty_response", … })`; throws only when the
  chain is exhausted. Root cause of cluster (b).
- **`src/lib/usage-monitor-push.ts`** — `classifierTelemetryMetadata` now strips `gitSha` from
  pushed event metadata. The monitor compares FULL metadata when deduping an idempotency key;
  `gitSha` changes on every auto-deploy, so replaying a ledger row after a deploy collided with
  the same key's pre-deploy content (monitor 409). Also adds `usageMonitorCollisionKeyFromError`
  (extracts the monitor-named key from a 409 `idempotency_conflict`) and
  `usageMonitorV2IdempotencyKey` (shared-pkg `deriveUsageTelemetryV2IdempotencyKey`, producerId
  `socratic-trade`), and an `onIdempotencyCollision` callback on
  `sendReplayBatch`/`sendUsageMonitorBatch`. Root cause of cluster (c).
- **`src/lib/usage-monitor-replay.ts`** — `toEvents` now returns `{row, event}` pairs; the page
  send loop catches a monitor-named 409 collision, maps the key back to the exact ledger row,
  skips it with `audit("usage_monitor_replay_collision_skip", …)` (the collision IS proof of
  prior delivery monitor-side), and resends the rest (bounded by
  `MAX_COLLISION_SKIPS_PER_PAGE = 25`; an all-colliding page counts as acknowledged). Watermark
  can no longer wedge behind one poison row.
- **`src/lib/notifications.ts`** — repeat-dedup for `block` + `pending_approval` notification
  types: fingerprint = `type|SYMBOL|side|normalized primary reason` (digits collapsed to `#` so
  a changing quote age or requested qty can't defeat it); suppressed when an identical
  fingerprint already has a `status='sent'` row within the cooldown (default 6h, env
  `NOTIFICATION_REPEAT_DEDUP_MS`). Suppressed sends return an unrecorded `skipped` event (no
  feed row, no delivery) + audit. Only `sent` rows dedupe — a failed/skipped delivery never
  suppresses the next attempt. Root cause of cluster (d) noise (the underlying blocks remain
  fully persisted as run proposals).

Tests:
- `test/red-team-empty-failover.test.ts` (NEW, 5 tests) — empty/ambiguous/unparseable/
  wrong-shape primary content fails over; chain-exhausted still fails closed.
- `test/strategy-llm-failover.test.ts` (+1 test) — Bull HTTP-200 empty body transparently
  serves via fallback with `reason: "empty_response"` on the failover audit row. Uses a
  distinct primary provider lane (`anthropic/*`) because the pre-existing 429 test legitimately
  parks the `openai` lane in the provider-cooldown registry (`llm-provider-cooldown.ts` keys
  the underlying provider from the model prefix — discovered the hard way; documented in the
  test).
- `test/usage-monitor-push.test.ts` (+3 tests) — gitSha absent from wire metadata even when
  `GITHUB_SHA` is set; `usageMonitorCollisionKeyFromError` extraction/null cases;
  `onIdempotencyCollision` fires with the monitor-named key on 409.
- `test/usage-monitor-replay.test.ts` (+2 tests) — collision self-heal skips exactly the named
  row, resends the rest, advances the watermark, audits the skip; a collision key NOT in the
  page still fails the pass (no blind skipping).
- `test/notification-repeat-dedup.test.ts` (NEW, 7 tests) — identical block suppressed within
  cooldown; digit changes don't defeat the fingerprint; different reason/symbol/type fires;
  failed delivery doesn't dedupe; `NOTIFICATION_REPEAT_DEDUP_MS` honored; fingerprint unit
  tests incl. null cases.

Docs updated: this rollout note, `STATUS.md`, `docs/EFFORT-LOG.md` (+ live board
`/Users/jay/apps/TRADING-EFFORT-LOG.md`).

## 3. Decisions & Trade-offs

- **Failover, not retry, for malformed content**: an overloaded/deprecated model that returns
  empty/garbage will usually do it again immediately; the configured fallback chain already
  exists for exactly this. Fail-closed semantics (unavailable at chain end) are unchanged.
- **gitSha stripped rather than made stable**: every other classifier field is stable across
  deploys for a given ledger row; the deployed sha remains observable via `/api/health` and
  `llm_usage`-side telemetry. Monitor-side follow-up (convert whole-batch 409 to per-event
  rejection) filed as a board row for the Usage-Monitor repo — deliberately NOT done here (that
  repo is on grok's branch right now).
- **Dedup window 6h default, sent-only**: mirrors the option-alert dedupe precedent. A
  delivered block notification re-fires at most 4×/day while a condition persists; the block
  itself is never hidden (run proposals + Approvals are untouched).
- **Collision skip is bounded and audited**: `MAX_COLLISION_SKIPS_PER_PAGE = 25`; an unmatched
  key fails the pass exactly as before. Skip is proof of prior delivery, not data loss.
- The prior session's `market-read routes` WIP (middleware.ts, app/api/market/*,
  src/lib/market-read.ts, test/market-read-routes.test.ts on `agent/kimi-market-read-routes`)
  is NOT part of this change — it was stashed labeled
  "market-read routes WIP (prior kimi session, preserved 2026-07-31 …)" and must be restored
  by whoever resumes that effort (`git stash pop` on that branch).

## 4. Verification State

```bash
npx tsc --noEmit        # clean (after fresh `npm run build` regenerated stale .next/types)
npm run lint            # 0 errors (660 warnings — pre-existing grandfathered backlog)
npm test                # 473 files / 5472 tests, all pass
npm run build           # exit 0
# Targeted re-run after merging origin/main (#2310):
npx vitest run test/notification-repeat-dedup.test.ts test/red-team-empty-failover.test.ts \
  test/red-team.test.ts test/strategy-llm-failover.test.ts test/usage-monitor-push.test.ts \
  test/usage-monitor-replay.test.ts test/notification-lifecycle.test.ts
# 7 files / 110 tests, all pass
```

Live prod probes (7/30 and 7/31): `/api/health` shows `litestreamState: "unknown",
source: "none"` (was working 7/11 — socket IPC unreadable in the Coolify container),
`massive tier: "free"` (paid plan lapsed; 15-min-delayed quotes → staleness-gate blocks +
5 req/min clamp + 429s), `fmp probe HTTP 403` (subscription suspended). These are NOT
code bugs — see Next Steps.

## 5. Next Steps & Blockers

**Owner action items (cannot be fixed in code):**
1. **Polygon/Massive paid plan lapsed** → renew. This is the root cause of the 15-minute-delayed
   quotes, the staleness-gate blocks (quotes "17 min–13 days old"), the 5-req/min clamp, and
   most `massive 429` noise.
2. **FMP subscription suspended (HTTP 403)** → renew or remove the key from Infisical.
3. **roic.ai / vix-yahoo 429s** → review RapidAPI quota/renewals.
4. **Litestream unreadable on prod** (high priority — DB replication freshness is unverifiable):
   in the Coolify `socratic-trade-prod` container check `ls -la /var/run/litestream.sock` and
   the litestream process/logs; it worked 7/11 and broke sometime before 7/30.
5. **Stuck sell orders** blocking sells (available 0): Alpaca order ids `32150898` (AAPL 6sh),
   `389D3F2B` (EA 3sh), `24BA055F` (JNJ 8sh) — cancel/replace at the broker or let them fill.
6. Usage-Monitor repo follow-up (filed on board): convert the idempotency collision from a
   whole-batch 409 to per-event rejection (`src/lib/external-usage-events.ts` ~L341,
   `src/app/api/ingest/usage/route.ts` ~L365). Not done now — repo is on grok's branch.
7. Pinecone `request_window` errors predate AG's 7/29 TTL-cache fix — already resolved.

**Agent follow-ups:** restore the market-read WIP stash when resuming that effort; land this
branch via `scripts/land.sh`.

## 6. Zero-Code Findings

- congress.trade 502s correlate with auto-deploy windows (Coolify restarts); current health OK.
- OpenRouter "empty response" and Red Team "malformed" errors were provider-side content
  glitches on specific models, not quota (OpenRouter credits healthy: ~$17.3 remaining 7/31).
