# 2026-08-01 — Free-tier data cascade gap-fills, R2 kill-switch + daily report, litestream socket discovery, stuck-order resolution

## 1. Context & Objective

Owner directives (2026-07-31/08-01): (a) make sure every data source works on FREE tiers and the
enrichment cascade populates everything without paid subscriptions — or name the unfillable data
points and add free sources; (b) resolve all stuck sell orders; (c) make sure litestream works
and get a daily R2 usage alert; (d) auto-disable R2 consumption if ever on pace past 70% of the
free tier until a human decides.

Mid-task the prod box went through another operator's docker data-root migration (03:14–04:00
UTC, all containers removed and rebuilt) — production 523'd for ~45 min and recovered without my
intervention (two-surgeon rule: monitored only). This rollout documents that as an FYI, not my change.

## 2. Changes Made

- **`src/lib/data-providers.ts`** (YahooFinanceEnrichmentProvider) — the already-fetched
  quoteSummary `financialData` module now also maps `targetMeanPrice/High/Low/Median` →
  `targetMean/High/Low/Median` (positive-only, matching the congress.trade/FMP sentinel rules),
  `revenueGrowth` (decimal fraction → percentage points), and `freeCashFlowYield` (same value as
  `fcfYield`; market.ts already treats them as aliases). These five/six fields were previously
  sourced ONLY from FMP (key suspended) or congress.trade — now free-tier filled.
