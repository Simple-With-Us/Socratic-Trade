# DEEPSEEK → Implementer: Backend / API / Ops / Docs Handoff

Source: docs/audits/2026-08-20-deepseek-backend-ops-docs.md (full report) + detail reports
docs/audits/2026-08-20-deepseek-{api-routes,scripts,docs}.md — all committed on main.  Every finding below
is already FILED on the board — `board claim <id>` before work, do NOT re-file.  Review base @ 41a7a438d;
verify against origin/main before starting (tree must be clean, HEAD must be current).

Board IDs for this track: `99ab01c7` (P1 drain), `8c9ce3b9` (P1 deployment.md R2), `220c6cc6` (P2 freshness
watchdog RTH), `68d11cc9` (P2 retired-lane scripts), `7db3350e` (P2 ops doc topology), `3a8bcdcf` (P3
from-draft rate limit), `d6f0a9d3` (P3 API error honesty), `cc0caa64` (P3 checkBrokerHealth inline),
`51c52fd6` (P3 /api/health heavy), `67558af0` (P3 quotes asOf).

## 1. Top items to implement first (in order)

1. `99ab01c7` — drain exits 0 on failed nudge.  `scripts/rth-deploy-drain.sh:136-139` (`if [ "$nudge_ok" -eq 0 ]; then …; exit 0; fi`); workflow wiring `.github/workflows/rth-deploy-latch.yml:66-71,88`.
2. `8c9ce3b9` — deployment.md mislabels live replica as R2.  `docs/deployment.md:70-71` ("runs Litestream (when R2 is enabled)") and `:80-81` ("Litestream → R2 when enabled; … B2 offsite …").
3. `220c6cc6` — freshness watchdog pages on deliberately latched merges.  `scripts/alert-deploy-freshness.sh:202-217` (no RTH awareness).
4. `3a8bcdcf` — from-draft money path unthrottled.  `app/api/proposals/from-draft/route.ts:40` (POST, broker reads at :155-165, DB writes :270-291; no `enforceRateLimit` anywhere in file).
5. `d6f0a9d3` — API error honesty (one cluster, four sub-sites): broker-backed GETs throw uncaught → generic 500 at `app/api/orders/route.ts:13`, `portfolio:13`, `positions:13`, `accounts:10`, `watchlist:20`, `orders/cancel:31`; malformed JSON → 500 at `orders/cancel/route.ts:20`, `policy/route.ts:46`, `keys/route.ts:337,431-432`; `/api/history` returns 200 + `bars:[]` + `note:"price history fetch failed"` on total failure at `history/route.ts:46-48`; envelope is three shapes (`{ok:false,error}` vs `{error}` vs plain text, e.g. `webhooks/congress/route.ts:28,94` vs `orders/route.ts:12` vs `policy:48,206`).
6. `cc0caa64` — checkBrokerHealth awaited inline, no tick-level deadline.  `src/lib/scheduler.ts:971`; `src/lib/broker-health.ts:38-39` (Promise.all getAccounts+getPortfolio) + `:97` (probeOrderCapability).
7. `51c52fd6` — /api/health public + unthrottled + per-request I/O.  `app/api/health/route.ts:310` (OpenRouter fetch ≤1.5s), `:357` (statfs), `:364-403` (litestream IPC + log scan); public via `middleware.ts:57`.
8. `68d11cc9` — retired-lane scripts shipped.  `scripts/runner-availability.sh:3,18-19,30-32,161-173` (Mac runner + pm2 `trading`), `scripts/infisical-prod-cutover.sh:97,273-275` (`pm2 delete`/`pm2 start npm`), `scripts/ops/fleet-watchdog.service` (ExecStart of deleted `fleet-site-watchdog.sh`), `scripts/land.sh:171-172` (pm2 preview hint), `scripts/fetch-prod-ops-snapshot.sh:4` ("set on trading-live").

