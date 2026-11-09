# 2026-06-25 — Member skill-weighting from App A's per-member performance endpoint

Branch `agent/claude-member-skill`.

## Summary
App A relayed two things: (1) its fundamentals/analyst tables (PR #46) are live in prod — App B can
flip `CONGRESS_SHARE_FUNDAMENTALS_ENABLED` on; (2) a new endpoint
`GET /api/analytics/member/:filerId/performance` exposing realized **return / win-rate / alpha vs the
S&P** per member. This change consumes (2): the congress-analytics overlay now weights cluster members
by **real skill (alpha)** instead of the activity proxy, falling back to activity until App A has scored
performance for a member.

## Why
Member quality previously rank-normalized only App A's *activity* magnitude (`estVolumeUsd`/`tradeCount`)
because the member-leaderboard exposed no track-record numerics — an "is this member prominent?" proxy,
not "is this member any good?". App A's new per-member performance endpoint provides realized alpha vs the
S&P (`avgExcess`/`medianExcess`), the metric we actually want for member-weighting. filer_id resolution
has also progressed (member-leaderboard + cluster `topMembers` now carry stable `filerId`s), so we can key
skill by `filerId` and look it up per member.

## What changed
- **`src/lib/congress-trade-client.ts`** — new `getAppAMemberPerformance(filerId)` reader +
  `AppAMemberPerformance` type. Gated on `congressAnalyticsEnabled()`, public read token, URL-encodes the
  filerId. Returns `performance` (or null) — `{tradeCount, scoredCount, winRate, medianReturn,
  medianExcess, avgReturn, avgExcess}`.
- **`src/lib/web-sources/congress-analytics.ts`** —
  - new `buildMemberSkillScores(filerIds)`: bounded (`MAX_SKILL_LOOKUPS=200`) per-member performance
    fetch, rank-normalizes realized **alpha** (`avgExcess` → `medianExcess` → `avgReturn`) to 0–100 keyed
    by filerId, ranking only members with `scoredCount > 0`. Empty until App A has scored performance.
  - `refreshCongressAnalytics` collects the distinct `filerId`s from cluster `topMembers`, fetches skill
    scores once, and the cluster `topMemberScore` now **prefers** the real skill score (by filerId) and
    **falls back** to `buildMemberScores` activity prominence (by name). No perf calls when there are no
    clusters.
- **Tests** (`test/congress-analytics.test.ts`) — `stubAnalyticsFetch` now serves
  `/member/:id/performance` from a `perf` map; added an overlay test (high-alpha filer wins
  `topMemberScore` over a higher-activity filer) + a `buildMemberSkillScores` unit suite (alpha
  rank-normalization, `scoredCount==0`/null/dedupe skip, `medianExcess`→`avgReturn` fallback,
  disabled = no fetch).
- **Docs** — `docs/congress-trade-consume.md` §3 updated to describe real skill + fallback.

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run test/congress-analytics.test.ts test/congress-trade-client.test.ts` — 22 passed.
- Live probe of `GET /api/analytics/member/:filerId/performance` confirmed shape + real data
  (e.g. `house-nj05-josh-gottheimer`: scoredCount 41, winRate 0.51, avgExcess +0.0436); some members
  `scoredCount:0 → nulls`. Endpoint was briefly 404 then 200 (App A deploy propagated mid-probe).
- Full `npm test` + `npm run build` run by `scripts/land.sh` before PR.

## Follow-ups / ops (not code)
- **Flip `CONGRESS_SHARE_FUNDAMENTALS_ENABLED=on`** in prod `.env.local` now that App A's #46 tables are
  live (fundamentals/analyst `[]` already ride the scan-hook push; erroring rows were non-fatal anyway).
- **Run the deep-history price backfill** (`POST /api/admin/congress-share {"fullHistory":true}`) so App A
  can score per-member performance — `scoredCount`/alpha only fill in once prices land for the traded
  tickers. Until then `topMemberScore` rides the activity fallback.
- Still open: the **price-adjustment** question (App A's FMP closes are split/dividend-adjusted; App B's
  are mostly raw) — orthogonal to this change but gates how trustworthy App A's per-member alpha is.
- Broader future use: weight the base per-symbol congress signal (not just clusters) by member skill —
  needs `filerId` threaded through `CongressTrade`/`CongressSignal`.
