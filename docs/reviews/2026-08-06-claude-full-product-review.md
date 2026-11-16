# Full-product review — web + iOS + cross-app coordination (MONET, 2026-08-06)

Owner-requested comprehensive review: identify issues, improvements, polish, and
expansion opportunities across the website formats (console, PWA, public pages) and the
iOS app; verify cross-app coordination (Congress.Trade, Usage Monitor, R2/litestream,
board/Slack); audit the effort board + GitHub issues for accuracy.

Method: signed-in live review of production `socratictrade.com` (owner authenticated the
browser pane; read-only — no approvals, runs, or settings changes), Coolify/box
diagnostics over the API + SSH, plus a 12-agent review workflow (web console UX, public
site + PWA, iOS native, design system, accessibility, state/feedback coverage,
coordination, issues audit, board audit, and a 3-lane adversarial verify pass).
GitHub issues filed from this review are labeled `product-review-2026-08-06`.

## A. Urgent operational findings (found and acted on during the review)

### A1. P0 — Prod deploy pipeline frozen all day (repaired-in-progress; RCA narrowed)
All five 2026-08-06 deployments failed; prod served `6b47a886` (built ~05:17Z) while
main advanced four merges to `0e9c79b1`:

| Queued (Z) | Merge | Deployment uuid | Outcome |
|---|---|---|---|
| 05:48 | #2541 | `j1rhbz4igy0ff3ma5eoi0iww` | failed 06:12 (24m) |
| 06:13 | #2543 | `onlrw5mgf4s2pw9he4udt2kg` | failed, `finished_at=None`; helper container ran 13.5h (zombie — removed 21:0xZ) |
| 06:40 | #2544 | `nt269itnr5v9lhg29rz1znu5` | failed 07:24 (44m) |
| 14:22 | #2542 | `o2l3dzk8zbik0f4lhx0lc3fv` | failed 14:40 (18m) |
| 21:10 | redelivery (MONET) | `zs8qq7wizjjti1kfk0pa4ajx` | failed 21:16 (6m) |