Next batch (after the eight): `7db3350e` docs/ops-observability-security.md:132-138 (Mac PM2 litestream + "restore not exercised" — stale; B2 restore verified), `67558af0` quotes asOf (app/api/market/quotes/route.ts:45), P4 hygiene (reindex-10k 200-with-ok:false, SSE/strategy-run/notifications-test/mobile-auth-apple rate limits, EOD cache headers, ASCII sweep, EFFORT-LOG merged rows).

## 2. Fix approach per item

1. **99ab01c7**: Change the final block to `exit 1` when `nudge_ok=0` (the drain runs as a GitHub Actions job, so non-zero = job failure = Sentry alert — the AGENTS.md 40-43 map is container-only and does NOT apply here). Also fail at startup if neither a gh hook write path nor `COOLIFY_DEPLOY_WEBHOOK_URL` exists (`:127-134`), so a permanently unconfigured drain is loud, not green.  Do not attempt to make gh-redeliver work — GITHUB_TOKEN lacks `admin:repo_hooks` by design; keep it as best-effort.  Keep the RTH/`LATCH_RC`-guard logic unchanged (still exit 0 while inside RTH — that is a correct no-op, not a failure).  Effort S.
2. **8c9ce3b9**: Docs-only rewrite of the two lines: "Litestream → Backblaze B2 (live replica, `jays-socratic-trade-eu`); Cloudflare R2 holds only the weekly `cold-snapshots/` DR lane (retain=1)."  Cross-check against `docs/litestream.md:6-8` (already correct) and the FOOTGUN warning at `litestream.coolify.yml:16-24`.  Do NOT touch litestream config or any bucket.  Effort S.
3. **220c6cc6**: Make the stale verdict RTH-aware using the SAME source of truth as the latch (`isMarketOpen` from `src/lib/market-calendar.ts`, imported by `src/lib/rth-deploy-latch.ts:12`).  Extract a pure predicate (e.g. `shouldTreatStaleAsInFlight(now, oldestUndeployed)`) that returns true when the market is open AND the latched window applies, so the watchdog skips the page inside weekday RTH but still fires for genuine freeze (old sha outside RTH, or the 21:20 UTC drain never landing).  Never suppress the JSON flag entirely — only the page/alert path.  Effort M.
4. **3a8bcdcf**: Add `const limited = enforceRateLimit(userId, "proposals/from-draft", RATE_LIMITS.orders); if (limited) return limited;` right after `resolveRequestUserId` — use a DISTINCT key (`proposals/from-draft`, same 20/min window) so a draft burst can't consume the approve budget and vice-versa.  Mirror the existing pattern at `app/api/proposals/[id]/approve/route.ts:18`.  Effort S.
5. **d6f0a9d3**: One shared `jsonError(status, code, message)` helper (new, e.g. `src/lib/api-error.ts`) and migrate the plain-text/`{error}` sites; wrap the broker-backed GET bodies in try/catch → 502 `{ok:false, error}` with a bounded message (pattern already at `proposals/from-draft/route.ts:158-165`; use `safeErrorMessage` from `src/lib/telemetry-sanitize.ts`); add `.catch(() => ({}))`/SyntaxError→400 on the three JSON sites (pattern at `chat/route.ts:83`); make `/api/history` return 502 `{error}` on fetch failure, keeping 200 only for genuine no-data.  DO NOT change the shape of success payloads — iOS `MobileAPIClient.swift`/`MobileModels.swift` decode them (89249c60 is a separate, open item).  Effort S-M.
6. **cc0caa64**: Wrap the `checkBrokerHealth` await in `withDeadline(…, SCHEDULER_BROKER_TIMEOUT_MS, "checkBrokerHealth timeout")` WITHOUT a controller (it's a read but a timeout must not be treated as "unhealthy" → do NOT feed the auto-halt path a false signal; on timeout, skip this tick's gate with a journaled `broker-health-gate` row and let the existing per-call budgets/next tick recover).  Alternative if you prefer no deadline: run the gate fire-and-forget per account with a shared result cache.  Verify the pause/auto-halt behavior in `applyBrokerOrderPlacementPause` is unchanged.  Effort S.
7. **51c52fd6**: Add a global/IP rate limit at the TOP of `GET /api/health` (fail-open: limiter failure must never 503) or, simpler, key external monitors on `/api/live` and leave health unthrottled-but-cheap.  If adding a limiter, keep the response body byte-identical for the UptimeRobot keyword monitors (`schedulerStale`, `tradingLivenessDegraded`, `litestreamTiersDegraded`, `"openrouterCredits":{"ok":false`) and never change the 503 set (`pinecone` + `alpaca-broker` hard-stops only).  Effort S.
8. **68d11cc9**: Delete `runner-availability.sh` (fully dead; ci.yml:11-22 no longer routes to it) and `scripts/ops/fleet-watchdog.service` (points at deleted script); mark `infisical-prod-cutover.sh` ROLLBACK-ONLY/historical in the header rather than deleting (it is the archival cutover record; its secrets handling is verified safe); reword the `land.sh:171-172` hint and `fetch-prod-ops-snapshot.sh:4` comment.  Follow AGENTS.md: rollout note + no MAC-LOCAL-PROCESSES.md rows needed (none of these are registered there).  Effort S.

