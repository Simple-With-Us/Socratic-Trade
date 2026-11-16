# 2026-07-08 — Multi-issue troubleshoot sweep (MONET)

> **Addendum (post-merge, same day):** PR #1087 merged 10:35Z via auto-merge.
> Production deployed via Coolify (deployment `n1v296af3quh3ri4mo56nxv5`,
> commit `ea779bbf` = main incl. this sweep + the day's sibling PRs) — health
> verified after: ok/db ok/scheduler ticking; finnhub dependency back to
> ok:true with the rate limiter live; alpha-vantage still red (daily quota
> already burned — expected), congress SSE still red (owner env decision
> pending). Two follow-ups handled: (1) the PR's `gitleaks` red was a FALSE
> POSITIVE on the deliberately-fake `sk_live_abc123` scrubber-test fixture —
> fixture changed to a non-key-shaped string in the follow-up PR;
> (2) **`.github/workflows/deploy.yml` DISABLED via `gh workflow disable`**
> (file kept for deliberate rollback use): it auto-ran on every main push on
> the Mac self-hosted runner ending in `pm2 restart trading` — it was the
> source of the "accidentally re-started twice" incidents in the 2026-07-08
> previews-retired note, and if the rollback pm2 lane were ever started it
> would put the Mac scheduler back into production against the same broker
> accounts Coolify trades on the very next merge.

Owner reported 10 issues in one batch; a 22-agent investigation workflow (one
investigator per issue + adversarial verifier per finding + prod-diagnostics
scout + completeness critic) diagnosed all of them, then 6 implementation lanes
fixed the code-fixable subset. Branch: `monet/multi-issue-troubleshooting-5b55ad`.

## Summary of diagnoses (all adversarially verified)

1. **Market scan mostly blank** — every enrichment provider is failing at once,
   NOT a missing-key problem (keys confirmed present in the Coolify runtime).
   Two stacked causes: (a) pre-existing quota exhaustion — finnhub/tiingo/
   twelvedata HTTP-429, alpha-vantage 25-req/DAY free cap burned; (b) since the
   Hetzner cutover, Yahoo aggressively rate-limits the box's egress IP.
   **Container diagnostic (decisive, run 2026-07-08 via docker exec):** IPv6 is
   fine (curl -6 gets HTTP 429, i.e. connects), single cold curl gets 429 on
   both stacks, but a paced node fetch returned 200 → Yahoo throttles bursts
   from this IP; pacing fixes it, no proxy needed. The IPv6-blackhole theory
   from `docs/rollouts/2026-07-06-api-health-timeouts.md` is refuted for this
   case (`dns.setDefaultResultOrder("ipv4first")` already in next.config.mjs).
2. **Framework-improvements card click-through loses context** — the card's
   header link is hardcoded to `/console/strategy`, which never renders the
   thesis/regime scorecard data shown in the card's fallback state; that data
   lives on `/console/results` ("By thesis" / "By market regime at entry").
3. **Outcomes "compare to paper/broker" is fake** — the toggle swaps between
   the ONE active account's own paper*/live* buckets (the opposite bucket is
   structurally always empty); it never references any other account.