Signature in every case: webhook fine (`Deployment queued.`), build log stream cuts at an
arbitrary step, Coolify `ExecuteRemoteCommand` dies with SSH exit 255 (sshd shows
client-side "disconnected by user" from the Coolify container), buildkit reports
`context canceled` at teardown. Ruled out: webhook HMAC (this time), kernel OOM
(`journalctl -k` clean), disk (41%), tcp_mem (313 pages used vs 285k floor), sshd config,
Coolify restart (up 5 days). Correlation: Congress.Trade's `scan-cpu-worker` OCR batches
ran on the same 4-core A1 box all day, and Uptime-Robot flapped on all three sites hosted
there all day. Working theory: host contention kills Coolify's multiplexed SSH exec
stream. Second redelivery on a quiet box (21:19, `hphdauml77lu3ebmyj3rj95r`) survived
past every earlier failure point (result recorded in the rollout note / #ag***-s**c).
Follow-ups filed: isolate or `cpuset`/`nice` the CT scan worker vs deploy builds;
alert on "main ahead of prod release sha for >1h" (a `verify-deploy-sha` cron would have
caught this at 06:00 instead of 19:40).

### A2. P0 — Production DB has had no litestream replication since Aug 4
The R2 free-tier kill-switch is engaged for Socratic Trade (admin R2 panel: "writes are
paused"; storage shows 0.00 GiB — replica emptied). The trading DB's continuous backup
and the documented rollback path (litestream R2 replica) are both inactive.
`/api/health` storage shows `litestreamState: "unknown"`; STATUS.md still says
"litestream replicating" (stale). Owner decision needed: resume
(`POST /api/admin/r2-usage/resume`, Class A pace 16.4% used / projected 82% by month-end)
or provision an alternative backup (different bucket/provider, or paid tier).

### A3. P1 — Cross-app R2 free-tier pressure (fleet)
Same admin panel, all checked 8/6 15:05: **Usage Monitor storage 9.86 GiB = 98.6%** of
the 10 GiB free tier (needs prune NOW); **Congress.Trade Class A pace → 236%** of free
tier by month-end; Socratic pace 82%. The three apps share one R2 free tier budget-wise;
nobody currently owns the cross-app total.

## B. Cross-app coordination

### B1. P1 — Shared package lockfile drift ships the wrong version (again)
`package.json` pins `congress-trading-shared#v2.5.1` but `package-lock.json` resolves
**2.5.0** (`b454ccb8`). v2.5.1 is the dual-anchor (filingDate + tradeDate) member
performance API — the dependency of the already-shipped Congress filing-date member
skill (#2429), which therefore degrades silently in prod. Same failure class as the
v2.3.0-lock/v2.4.x-manifest drift caught 2026-08-02. Fix: regen lockfile; consider a CI
assert that the lock's resolved tag matches the manifest pin.

### B2. P1 — Congress.Trade lane flaky from prod's perspective
`/api/health` showed `congress.trade: ok:false` at 19:36Z; admin lane: last fail 2h ago,
739ms when healthy; `congress.trade:sse` fails intermittently (oldest alert 18h);
outside probe of `https://congress.trade/` took **11.2s** (CT itself reports healthy).
Consistent with shared-box contention (same root as A1). The integration works but is
degraded; the app's alert feed pays the noise cost (see D6).

### B3. P1 — Usage Monitor telemetry lane degraded
Admin lane `usage-monitor`: last latency **6.9s**, last fail 4m before check, ~478
calls/hr from prod. UM was mid-deploy-drama + R2 pressure today (GROK). ST already has
a negative-cache backoff knob for UM — verify it engages at these latencies; consider
widening backoff when UM is unhealthy so a degraded telemetry sink can't add 7s stalls.

### B4. P2 — Board/issue mirror hygiene (see also F)
The effort-board GitHub mirror had 15 `state:in-progress` issues while the repo had ZERO
open PRs and several "IN PR/IN PROGRESS" rows whose PRs merged days ago. Corrections in
§F and in the board files.

## C. Live product bugs (web console, production data)

### C1. P1 — "VERSUS THE MARKET" shows +56.47% on a flat account
Results page, window 7/29→8/6, equity ~$100,301→$99,704 (≈ −0.6%), yet YOUR ACCOUNT
+56.47%. Cause visible in the capital-regimes table: a phantom inferred **"withdrawal
$36,501.38"** on the 08-04→08-05 sub-period (equity moved only −$837 — a real $36.5k
withdrawal is arithmetically impossible) → that sub-period alone shows +56.16%.
Flow-inference misreads something (likely a snapshot taken mid-order/mid-day gap) as a
transfer. Confirms and sharpens GROK's open `grok/fix-account-return-pct` row.

### C2. P1 — SPY benchmark reads 0.00% for every sub-period
Same table: SPY 0.00% across all windows and overall (impossible for 7/29→8/6), so
"VS SPY" just re-prints the account number. The SPY series fetch silently fails and the
UI renders it as zeros instead of "benchmark unavailable". Related: multi-period TWR
(#2538) chains SPY sub-periods — with a dead SPY feed the whole comparison is fiction.

### C3. P1 — Open-lots ledger contradicts live positions
Tax "OPEN LOTS" shows `T` **long 91.119** (13d held) while POSITIONS shows `T`
**SHORT −1.881**; `AXP` has an open lot (5 sh, 37d) with no position row. Lot state
missed closes/side-flips → wash-sale ($223.57 disallowed) and early-exit-tax estimates
are computed on wrong lots.

### C4. P1 — Two unmanaged short positions with no protective coverage
PG (−12) and T (−1.881) show Protection "—". Root cause located:
`app/console/lib/derive.ts` (~line 250) — every enforcement layer deliberately skips
shorts while `shortSellingEnabled` is off, and shorting is off for this account with
shorts still on the book. Guardrails page simultaneously promises "every short carries a
stop — a short without one is rejected." Ask: an attention banner ("2 short positions
are unmanaged while short selling is off — enable shorting or close them"), because "—"
undersells the risk. (Also the known Phase B short-side broker-held buy-stop lane
remains open backlog.)

### C5. P2 — Red Team absent/failed on 4 of 5 pending proposals
"No AI critic" ×3 (incl. the $5,000 T buy) and "AI critic: failed" ×1 — PWA reveals the
cause for GOOG: "Red team FAILED (malformed response) — DeepSeek". Policy (approval mode)
correctly lets flagged proposals through, but the console chip underplays it and gives no
cause. Ask: chip → "Red Team failed (DeepSeek malformed) — reviewed by nobody", link to
the failure, and surface critic-failure *rate* somewhere an owner will see it.

### C6. P2 — Proposal rationale accumulates duplicate annotations
The same "[Stale quote backup: … Converted to a limit …]" line is appended twice (159s
and 160s variants) to the T rationale; CINF likewise (204s ×2). Re-evaluation appends
instead of replacing. Cosmetic but makes receipts look buggy.

### C7. P2 — Activity feed taxonomy: duplicates + ingest flooding
(a) Each proposal emits near-identical "BUY T · Sent · Pending" and "TRADE T · Sent ·
Pending" rows; SELL ZTS appears twice at the same age. (b) TODAY starts with ~30
"Sec filing ingest … 10-K · Completed" + per-minute "Disclosure rag embed" rows before
any trading event, even though a "System · 29 background events" collapse exists —
ingest/embed rows bypass it. Route all housekeeping rows into the System group.

### C8. P2 — Disclosure-embed no-op runs audited every minute
"Disclosure rag embed · Attempted: 310 · Indexed: 0" every 1–3 min. Verified in code
(`src/lib/web-sources/disclosure-rag.ts` → `storeContexts` dedup filters BEFORE
embedding, `vector-db.ts` ~2676) that this costs ~no API spend — it is hash-check noise,
not the credits drain — but a no-op result should not write an audit row every cycle.
Skip the audit (or log `deduped: 310`) when indexed=0 and error is empty.

### C9. P2 — "Today: $0.00" chip is budget, reads as P&L
`app/console/components/chrome.tsx:993/1003/1064` — the chrome chip is
`spend.usedNotional` (today's opening-notional budget use) but renders as bare
"Today: $0.00" directly above a DAY P&L card showing +$498.36. Rename ("Deployed today",
"Budget used today") or move next to the budget meters.

### C10. P2 — Scan page freshness/empty-state polish
Chip literally reads "**1h ago old**" beside "scanned 1h ago" (duplicate + broken
phrase); "Market scan (0)" with a perpetual disabled "Scanning…" button and no
explanation while the market is closed (deferred E1 empty-state system visible here).

### C11. P2 — "Broker protective stop skipped (x2) — V" with no reason
The event row gives no cause (V is a 0.215-share fractional position; Alpaca can't hold
stops on fractionals). Carry the skip reason into the row/detail.

### C12. P3 — Copy/label nits
"Broker reported Expired: Expired" duplication (Jul 27–28 wave of stale-limit
expiries); account-switcher "Alpaca Paper ·· MFK9" double-middot; ZTS logo-fallback
monogram renders "ZT"; readiness checklist explains "(one control — not duplicated
here)" — agent changelog-speak in owner-facing copy; Guardrails cadence "next run time
not in this snapshot".

## D. Product improvements (ranked)

### D1. P1 — PWA proposal cards need the console's collapsed-receipt treatment
`/mobile` renders the full raw rationale + `[Sizing]`/`[Risk]`/`[Stale quote …]` bracket
wall per card. Wave-A2 shipped collapsed cards on the console; port it to the PWA
(2–3-line thesis + "Show full reasoning").

### D2. P2 — Cross-surface state language: "Running" vs "Paused · market closed"
PWA MODE says "Running" while console says "Paused · market closed" for the same
account/state. Unify the vocabulary (enabled vs currently-running vs paused-for-market).

### D3. P2 — Alert center: per-condition mute/snooze + provider-outage rollup
18 "Attention" alerts, mostly x7/x4 repeats of the same provider failures, 53 more
hidden cross-account. Grouping exists; muting/snoozing a known-degraded provider (and a
single "N providers degraded" rollup row) would cut fatigue materially.

### D4. P2 — Usage page: attribute embedding/rerank spend
`/console/usage` covers LLM calls per model×context but the 500+/hr embed calls (10-K
backfill) and rerank calls are invisible — precisely the spend class behind today's
"OpenRouter credits low" alert. Add an "Embeddings/RAG" context row.

### D5. P2 — Red Team prompt compaction
Reviewer calls average 60–80K input tokens (llama-3.3: 13 calls → $5.93 nearly all
input). Compact the candidate/context payload for reviewers; likely 3–5x cost cut on the
Red lane.

### D6. P2 — Admin server-stats card shows placeholder data
CPU 0.0%, "Total memory Unavailable" while 8 containers run. Either wire the read-only
stats token path or drop the dead card.

### D7. P3 — Backlog confirmations from live review
Unauth apex → /welcome redirect (marketing page is unreachable organically); readiness
candle-canvas overlap at ~800px width; "Request access" mailto → form when GTM matters;
"acct test-loc" still in Usage filters; per-position "next run" visibility.

## E. iOS app + design system + a11y (workflow findings)
Filed as issues #2556–#2563; headlines in §H below.

## F. Board + issues audit outcome (verified with receipts)
Zero open PRs existed while 15 mirror issues claimed `state:in-progress`. Audit of all 47
open mirror issues: **24 corrected** (14 closed with merge receipts — #2539 #2537 #2535
#2534 #2514 #2513 #2512 #2501 #2468 #2467 #2466 #2465 #2464 #2437 — and 10 relabeled to
their true state), **23 verified accurate**. Board files: stale IN-PR/IN-PROGRESS claims
for the merged `grok/data-sources-overhaul` cluster (#2531), P0-security (#2498),
residual-issues batch (#2490), RAG multi-source (#2533) corrected in both the live board
and the mirror; duplicate rows for merged PRs #2443/#2445/#2459 and the filing-skill
dup removed from the mirror; the `- -` double-bullet union-merge scar fixed. Remaining
known mirror hygiene (deliberately NOT bulk-deleted — other agents' rows): the mirror's
Planned section still carries a block of COMPLETED-text activity-audit/P0/P1 rows
(~mirror lines 205–266) that the live board already pruned; next board-hygiene pass can
relocate them. STATUS.md stale blockers (FMP framing, "litestream replicating")
corrected.

## G. What is genuinely good (don't churn it)
Proposals triage + honest gated Red-Team efficacy stats (n≥20 discipline), the
Guardrails page (advisory framing + composed stop-lane diagram is the best page in the
product), tax lot awareness, per-model×context usage attribution, plan-tier key catalog,
OFF-vs-STOPPED health semantics, decision case-file framing on the public pages.

## H. Workflow findings (5-lane run; all file:line-grounded)
The original 9-reviewer workflow was killed mid-flight by a session interrupt; a lean
5-agent run (issues audit, board audit, iOS, design/a11y, web-code) completed in ~7 min.
Highlights (full details in issues #2556–#2563):

- **P1 web (verified live): Home "All Decisions" → 404** — `/console/decisions` has no
  index page (`app/console/page.tsx:338`). #2556.
- **P1 correctness: the inflated-return bug SURVIVES #2536** — live repro ran on a build
  containing the fix; phantom $36.5k inferred withdrawal + SPY 0.00% everywhere. #2557.
- **P1 expansion: settings-search catalog fully built, wired to nothing** —
  `app/settings-search.ts` (fields, glossary, synonyms, relocations) has zero UI
  consumers; wire into the command palette. Also indexes a phantom
  `defaultLandingAccount` field. #2558.
- **P1 iOS: Close-only / Wind-down absent on iOS** (PWA has them; MobileStore already
  whitelists both) + zero APNs wiring while alert copy promises off-app watch +
  TestFlight compliance gaps (no ITSAppUsesNonExemptEncryption, no privacy manifest).
  #2560. iOS otherwise in strong parity shape.
- **P2 mobile state bugs**: iOS SSE "connected" indicator stays false on a healthy idle
  stream (heartbeat comments ignored); PWA `marketSession` type drift renders Market
  always "Closed". #2559.
- **P1/P2 a11y**: light-theme tonal chip text fails WCAG AA on soft fills; Sheet's
  Escape handler ignores surface stacking (closes the sheet under a drawer); tooltip
  content keyboard-unreachable/unannounced; scan Columns popover missing
  aria-expanded/Escape/focus move. #2561. Token system otherwise excellent (4 files with
  raw hex, all decorative; chips word-first; toggles/icon-buttons labeled).
- **P2/P3 polish batch**: retired-FMP mentions in live tooltip/caption, "Paper mode"
  vocabulary in preflight error, Coach/Assistant label drift, dead `market-data-filled`
  event, intro-canvas light-palette candle colors in dark mode (+ canvas drawing through
  checklist text at ~800px), iOS paper "?" icon / scheduler-state mislabel / URL
  literals / Dynamic Type fixed widths. #2562. Curl-only capabilities (tuning-dry-run,
  learning-ledger, backtest-ic, audit query) → #2563.
