# 2026-08-18 — Week-error expert triage

## Context & Objective

Owner sent iOS Scan/Home shots and asked a team of experts to analyze and
troubleshoot every error from the past week (2026-08-11 through 2026-08-18).
This note is the inventory, what is already owned, what this lane fixed, and
what must not be stolen.

## Live box (2026-08-18 ~20:14Z)

- `/api/health` HTTP 200, `ok: true`, sha `12e8dcd` (#2812 rag-embed soft-degrade, process start 20:03:38Z).
- Scheduler ticking.  OpenRouter credits ok.  Pinecone configured.
- `tradingLivenessDegraded: true` — 1 of 2 Autopilot accounts (Paper consecutive Green 400s).  Market closed.  Last completed run ~5.6h.
- Litestream L0/L1/L9 healthy.  L2/L3 wedged ~13–14h (same dual-writer hole).  Owner-ops.
- `congress.trade:sse` probe `ok: false` (CT, not an ST origin outage).

## Sentry 7d (org `jays-services`, project `socratic-trade` / `agentic-trading`)

| Issue | Events | Last seen | Verdict |
|---|---:|---|---|
| SOCRATIC-TRADE-1T Pinecone connection failed | 360 | 19:41Z | `reason=terminated` on query managed shared tier.  Deploy-window socket death.  Pinecone is still a **critical** health dep — 5-streak still 503s Docker. |
| SOCRATIC-TRADE-1X OpenRouter embed connection failed | 21 | 20:13Z | Live on `12e8dcd`.  `key_source=none` is a **tagging bug** (`voyageSource` never set in prod), not a missing key.  Do not mint `OPENROUTER_API_KEY`. |
| SOCRATIC-TRADE-22 OpenRouter rerank connection failed | 14 | 19:41Z | Same family as 1X. |
| SOCRATIC-TRADE-1V congress.trade:sse connection failed | 13 | ~1h | Matches live health probe.  CT SSE, not Scan. |
| SOCRATIC-TRADE-27 RAG document embedding integrity rejection | 9 | 20:13Z | **New after #2812.**  Thrown embed batches are now counted as `rejected` and page this title.  Not a new bad-vector class.  Noise. |
| SOCRATIC-TRADE-26 TypeError: terminated | 1 | 17:08Z | Unhandled `terminated` / “other side closed” during earlier sha. |
| filingapi / robinhood / massive / vix / tradier / UM / sqlite locked | 1–3 each | 1–6d | Mostly retired, one-off, or already classified.  FilingAPI 401 lanes still open (#2792/#2798). |

Dashboard: https://jays-services.sentry.io/issues/?project=socratic-trade&query=is%3Aunresolved+lastSeen%3A-7d

## Owner iOS shots (3:01–3:02pm CT)

Not two clocks.  Scan was a 3-hour-stale snapshot from regular hours (“Market Open”).  Home had just refreshed after 4:00 ET (“After Hours”, Paused · market closed).

| Shot | Cause | Owner |
|---|---|---|
| 0 names · 2 watched since 8/13 | Nasdaq screener still stub `Mozilla/5.0` + 8s abort; `/api/scan` 200s an empty table | **#2830** (do not rewrite) |
| Two identical connection banners | `store.error` + Scan `loadError` shared one sentence; 25s iOS timeout raced 20s server + quote/VWAP tail | **#2834** (this lane) |
| Equity thin bar + “select a connected account” | `portfolio` nil after Roth `getAccounts`/`getPortfolio` double Alpaca GET blew 6s; large-title em-dash | **#2834** cache + honest copy |
| Paper Autopilot 4x Green fail / 0 proposals | 400 not failover-eligible; terra first; liar “3 endpoints exhausted”; empty Scan also zeros proposals | **#2831** + **#2830** |

## Already merged this week (do not redo)

#2829 require_parameters 404s.  #2812 embed 503 no longer restarts Docker.  #2800 Pinecone remainder deadlock.  #2799 trial WU / healed compaction noise.  #2750 ROIC single-flight.  #2751 rotation / penny 422.  #2720 stale quotes / health credits bound.  #2709 L2 empty-as-wedge detection.  IRA wash-sale copy #2825.

## This lane (#2834)

- Alpaca in-flight + 15s `getAccount` cache.
- Scan-specific error copy, hide workspace banner on Scan, keep last scan while refreshing, hide Guardrails empty state on a failed refresh, 45s `/api/scan` timeout.
- Home “waiting on broker” + broker-unreachable portfolio copy.

## Decisions & Trade-offs

- Did not steal #2830 / #2831 / #2817.
- Did not mint an OpenRouter key.  `key_source=none` is `voyageSource` left at `"none"` in prod `getClients`.
- Did not add a client market-session clock.
- Did not touch B2 L1 (owner-ops).
- Did not fold Pinecone-`terminated`-as-transient into this PR (`vector-db.ts` is a merge magnet).  That is the next unclaimed infra cut: treat `terminated` / `fetch failed` / `UND_ERR_SOCKET` as transient so they do not 5-strike a pinecone 503.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/alpaca-account-cache.test.ts
xcodebuild build -project 'ios/Socratic Trade.xcodeproj' -scheme SocraticTrade \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

tsc clean.  3 Alpaca cache tests pass.  iOS **BUILD SUCCEEDED**.  First `xcodebuild test` failed because this machine’s iPhone 17 Pro data dir was gone.  Recreated the sim (`27C2C925-8A84-4058-9EA1-C4A0F446B20A`).  Second run: **TEST SUCCEEDED** — 123 tests, 0 failures, including the new Scan copy / 45s timeout / portfolio empty tests.  No signed-in screenshot (fresh sim has no session).

## Next Steps & Blockers

1. Let #2830 / #2831 / #2834 merge and auto-deploy.  Then verify Scan names, Paper Green failover, Roth equity.
2. After those land, raise `INTERACTIVE_SCAN_BUDGET_MS` if #2830’s retry+Yahoo fallback hits the 20s wall.
3. Unclaimed infra: Pinecone `terminated` = transient (above).  Do not steal #2817 RTH latch / `/api/live` HEALTHCHECK.
4. L2/L3 remains owner-ops B2 surgery.
5. Native Scan/Home copy ships on the next TestFlight.

## Zero-Code Findings

- Empty Scan is not RAG.  `scanMarket` does not query Pinecone.
- Green empty **because RAG died** was the embed 503 → Coolify restart → boot halt.  #2812 closed that for embed.  Pinecone is still critical.
- SOCRATIC-TRADE-27 is #2812 counting thrown batches as integrity rejects.  Same trace as 1X.
