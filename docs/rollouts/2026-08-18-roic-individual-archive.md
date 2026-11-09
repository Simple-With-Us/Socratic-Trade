# ROIC Individual local archive (resume-from-cache + artifacts)

## Context & Objective

Owner cut 2026-08-17: finish the ROIC Individual local archive (`earningscalls_transcripts` + artifacts) before the tier ends.  Renew-vs-expire is still open; archiving is the work.  Harvest #2763 already persisted bodies first, but every scheduler tick still spent a v3 **list** call per symbol even when 20 quarters were already local.  Prod `roic-transcript-refresh` fired 1,356 times in 24h (0 skipped).  This PR stops that re-walk and writes a filesystem sidecar so a later DB restore does not re-burn the plan.

## Changes Made

- Skip ROIC HTTP when local SQLite and/or `data/roic-artifacts` already cover the phase (latest = any cached call; deepen/archive = plan-tier depth or a persisted call-index with no missing periods).
- Persist each fetched body to `earningscalls_transcripts` **and** `data/roic-artifacts/{SYM}/{year}Q{quarter}.json`.  Persist the v3 call list + winning identifier as `index.json` so NYSE names are not re-probed as NASDAQ.
- Hydrate SQLite from artifacts on read (resume after restore).  Cached newest periods are not re-fetched when a later list discovers them.
- Drain already-cached queue tail without spending the per-run fetch budget, so the cursor can reach archive and `lastComplete` without another universe list.
- Ops snapshot now reports `roicArchive` (counts, cursor, thin symbols, uncovered universe).  No vendor HTTP on that path.

Touched:

- `src/lib/web-sources/roic-transcripts.ts`
- `src/lib/roic-archive-artifacts.ts`
- `src/lib/db-earningscalls.ts`
- `src/lib/ops-snapshot.ts`
- `src/lib/scheduler.ts`
- `test/roic-transcripts.test.ts`
- `test/roic-archive-resume.test.ts`
- `test/ops-snapshot.test.ts`
- `docs/designs/2026-08-16-proposer-corpus-storage.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`
- this rollout

## Decisions & Trade-offs

- Did **not** call live ROIC from this cloud VM.  The workspace has no prod `app.db`, and using the Individual key here would be a re-walk of an empty cache.
- Did **not** add a SQLite schema version (merge-conflict trap).  Artifacts are files, same class as `data/sec-artifacts`.
- Latest pass treats "any local body" as covered.  A brand-new quarter after Individual expiry is an owner renew-vs-expire question, not a reason to re-list 1k names every 6h.
- Archive stays `local-only` for Pinecone (rev 3).  This PR does not flip `RAG_PINECONE_WRITE_CLASS` and does not touch FilingAPI / #2800 / #2798 / #2794 / #2792.  No Stripe.

## Verification State

```bash
npm run lint
# 0 errors (767 grandfathered warnings)
npx tsc --noEmit
# exit 0
npx vitest run test/roic-transcripts.test.ts test/roic-archive-resume.test.ts test/ops-snapshot.test.ts
# 3 files / 22 passed
npm test
# 580 files passed / 21 failed / 37 tests failed — all failures in untouched files
# (this VM has live provider secrets; strategy/history/notify tests hit real HTTP)
npm run build
# Next.js 16.3.1 production build succeeded
```

## Remaining gaps (2026-08-18)

Live ops snapshot at 01:08Z had **no** transcript inventory field (this PR adds `roicArchive`).  Last published harvest count (STATUS 2026-08-16, after #2750): **608 transcripts / 565 tickers**.  Demand-first universe tail is the 1,000-issuer RAG manifest.

| Gap | Why it remains |
| --- | --- |
| ~435 manifest names with 0 local calls | Walk has not reached them, or ROIC has no identifier.  After deploy, only these (plus partials) cost HTTP. |
| Most of the 565 tickers have ~1 call (608/565) | Latest-first did its job.  Archive/deepen still need up to 19 more quarters **only where the cached index says they exist**. |
| `data/roic-artifacts` empty in prod until this lands | Sidecar starts as new fetches and as hydrate-on-read of future restores.  Existing SQLite rows are written to disk the next time that symbol is persisted or hydrated. |
| High-interest deepen vs archive rest | Held/watchlist/technical still use the same 20q cap; they are not re-listed once local depth or the index is complete. |
| Renew-vs-expire | Owner call.  This PR does not subscribe, cancel, or charge Stripe. |
| FilingAPI leftover 401 on `/api/health` deps | Left to #2798 / #2792. |
| Transcript FTS / Pinecone hydrate | Rev 3 PR A/B.  Archive must not fill Pinecone with 20q × 1k bodies. |
| First-seen NYSE identifier | Still one failed NASDAQ list, then NYSE; winner is cached on `index.json`. |
| EarningsCalls.dev 200/month | Separate producer.  Not spent here. |

After merge, confirm `GET /api/ops/snapshot` → `roicArchive` and that `roic-transcript-refresh` skipped count rises (cached symbols no longer list).

## Next Steps & Blockers

1. Rebased onto `origin/main` (`d3e2c9ee`, #2892) so #2813 is conflict-clean.  Conflicts: `src/lib/web-sources/roic-transcripts.ts` + `test/roic-transcripts.test.ts`.  Kept this PR's cached-tail drain (`while (queue.length > 0)`) and main's #2848 pause + #2820 write-class tests.  Dropped later merge commits that would have absorbed #2814/#2892.  Did not merge.  Did not spend the Individual key.
2. Leave CI green, then land.  Coolify auto-deploys.  Watch `roicArchive.transcriptsWithContent` / `universeUncovered` / `thinSymbols`.
3. Owner: renew-vs-expire Individual.  Do not start a second full-universe list while the cursor is still walking gaps.
4. Leave FilingAPI leftover and other clusters to their existing PRs.

## Zero-Code Findings

Prod scheduler is healthy (tick age 8s) and `roic-transcript-refresh` is the live harvest lane (avg 29s, max ~3.5h).  The waste was the per-symbol list, not a missing producer.  Cloud checkout has only `data/rag-universe-manifest.json` — no local transcript cache to resume from here.