4. **LLM usage all unattributed/alpaca-paper** — not a data bug: PR #1030
   (2026-07-07) added per-account attribution for 4 call sites but deliberately
   deferred the two highest-volume ones (strategy/strategy-bear + red-team,
   ~71% of all rows) due to a CLAUDE-Cowork keepout. 100% of the 553 historical
   prod rows are NULL-attributed. Fix = thread `connectedAccountId` at the
   deferred sites; no backfill (per #1030's own policy).
5. **Font selection** — the feature HALF-merged: PR #1007 (2026-07-08) landed
   `app/console/lib/useConsoleFont.ts` (4 options, localStorage) as 100% dead
   code — zero imports, no Settings UI, no CSS. Only the narrower "Text Box
   Font" (PR #350) works. Fix = wire it (Settings picker + shell attribute + CSS).
6. **Finnhub over-calling — owner is right.** 5 endpoints/symbol × 5 symbols
   in parallel = 25-wide bursts; real prod windows of 82–99 calls in a single
   second vs the 60/min free tier. Only reactive guards existed (single 429
   retry + circuit breaker after 5 consecutive failures). Fix = proactive
   per-provider rate limiter.
7. **Congress.Trade "no subscription configured"** — env-config gap, nothing
   broken: `CONGRESS_STREAM_ENABLED` is on in Infisical prod but none of
   `CONGRESS_STREAM_SUBSCRIPTION_ID`/`_TOKEN`/`CONGRESS_STREAM_AUTO_SUBSCRIBE`
   exist there, so the SSE consumer retries ~1/min forever. Owner decision:
   auto-subscribe / manual subscription / turn the stream off.
8. **Alpha Vantage "1 req/sec"** — literal free-tier burst message (6,706
   occurrences in prod health log) caused by the shared `CONCURRENCY = 5`
   burst pattern; the now-dominant failure is the 25-req/DAY cap (hard business
   limit — pacing can't fix that; drop/demote the provider or pay).
   **Security find:** Alpha Vantage error text embeds the raw API key and was
   stored/surfaced verbatim (api_health_log → connections health/ops snapshot).
   Scrubbed in code now; recommend rotating that key.
9. **MU stuck exit — resolved itself + 3 real bugs found.** The blocking $991
   LIMIT (order `88f6af66…`, placed 07-06 after close) EXPIRED at 07-07 close.
   The synthetic trailing stop then fired at 00:14Z 07-08 (flat 5% remnant in
   `account_strategy_state.riskRules.trailingStopPct` — owner's suspicion
   confirmed; #1036 fixed per-trade bracket stops, not this per-account trail)
   and placed an after-hours MARKET sell (order `4eed5be7…`) that rested
   overnight → the extra slide to −12% accrued while resting. It should fill at
   the 07-08 open. Bugs fixed this sweep: (a) paper exits booked "filled" at
   the quote when the order was actually resting (P&L misbooked at $938.29);
   (b) the stop monitor re-armed the triggered stop every 60s all night (~280
   Alpaca 422 dup-client-order-id errors — only the deterministic refId
   prevented a real double sell); (c) a resting non-stop exit order didn't
   count as "already protected".
10. **Order labels** — the ~25-char strings are broker UUIDs; no persisted
    orders table exists, so a stateless 8-char short label (`88F6AF66`) at the
    two prose-builder leak points fixes every downstream surface.

Bonus findings (completeness critic + prod scout):
- **"10-K never ingested" receipt is real and permanent at current pace**: SEC
  filing ingestion is capped to ~1 filing/week by the free-tier heuristic
  (`VECTOR_EMBED_BATCH_DELAY_MS > 5000` ⇒ 1 filing/tick, weekly TTL) against a
  515-symbol × 2-doc-type universe; only 2 filings (both 10-Qs) ever ingested.
  Voyage key is paid-tier per health → lower `VECTOR_EMBED_BATCH_DELAY_MS` to
  ≤5000 in Infisical prod to unlock the paid-tier per-run cap.
- **"Same-day evidence" receipt**: working as designed, telemetry-only, no action.
- **Litestream post-cutover**: process confirmed RUNNING in-container (docker
  exec, PID 47) — backups continue; `/api/health` just doesn't report its state
  on the Coolify path (litestreamState "unknown") — reporting gap only.
- **No version/commit in /api/health or ops snapshot** — deploy visibility gap.
- Roth IRA (only isActive live account) strategy runs failing with Gemini 400
  INVALID_ARGUMENT on the Green call as of 08:00Z 2026-07-08 — separate issue,
  surfaced to owner.

## What was implemented (this branch)

Six implementation lanes + a 2-lens adversarial diff review (money-path Fable +
regressions Sonnet) + a fix round for the review's 3 real findings:

1. **Framework card link** (`app/console/page.tsx`): action link is now
   state-dependent — `/console/strategy` ("Framework") only when framework
   proposals are actually rendered; `/console/results#thesis-regime` ("Results")
   for the thesis/regime scorecard fallback. `id="thesis-regime"` +
   `scroll-mt-28` anchor added on the Results scorecards grid.
2. **Real account comparison on Results** (`app/console/results/page.tsx`,
   new `app/api/connected-accounts/[id]/performance/route.ts`,
   `app/console/lib/api.ts`): the fake paper/broker toggle is replaced by a
   picker of the user's OTHER connected accounts; the new route is user-scoped
   (`getConnectedAccount(id, userId)`, 404 cross-user, accountNumber resolved
   server-side only) and returns `pricesUnavailable: true` — the UI renders
   "—" for unrealized P&L instead of a fabricated $0 (route never fetches live
   quotes; realized/win-rate/equity-curve fields are real).
3. **LLM usage attribution** (`src/lib/strategy.ts` 'strategy' + 'strategy-bear',
   `src/lib/red-team.ts` both transports, `src/lib/rag/multi-query.ts`
   'rag-hyde'): `connectedAccountId` threaded exactly like PR #1030's four
   sites; completes that PR's deliberately-deferred half. No backfill.
4. **Site-wide font selection wired** (`app/console/settings/page.tsx`,
   `shell.tsx`, `console.css`): the dead `useConsoleFont` hook from PR #1007 now
   has a "Console Font" picker (shared `FontOptionGrid` with the Text Box Font
   picker), a `data-console-font` attribute on the console root, and a
   `--con-body-font` CSS variable ("site" = no attribute = unchanged default).
5. **Per-provider rate limiting + secret hygiene** (new
   `src/lib/provider-rate-limit.ts`, `src/lib/data-providers.ts`): token/interval
   pacer gating actual dispatch — finnhub ~50/min, alpha-vantage serial ≥1.1s,
   yahoo ~400ms spacing ×2 concurrency — env-tunable
   (`PROVIDER_RATE_LIMIT_<NAME>_*`, `PROVIDER_RATE_LIMIT_DISABLED` kill switch);
   AbortController timers arm at DISPATCH time (review fix — queue wait no
   longer consumes the HTTP timeout); API keys scrubbed from health/error text
   (fixes the Alpha Vantage key leak into api_health_log); `err.cause` appended
   to fetch-failure logs; Yahoo cookie/crumb handshake retries once instead of
   blanking the whole batch.
6. **Synthetic stops money-path hardening** (`src/lib/synthetic-stops.ts`,
   `src/lib/db-api-keys.ts`, `src/lib/db.ts` migration): (a) resting (not
   sync-filled) protective exits book `pending_reconciliation` and are finalized
   by the existing `reconcilePendingFills` path — no more filled-at-quote
   misbooking; (b) triggered stops cannot be resurrected (upsert CASE guard) and
   re-arm ONLY on positive confirmation the prior order is dead (order list
   fetched, prior `client_order_id` not live, no pending fill, 15-min grace on
   the re-arm pass); (c) per-row `fire_generation` + `last_attempt_ref_id`
   columns give a legitimately re-armed stop a fresh `-g<n>` client_order_id
   (first fire keeps today's exact format) while ambiguous states reuse the
   recorded id VERBATIM so the 422 collision guard can never be dropped;
   (d) quantity-aware protection: partial resting exits fire the uncovered
   remainder, full-size/unknown-qty resting exits skip with an audit receipt.
7. **Short order labels** (new `src/lib/order-labels.ts`,
   `broker-held-orders.ts`, `stale-limit-orders.ts`,
   `replace-market-sheet.tsx`): user-facing prose now shows `88F6AF66`-style
   8-char labels; full broker ids untouched in structured fields/audit/actions.

## Prod actions required (owner / release step)

1. **Deploy**: merge this PR then trigger a Coolify deploy of
   `socratic-trade-prod` (auto-deploy OFF — merged-but-undeployed fixes were a
   theme in this sweep: #993's congress noise fix and #1030's attribution were
   merged but the container predates them... verify deploy includes everything).
2. **MU**: after the 13:30 UTC open, confirm Alpaca paper order `4eed5be7…`
   filled and MU is closed; if not, market-sell manually (auto-remediation only
   replaces stale LIMIT orders). Note MU realized P&L is misbooked at $938.29
   vs the true open fill. Optionally clear `trailingStopPct=5` on the Alpaca
   Paper account if no flat-% trail is wanted (code default is 0).
3. **Congress stream** (owner decision): add `CONGRESS_STREAM_AUTO_SUBSCRIBE=on`
   (simplest) or a manual `CONGRESS_STREAM_SUBSCRIPTION_ID`+`_TOKEN` pair to
   Infisical prod — or set `CONGRESS_STREAM_ENABLED=off` if not wanted — then
   redeploy.
4. **10-K ingestion**: lower `VECTOR_EMBED_BATCH_DELAY_MS` to ≤5000 in Infisical
   prod (Voyage is paid-tier) so filings ingestion runs at paid pace.
5. **Alpha Vantage**: rotate the API key (it leaked into health-log rows) and
   decide paid-tier vs drop (25/day cap makes it near-useless as configured).
   Optionally set `FINNHUB_DROP_RECOMMENDATION=1` for an immediate 20% finnhub
   call reduction.

## Verification

Full gate run on the branch (2026-07-08):

```bash
npm run lint       # 0 errors (337 grandfathered warnings)
npx tsc --noEmit   # clean
npm test           # 2946 tests / 290 files, all passed
npm run build      # success
```

Plus per-lane targeted runs during implementation: synthetic-stops 22/22 (17
prior + 5 new), provider-rate-limit 25 (new file), data-providers 83,
connected-account-performance-route 5, order-labels (new), red-team attribution
tests (new). Adversarial review (Fable money-path lens + Sonnet regression
lens) found 3 real defects in the first implementation pass — abort-timer
armed before the pacer queue, oldest-500 fill-window generation counter, fake
$0 unrealized P&L — all fixed and regression-tested before landing.

Container diagnostics run against prod (read-only, via SSH + docker exec):
Yahoo curl -4/-6 both reach (HTTP 429 = rate-limited not blocked; node fetch
200), IPv6 functional, litestream process running since 08:27.

## Files

- `app/console/page.tsx`, `app/console/results/page.tsx`,
  `app/console/lib/api.ts`, `app/api/connected-accounts/[id]/performance/route.ts` (new)
- `src/lib/strategy.ts`, `src/lib/red-team.ts`, `src/lib/rag/multi-query.ts`
- `app/console/settings/page.tsx`, `app/console/components/shell.tsx`,
  `app/console/console.css`
- `src/lib/provider-rate-limit.ts` (new), `src/lib/data-providers.ts`
- `src/lib/synthetic-stops.ts`, `src/lib/db-api-keys.ts`, `src/lib/db.ts` (migration)
- `src/lib/order-labels.ts` (new), `src/lib/broker-held-orders.ts`,
  `src/lib/stale-limit-orders.ts`, `app/console/orders/replace-market-sheet.tsx`
- Tests: `test/synthetic-stops.test.ts`, `test/provider-rate-limit.test.ts` (new),
  `test/data-providers.test.ts`, `test/connected-account-performance-route.test.ts` (new),
  `test/order-labels.test.ts` (new), `test/red-team.test.ts`
- Docs: `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Follow-ups

- Prod actions section above (deploy, MU fill check, congress env decision,
  VECTOR_EMBED_BATCH_DELAY_MS, Alpha Vantage key rotation + tier decision).
- Roth IRA Gemini 400 INVALID_ARGUMENT on Green calls (only isActive live
  account failing) — separate investigation.
- `/api/health` litestream state reporting on the Coolify path (process runs;
  health says "unknown").
- No version/commit in /api/health — deploy visibility gap.
- Alpha Vantage 25-req/day cap is a hard ceiling — pacing fixes bursts only;
  drop/demote or pay decision pending.
- Full-size far-from-market GTC exits still (correctly) block synthetic stops —
  the stale-limit-order notifier is the surface that flags them.