## 3. Tests that must fail first + verification

Tests to ADD (each must fail before the fix, pass after):
- 99ab01c7: shell-level test asserting `scripts/rth-deploy-drain.sh` exits non-zero when no gh hook and no `COOLIFY_DEPLOY_WEBHOOK_URL` exist and the live sha is behind (mock env: unset secret, `DEPLOY_VERIFY_NO_FETCH=1`, real `origin/main`).  Existing `test/rth-deploy-latch.test.ts` must stay green.
- 220c6cc6: unit test for the new in-flight predicate (market-open + latched → not stale; market-closed or drain-failed → stale).  `scripts/alert-deploy-freshness.selftest.sh` must pass.
- 3a8bcdcf: route test asserting 429 after N from-draft POSTs (mirror existing approvals rate-limit tests).
- d6f0a9d3: tests asserting 502 JSON on a throwing gateway (mock gateway), 400 on malformed JSON bodies, and 502 on `/api/history` total failure.  Re-check existing route tests that may assert today's 200/500 shapes (grep `test/` for `history-route`, `orders-route`, `policy-route`).
- cc0caa64: timing test with a stubbed slow gateway asserting the tick body returns within the deadline and the account is NOT auto-halted on timeout.
- 51c52fd6: health-route-exposure test (must stay green) + optional limiter test.
- 67558af0: assert the response field is no longer named/typed as quote-observation time (or renamed); `test/market-realtime.test.ts` stays green.
- 8c9ce3b9/68d11cc9/7db3350e: grep-based assertions (e.g. `grep -n "R2" docs/deployment.md` shows only cold-snapshot framing; no `pm2|trading-live` in the rewritten doc) — docs-only, no unit tests.

Verification per AGENTS.md (run all four before land): `npm run lint` (0 errors), `npx tsc --noEmit`, `npm test`, `npm run build`.  Scripts: `bash -n` each touched `.sh` + `LC_ALL=C grep -n '[^ -~]' scripts/*.sh` (must be empty — ASCII rule) + `bash scripts/alert-deploy-freshness.selftest.sh`.  Land via `bash scripts/land.sh`; update `docs/EFFORT-LOG.md` + a `docs/rollouts/YYYY-MM-DD-*.md` per protocol; `board claim <id>` before starting each item and mark the board when merged.

## 4. Pitfalls / related code to touch carefully