- **`src/lib/quiver-provider.ts`** — `resolveQuiverApiKey` now falls back to
  `QUIVERQUANT_API_TOKEN` (the owner's secret-store spelling); the provider was silently dormant.
- **`src/lib/runtime-health.ts`** — litestream control-socket discovery now tries, in order:
  explicit option → `LITESTREAM_SOCKET_PATH` → legacy `/var/run/litestream.sock` → the 0.5.x
  db-dir default `<db-dir>/litestream.sock` (via `defaultLitestreamSocketPath`). Root cause of
  the 7/30–8/01 `litestreamState:"unknown"` false alarm: 0.5.12 ignores the config file's
  `socket.path` and listens at the db-dir default; replication was healthy the whole time.
  (Main's #2323 shipped the same db-dir default; this adds the legacy-path candidate back so
  older layouts still probe correctly.)
- **`src/lib/r2-usage.ts`** — daily usage summary notification (once/24h, all three metrics,
  independent of threshold alerts; `R2_USAGE_DAILY_REPORT=0` to disable) + hard kill-switch:
  when armed (`DB_BOOTSTRAP=live` AND `R2_USAGE_AUTO_DISABLE` ≠ 0) and any metric is on pace past
  the threshold, writes `/app/data/.litestream-r2-disabled` (audited `r2_usage.auto_disabled` +
  🛑 notification) and exits the process so the container restarts WITHOUT litestream.
  `resumeR2Replication` (admin `POST /api/admin/r2-usage/resume`) removes the marker and restarts
  (replication resumes). GET `/api/admin/r2-usage{,/resume}` now expose
  `replicationDisabled`/`autoDisableArmed`.
- **`scripts/coolify-prod-start.sh`** — boots WITHOUT `litestream replicate` while the
  kill-switch marker exists (logs the marker contents). ASCII-only.
- **`app/api/admin/r2-usage/route.ts`** (status fields) + **`app/api/admin/r2-usage/resume/route.ts`** (NEW).
- **`scripts/cascade-audit.ts`** (NEW diagnostic) — enriches a few symbols through the real
  cascade and prints per-field winners + coverage report; used for the ground-truth audit below.

Tests: +2 Yahoo target/revenue/FCF mapping (+ sentinel drop), +1 quiver env-alias, +1 litestream
db-dir socket discovery, +4 R2 (daily report once/24h; armed auto-disable writes marker + exit 41,
no re-fire, resume removes + exit 42, not-armed outside live boot).

## 3. Decisions & Trade-offs

- **Kill-switch restarts the whole container** — the only way to stop litestream (it is the
  app's parent process via `replicate -exec`). Marker file on the persistent volume makes the
  state survive restarts; resume is one admin POST. While disabled, PITR backups to R2 pause —
  the owner accepted this ("until we decide what to do").
- **Auto-disable is armed only on `DB_BOOTSTRAP=live`** — never in dev/tests/fresh boots.
- **Yahoo targets are positive-only** — a 0/negative target is a sentinel, never allowed to win
  first-wins (same rule as the congress.trade parser).
- **insiderSentiment stays partially unfilled** (see Zero-Code Findings) — no free source covers
  it broadly today; computing it from the app's own SEC Form 4 ingestion is the recommended
  follow-up, deliberately not built in this pass.
- The parallel Kimi session's oss-lessons §7 WIP (broker-status-conformance) in this worktree was
  left untouched.

## 4. Verification State

```bash
npx tsc --noEmit      # clean
npm run lint          # 0 errors (661 pre-existing warnings)
npx vitest run test/r2-usage.test.ts test/runtime-health.test.ts \
  test/quiver-provider.test.ts test/data-providers.test.ts   # 175/175
npm test              # DELEGATED TO CI verify — host load blocked local full runs twice
npm run build         # DELEGATED TO CI verify (same)
```

Ground-truth cascade audit (`scripts/cascade-audit.ts`, real API calls, free keys only):
BEFORE: 19 gap fields. AFTER: 8 remain — bid/ask/asOf/vwap (Alpaca snapshot tier, present in
prod; also legitimately empty on weekends), nearTheMoneyIv/putCallRatio (opt-in Robinhood options
tier — ENABLED in prod Infisical this session), senateTrades (congress.trade, present in prod),
insiderSentiment (1/3 via filingapi — only true remaining gap, see above). All 5 quiver fields +
4 target fields + revenueGrowth + freeCashFlowYield now fill from free sources.

Prod Infisical writes this session: `ROBINHOOD_OPTIONS_ENRICHMENT_ENABLED=1`,
`QUIVERQUANT_API_TOKEN` (verified working token, HTTP 200) — active on next deploy restart.

## 5. Next Steps & Blockers

- Owner: renew or remove the suspended FMP key and lapsed Polygon/Massive paid plan (both still
  degrade gracefully — free tiers cover the fields, per the audit above; renewing restores
  real-time quotes instead of 15-min delayed).
- Owner decision on EA/AFL/BAC (Alpaca Paper): their trailing-stop orders were canceled per the
  directive (AAPL/JNJ stops had already FILLED — positions exited), but the app's protective-stop
  monitor re-placed EA per its LLM-authored stop plan. To actually EXIT those positions, approve
  the sell proposals (or say the word); to leave them unprotected, remove the stop plans.
- Follow-up filed: compute insiderSentiment from the app's SEC Form 4 ingestion (free, already
  ingested) instead of paid Finnhub/filingapi tiers.
- Infra note for the box operator: the Coolify static env carries an over-escaped 72-char
  `ENCRYPTION_KEY` (Infisical correctly overrides it in the app process env — harmless today,
  worth cleaning up).

## 6. Zero-Code Findings

- **Litestream was never broken** — replication ran healthy the entire incident; the health
  probe looked at the wrong socket path. Now `litestreamState:"known", source:"ipc"` in prod.
- **Stuck orders** — AAPL `32150898-…` and JNJ `24ba055f-…` trailing stops FILLED (positions
  exited at trail price; the app's cancel attempts then 422'd and recovered). EA/AFL/BAC trailing
  stops on Alpaca Paper canceled 2026-08-01 (HTTP 204 ×3).
- **Prod outage 03:14–04:00 UTC** — another operator's docker data-root migration
  (`/var/lib/docker` → `/data/docker` + containerd) deliberately stopped docker and removed
  containers; everything recovered. socratictrade.com 523'd during the window.
- QuiverQuant token verified live (200 on /beta/live/congresstrading).
