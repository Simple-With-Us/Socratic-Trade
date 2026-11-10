<!-- Produced by the 2026-07-09/10 owner-directed activity-feed audit (MONET, intro-anim session):
     36-agent workflow over the production DB + repo — 5 domain investigators, adversarial
     verification of every finding, ranked synthesis. Fix backlog tracked on the effort board. -->

# Production Activity-Feed Audit — socratictrade.com (2026-07-07 → 07-09)

> **Landing-status addendum (2026-07-10, added when this report merged):** this is a
> point-in-time audit; several of its action items completed before it landed. Already done:
> the congress.trade CF whitelist for the new box IP (same evening as the migration — the
> §1.4 storm's config half); **bump-to-floor merged as PR #1297** (the §1 P3 "AAPL trim
> deadlock" item — including the dollar-sell→quantity conversion this report asked for); the
> "merged-not-deployed" PRs listed in §2 shipped in the 06:00Z/06:20Z 07-10 releases
> (prod = main@420c6747 at landing). Claimed owner-directed at landing: the three P1s +
> post-mortem attribution (one lane) and the §1.10 attribution sweep (a second lane).
> Corrections: the filings-TTL knob is `SEC_FILING_INGEST_TTL_HOURS` (not
> `FILING_INGEST_TTL_MS`), and the §1 P3 storage-warning fix must also add
> `storage_warning` to the direct-notify skip set so `sendNotification()` doesn't
> double-write the in-app row.

**TLDR:** The feed's worst recent incidents — the MU 422 stop storm (800 rows), the held-bracket-leg remediation that destroyed UNH/T exits, the em-dash push-drop bug, and the Roth Gemini 400 streak — are all root-caused, fixed, and verified live in the deployed image (#1087, #1167, #1190). No money-path defect placed a wrong order in the window. What remains is an honesty/observability problem, plus three P1s that degrade the system quietly: the Roth IRA's proposer truncated to **zero proposals on 6 of 10 completed runs** on 07-09; the learning loop reads thesis-tag columns that are **0/714 populated** and feeds the LLM false "attribution is unusable" directives; and the reflection dedupe key ping-pongs across accounts, wasting ~21 LLM calls/day and injecting test/paper-account reflections into the **live** account's prompt. Two noisy loops are active right now (congress-share retry storm — currently unbounded because the new box's IP isn't whitelisted — and pervasive NULL-account audit rows producing hourly "Account: unknown" cards), and the feed claims every notification was "Not sent" while 378 actually delivered.

---

## 1. Needs fixing now

### P1

**1. Roth IRA (live) proposer truncates at token cap → zero proposals most runs — P1, effort S**
- **Feed:** Roth runs read "Evaluated 0 proposal(s)… proposed 0 Trades" like normal quiet runs; the only tell is `strategy_bull_truncated` (15 rows all-time, every payload `{cap:1500, parsedProposals:0, provider:gemini}`; 6 on 07-09 after the #1190 fix went live).
- **Root cause:** `LLM_OUTPUT_TOKEN_CAPS.strategyProposal` = 1500 (`src/lib/llm-request.ts:443-444`); even with the +4000 Gemini reasoning headroom, gemini-3.5-flash exhausts the 5500 wire cap and the parse path degrades truncated JSON to zero proposals (`src/lib/strategy.ts:~4581-4592`, audit at `:4631`).
- **Fix:** Raise `strategyProposal` to 4000+ (that cap only, not the shared default) and/or clamp Gemini thinking effort for this step; log actual wire cap + finish_reason in the audit payload (it currently logs the misleading 1500 constant). Verify with a Roth run producing >0 proposals. Also pass `input.policy.connectedAccountId` as the audit's 4th arg (one line, sibling audits already do).

**2. Thesis-tag split-brain: `trade_proposals.trade_thesis_tag`/`entry_market_regime` never populated — P1, effort S**
- **Feed/loop:** Post-mortem tells the LLM all 50 recent trades have `thesisTag:null` while the same prompt shows per-thesis scorecards ("-3.12% Momentum-Breakout"); prod summaries repeatedly issue false directives ("require explicit tags before trading") fed back into the Bull prompt. Columns 0/714 populated all-time; the tags exist in proposal JSON (543/714; 102/102 last 3d).
- **Root cause:** `src/lib/db-proposals.ts:357-378` binds `input.tradeThesisTag ?? null` and all 11 `insertProposal` call sites in `strategy.ts` omit it; `src/lib/post-mortem.ts:39-40` reads the always-NULL columns.
- **Fix:** Default the columns from the proposal object in `insertProposal`; `COALESCE(col, json_extract(proposal,'$.tradeThesisTag'))` in the post-mortem SELECT **and** in `getProposal` (`db-proposals.ts:142`) / `getProposalsByIds` (`:192`); optional migration backfill (recovers 543 rows). Money path is not corrupted — the EV gate and scorecards read fill JSON.

**3. Reflection signature/summary keyed per-user, 4 accounts run hourly — P1, effort S**
- **Feed:** ~64 `post_mortem_reflection` audits in 3d (~21/day), near-identical texts regenerating hourly (Roth's 8-fills-since-07-01 reflection regenerated ~20x/day) — every one a paid LLM call.
- **Root cause:** `src/lib/post-mortem.ts:55-57` — signature computed from one account's fills but stored under `reflection_signature:${userId}`; three accounts clobber the shared key so the dedupe never holds. Worse: `:161` writes ONE shared `reflection_summary` read into **every** account's Bull prompt — the live Robinhood account (zero fills of its own) only ever receives another account's (incl. test/paper) reflection. Cross-account contamination of a live decision input.
- **Fix:** Scope both keys by account (`…:${userId}:${accountNumber}`, legacy-key fallback at the `strategy.ts` read, line 4071 current tree); pass the account into the audit call while there.

### P2

**4. congress_share_daily retry storm — active and now unbounded — P2, effort S (config) + S (code)**
- **Feed:** 386 `congress_share_daily` audits in 3d (ok=18, notOk=368), overlapping full 515-ticker batches launched every 60s tick; as of 07-10 every POST fails 32/32 with HTTP 403 because the congress.trade Cloudflare zone still whitelists only the **old** box 91.98.44.8 — the marker never advances, so the storm runs continuously.
- **Root cause:** `src/lib/scheduler.ts:30` (TICK_MS=60s) + fire-and-forget at `:313`; `src/lib/congress-share.ts:588-590` (due = marker ≠ today) and `:791-800` (marker advances only on zero failed posts); no in-flight guard, no backoff.
- **Fix:** Immediately: whitelist <HETZNER_OLD_IP_RETIRED> on the CF zone (documented un-done follow-up, `docs/rollouts/2026-07-09-hetzner-8gb-server-migration.md:84-101`) — that alone stops today's storm. Durable: module-level in-flight promise + persisted last-attempt timestamp with 30-60 min failure backoff. (Note: this cannot be causing the twelvedata 429s — different provider cascade.)

**5. Feed says every notification was "Not sent" while delivery succeeds — P2, effort S/M**
- **Feed:** 213/213 `notification_events` in 3d (1035/1035 all-time) show status "Not sent — Notifications Webhook Not Configured," while 378 notifications actually delivered via push/email/SMS. Real failures (the 07-08 push drops) were indistinguishable.
- **Root cause:** `src/lib/notifications.ts:59` discards `sendDirectNotification`'s per-channel results (returns void, `:97-131`); `:61-63` records "skipped" purely because the legacy webhook URL is empty; `dashboard-ui.ts:335`/`:412-414` render it verbatim.
- **Fix:** Return the `NotifyChannelResult[]`, derive status: `sent` if any channel delivered, `failed` with joined errors (also when `notify()` throws), neutral `skipped` only when no channels enabled; update the reason mapping. No schema change. Keep the operator-fallback email lane in `db-health.ts:~485-493` intact — it's intentional.

**6. `order_placement_uncertain` misclassifies definitive rejections — P2, effort M**
- **Feed:** All 13 in-window events (48/48 all-time) were definitive failures — RH sub-$1 400s, an Alpaca 403 short-conflict, and a **locally-thrown** bracket-size error (`src/lib/alpaca.ts:482`, no HTTP ever sent) — each raising a "verify with broker" alarm on live accounts. The kind has never once flagged genuine uncertainty; a real lost-response will be buried.
- **Root cause:** `strategy.ts` placement catch (~2153-2168 and ~3873 current main) treats every throw as uncertain.
- **Fix:** Typed `OrderValidationError` for pre-flight throws → blocked/rejected; parsed broker 4xx → the existing `rejected_by_broker` lane; reserve uncertain for timeouts/5xx/undecodable responses. Pass `connectedAccountId` into these audits. Consider adding Alpaca's whole-share-bracket constraint to pre-flight sizing so the Roth $4 BAC case stops throwing at all.

**7. Stale-exit "cancel still pending" abort leaves exits canceled-but-never-replaced — P2, effort M**
- **Feed:** UNH 07-09: `order_replace_market_aborted` + `stale_exit_auto_remediation_failed` at 13:31:54 for order 91c8b93e; the message promises a follow-up no code performs — the take-profit leg was canceled and no replacement ever placed. One occurrence in 30 days, on paper, but the same path runs live.
- **Root cause:** `src/lib/order-replacement.ts` — 750ms settle (`:11`), throw at `:226` with the cancel request standing; the order goes terminal, leaves `listStaleLimitOrders`, cooldown set before the attempt (`:430`) and never cleared; no path places the replacement.
- **Fix:** Persist a `replacement_pending_cancel` record and complete it on later ticks once the cancel settles (re-check `filledQuantity`; honor live-confirmation deferral); interim: poll ~10s instead of one 750ms wait. Also measure staleness from bracket-leg **activation**, not `createdAt` — remediation fired 16 seconds after the leg went active, which caused this instance.

**8. Synthetic-stop retry loop: no failure dedup/backoff for persistent declines — P2, effort S/M**
- **Feed:** The 800-row/13h MU storm pattern (plus a 14-row AAPL burst 06-26) can recur for any persistent broker decline (403, wash-trade block) or persistent `getEquityOrders` failure — one error row per minute, unbounded, and a failing protective exit currently surfaces **only** as audit rows.
- **Root cause:** `src/lib/synthetic-stops.ts` catch (~:505-513) reverts and retries every 60s tick with a fresh client_order_id; per-tick `synthetic_stop_error`/`synthetic_stop_blocked` emission with no fingerprint dedup. (#1087 fixed only the resting-exit re-fire case.)
- **Fix:** Per-(stopId, error-fingerprint) emission cooldown + periodic summary row, and — most important — a single persistent "protective exit failing for SYMBOL since T" alert. Keep the 60s retry cadence; do **not** cap/reset `fire_generation` (monotonic growth is what prevents 422 collisions).

**9. LLM failover built but unwired; all accounts fire at the same minute — P2, effort S/M (seeding = owner call, see §4)**
- **Feed:** 26 whole-run "rate limit or out of quota" failures across 3 accounts in 3d (33 counting network/5xx transients); `strategy_llm_failover` has fired **0 times ever** — `llmFallbackModels` unset on every account, and the Green/Bull path has **no in-request retry at all** (the 2-attempt retry covers only the Red Team reviewer, `red-team.ts:273`). Three accounts start at :00-:03 each hour (MAX_CONCURRENCY=3, `scheduler.ts:492`), bursting the shared OpenAI key.
- **Fix now:** cadence jitter/stagger (Roth's 61-min cadence is the template) + 429-specific backoff on the Bull path. Expose `llmFallbackModels` in the model-picker UI with suggested defaults — silently seeding it changes which model trades a live account, so that variant is an owner ruling.

**10. Account-attribution sweep: ~55 `audit()` sites drop the in-scope account — P2 (owner-reported symptom), effort M total, mechanical**
- **Feed:** Hourly "Account: unknown — may concern any of your accounts" cards (owner-reported), and every untagged event renders in **all 5** account scopes (`app/console/activity/page.tsx:171`, footer at `:242-248`). In-window NULLs: `post_mortem_reflection` 64/64 (216 all-time, no runId to rescue), `fill_reconciled` 49/49, `order_placement_uncertain` 13/13, `llm_call_latency` 172 (low priority — its only consumer doesn't filter by account), `strategy_bull_truncated` 12/12, `order_blocked_live_preflight` 7/7, `synthetic_stop_error` 800/800.
- **Root cause & fix:**
  - `src/lib/post-mortem.ts:163` — pass `policy.connectedAccountId` (in scope at `:153`); also silence the twin `policy_change` card from the `reflection_summary` write via a no-audit flag on `setUserSetting` (don't relocate the setting — 4+ files read it). Historical 216 rows stay "unknown" until they age out; no backfill needed.
  - `src/lib/strategy.ts` — 42 sites (scope map verified: `runStrategyOnce` local `connectedAccountId` at `:311`; `executeProposal`/`proposeTrades` via `policy`; `autoRevertOnCapBreach` already has the param at `:3425`); thread `connectedAccountId` into `recordLlmOutcome`'s ctx and the `reconcilePendingFills`/`flagStalePlacingIntents` signatures (they get `accountNumber` — keep the UUID vs broker-number distinct). ~30 sibling audits already pass it correctly. Re-grep by kind before editing; lines are per origin/main@a8b0185b.
  - `src/lib/synthetic-stops.ts` — all 12 sites, `policy.connectedAccountId` is a function parameter; forward-looking only.

### P3 (batch these)

- **Feed storm resilience:** coalesce consecutive identical (kind, symbol, error-fingerprint) audit events into one counted card in `buildUnifiedFeed` (`dashboard-feed.ts:883` currently makes one card per event) — defense-in-depth now that the MU emitter is fixed. Never route error kinds into the System bucket. Effort S/M.
- **AAPL trim cap-vs-floor deadlock (Robinhood live):** 8 `order_skipped_broker_minimum` skips on 07-09 alone. Not unsellable dust — the ~$1.09 position (~23% of $4.64 NAV) is trimmed to $0.21-0.22 by `maxOrderNotional` clamping, under RH's $1 floor, forever. The bump-to-floor lane is **unmerged** (in adversarial review on `monet/broker-min-bump-3676f7`) and its sell branch declines dollar-based exits (`broker-minimum-guard.ts:166-168`) — extend it to convert dollar sells to quantity (capped at held quantity) or the loop survives the merge. Effort M.
- **`policy_change` attribution (80/80 NULL):** thread `account?.id` through the one existing `setUserSetting` audit from `setPolicy` (`db-profiles.ts:426`); include `setStrategyPrompt` (`:459`); do NOT add a second audit on `writeAccountStrategyState` (double-carding). Residue after the post-mortem fix is only 14+2 rows/3d, but #1223 autosave (merged, undeployed) will multiply writes. Effort S.
- **`broker-protective-stops.ts` attribution (8 sites, latent — zero rows in window, flag default OFF):** append `policy.connectedAccountId` at the 7 in-scope sites, thread it into `cancelBrokerProtectiveStop` (:63; one prod caller), plus the 9th same-family site `synthetic-stops.ts:258`. Effort S.
- **10 `fill_events` stuck pending forever with `broker_order_id` = literal `'undefined'`** (06-29/30 RH dust buys): insertion root cause already fixed (PR #284 guard, `robinhood.ts:425-434`, zero new rows since). Needed: one-time audited flip to a terminal `unreconcilable` status — they currently force a no-op broker call every run and clutter the feed. They are NOT in P&L (excluded by `isAccountingFill`). Effort S.
- **Storage warnings mislabeled `provider_degraded`:** fix `db-health.ts:559/:561` AND `:573/:576` (the sendNotification path writes the mislabeled in-app row); add `storage_warning` to `NOTIFICATION_EVENT_TYPES` in `types.ts` (tsc will force the label). Effort S.
- **"Account: unknown" footer on genuinely global kinds** (`connection_health_alert` 45/45, `storage_warning_alert`, `market_scan_failed`, `regime_flip`, etc.): add a KNOWN_GLOBAL set in `dashboard-feed.ts` that suppresses the footer (render "System-wide") — do NOT add them to OPS_AUDIT_KINDS, which would bury alert kinds in the low-visibility System bucket. Effort S.
- **`evidence_age_anomaly` echo:** 120 rows / 214 flagged items over only **10 distinct evidence ids**; the two `track_record` facts re-flag 60x each because re-assertion refreshes `assertedAt` (they never age out). Emit on first sight per (fact id, assertedAt); in-memory LRU is fine. Effort S.

---

## 2. Already fixed, awaiting confirmation/deploy

**Fixed, deployed, verified (close these threads):**
- **MU 422 synthetic-stop storm** — #1087 (5d437b61) in deployed 8bc0967f; zero rows after 07-08T13:30:32Z. (The exact stop time also coincides with market open executing the resting sell; the fix is verified in code regardless.)
- **Held-bracket-leg remediation destruction (UNH/T oversized sells)** — #1167 held-state skip + position-backed guard (`order-replacement.ts:404, :136-157, :184-212`); zero recurrence, post-fix replacements correct (PYPL 07-09).
- **Em-dash push ByteString failure** — 25 dropped pushes all-time (not 53), 11 on 07-08; `sanitizeNtfyTitleHeader` (#1167) verified working: zero `notify.error` on 07-09 despite 49 pushes including two previously-throwing message shapes.
- **RH sub-$1 "placement uncertain" storm source** — #1167 preflight skip + 24h cooldown; AAPL uncertain events stopped at 07-08T23:12Z (residual = the deadlock item and Alpaca bracket case above).
- **Stale-run-sweep false positive** — 30-min threshold + audit-activity grace in deployed image; zero `strategy_run_crashed` since 07-08T23:14.
- **Roth Gemini 400 (#1190)** — 18-run failure streak stopped exactly at the ~13:3xZ 07-09 deploy. Bookkeeping: the actual serving image is **83e80953**, not 8bc0967f — record the exact deployed commit at deploy time; stale labels nearly broke already-fixed classification twice in this audit.

**Merged, NOT deployed — watch the next ANNOUNCE-THEN-DEPLOY:**
- Console-hang fix, #1221-#1224 (incl. #1223 settings autosave — which will **multiply unattributed `policy_change` cards** until the attribution fix lands; sequence accordingly).

**Unmerged, in flight:**
- Bump-to-floor lane (`monet/broker-min-bump-3676f7`, adversarial review). Watch: verify the dollar-based-sell extension before calling the AAPL loop closed.

---

## 3. Owner decisions

1. **test-local's armed autonomy** — the `broker='test'` account runs full hourly gpt-5.5/high runs (16/day, all three days; 53 calls / $4.57; re-armed on every deploy via `auto_resume_on_boot`), contends for the shared OpenAI key (same-minute 429s degraded the LIVE account on 07-07), and its spend counts against the monthly LLM ceiling whose breach halts LLM work for live accounts. **Recommendation:** halt it (or, if it's a deliberate model canary from the benchmark work, downgrade to a cheap model and accept the ceiling exposure knowingly). Code option: explicit opt-in for scheduling `broker==='test'` accounts — opt-in, not a hard block.
2. **RAG 10-K corpus (spend/pace ruling)** — 187/187 runs flag `emptyDocTypes:['10-k']`; the entire ingest corpus is **1 filing all-time** (one MSFT 10-Q) because prod env leaves `VECTOR_EMBED_BATCH_DELAY_MS` at the 21000 default → free-tier cap of 1 filing/week against 515 symbols. Your Voyage key is already paid-tier per the 07-08 health check. **Recommendation:** set `VECTOR_EMBED_BATCH_DELAY_MS≤5000` + `SEC_FILING_RAG_MAX_PER_RUN=10-20` in Infisical (already a known un-actioned ops item), AND shorten `SEC_FILING_INGEST_TTL_HOURS` or run the one-time supervised 10-K backfill — the env change alone still yields only ~10-20 filings/week.
3. **Seeding `llmFallbackModels` defaults** — default-OFF is documented as deliberate (`types.ts:794-799`) and seeding changes which model trades a live account. **Recommendation:** expose it in the model-picker UI with suggested defaults rather than silent seeding; ship cadence jitter regardless (no ruling needed).
4. **Account-attributing `learned_context` facts** — the store is user-level knowledge, but post-mortem-derived facts originate from one account's trades. **Recommendation:** leave user-level; revisit only if you want per-account learning isolation.

---

## 4. Not issues

- **"Not sent" chips ≠ delivery failure:** 378 notifications delivered in 3d (push/email/SMS); the chips are the recorder bug (§1.5), not a gap.
- **Emails arriving after you dropped email at 07-09 18:58Z:** the forced operator-fallback lane for global provider-health alerts (`db-health.ts:~485-493`) — intentional double-coverage; keep it.
- **`strategy_run_crashed` x9:** 8 = one-time backfill of anciently-stuck rows (06-15/06-18 + migration-era Roth); the 9th was the sweep false positive, already fixed and deployed.
- **Roth failure 07-09T21:39Z:** a transient Gemini 5xx that self-healed next hour — not a #1190 regression (the residual whole-run-on-one-5xx exposure is §1.9).
- **`strategy_bear_review_unavailable` x3 (all 07-07):** stopped; DeepSeek-timeout and single-adversary fixes are in the deployed image.
- **`rag_doc_type_coverage_empty` on 100% of runs:** the metric is correct — it's honestly reporting the real corpus gap (§3.2); it never enters Bull/Bear prompts and #1107 already folds it into run cards.
- **`evidence_age_anomaly` receipts:** advisory by design ("the receipt IS the control"); only the duplication is worth trimming (§1 P3).
- **NULL account on genuinely global kinds** (`vector_store` 305, `notify.sent` 378, `congress_share_daily`, `market_scan_failed` 2, `regime_flip` 6, consent/prefs, etc.): correct as recorded — only the footer wording needs the P3 fix; `strategy_run_crashed` attribution needs no code change (legacy rows).
- **The 06-30..07-01 ByteString errors and 07-01..07-06 timeouts:** historical, pre-window, fixed or ceased; zero `notify.error` of any kind since 07-09 00:00Z.