- **Exit-code contract**: AGENTS.md's 40/41/42/43/130/143 map is CONTAINER-only.  The drain fix's non-zero exit is a workflow-job failure — do not import the container map into it, and do not let the drain's exit 1 trigger a container restart anywhere.
- **checkBrokerHealth timeout ≠ unhealthy**: a timed-out health gate must NOT auto-halt an account (slow broker ≠ down; the per-call budgets already exist).  Keep `applyBrokerOrderPlacementPause` semantics untouched; only the gate's placement in the tick changes.
- **/api/health**: never move the never-503 degraded flags to 503 (restart-loop → boot interlock re-halts autonomy).  Keep the two-audience projection (operator-only USD/byte fields behind `authorizeOpsRequest`).
- **Placement/cancel/replace**: do NOT add AbortSignals to order placement/cancel/replace (structural invariant, `alpaca.ts:295-311`) — an aborted placement may still have reached the broker.
- **iOS consumers**: error-shape changes (d6f0a9d3) are read by `MobileAPIClient.swift`/`MobileModels.swift`; success payload shapes must not change.  If a 502 on `/api/history` would break the iOS chart, coordinate with the iOS lane (89249c60 is theirs).
- **FMP**: never reintroduce FMP as a market-data source (owner ruling 2026-08-20) — quotes/intraday must stay on Alpaca/Robinhood/Yahoo-delayed.
- **Docs edits** are excluded from `watch_paths` (docs-only commits don't deploy) — fine; but the deployment.md rewrite must stay consistent with `docs/litestream.md` and the rollouts it cites.
- **R2/B2**: this handoff is docs-only for backups — do NOT prune R2, do NOT touch litestream.coolify.yml, do NOT run litestream-restore scripts; the Mac-side R2-targeting restore scripts (P3, part of `68d11cc9`-adjacent scripts work) get comment/region updates only unless the owner approves an actual drill.

## 5. What to avoid (already-fixed / duplicates)

- **Do NOT re-file anything**: all ten items above are on the board (`99ab01c7`, `8c9ce3b9`, `220c6cc6`, `68d11cc9`, `7db3350e`, `3a8bcdcf`, `d6f0a9d3`, `cc0caa64`, `51c52fd6`, `67558af0`) — claim, don't file.  The desktop/iOS/mobile tracks' findings (cf62f87a, d9f81e44, 620ef423, …) belong to those lanes, not this one.
- **Do NOT re-fix already-fixed items**: scheduler lane duplicate-launch (28996d82 — fixed, guards released by real work, verified at scheduler.ts:917,947); console ships internals (5d9f6340 — fixed); approve misreport (d2094c78 — fixed); the #2949/#2953/#2886 broker-scope family (merged); admin gate (verified holding — all 26 routes gated, page tree at middleware.ts:460 — do not re-gate).
- **Do NOT re-open audit coverage**: the 2026-08-17 architecture-backend and brokers-data-cascade audits' findings (F1-F26, A/B/C/D sections) are already tracked; this review only deepens them (cc0caa64, 67558af0 note their parent ids in the report).
- **Do NOT touch**: `litestream.coolify.yml`, B2/R2 objects, `COOLIFY_*` tokens, Infisical keys, the container start chain (`coolify-prod-start.sh` is verified correct — leave it), the scheduler's boot autonomy interlock, or `exit-guard.ts`.
- **Do NOT run anything against production**: no Coolify API calls, no `curl` to prod with write intent, no script execution that touches the live box; the drain/freshness changes are verified locally + by CI only.

Reports the implementer should open alongside this: docs/audits/2026-08-20-deepseek-backend-ops-docs.md (full detail), docs/audits/2026-08-20-deepseek-api-routes.md (envelope/rate-limit/cache detail), docs/audits/2026-08-20-deepseek-scripts.md (drain/watchdog/ASCII detail), docs/audits/2026-08-20-deepseek-docs.md (doc-accuracy detail incl. EFFORT-LOG stale rows and restore-drill version skew).
