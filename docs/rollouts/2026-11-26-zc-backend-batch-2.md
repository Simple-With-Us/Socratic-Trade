# [ZC] ST-4690 backend batch 2: sargable hourly notional query and a live-capable universe manifest generator

## 1. Context & Objective

ST-4690 is backend batch 2 of the ST-4668 roadmap reconciliation.   Two items were still open against `main`: E1d's sibling, where the rolling notional query in `src/lib/db-execution.ts` was still non-sargable after ST-4643 fixed its daily twin, and A4e, where the RAG universe manifest generator emitted sentinel rows and had never had a live run.   This lane implements both.   The third item in the batch list, the audit chain-tip table, is owned by ST-4667 (still Todo) and was deliberately not duplicated here.

## 2. Changes Made

- `src/lib/db-execution.ts` (OWNER-MERGE / CODEOWNERS money path).    `notionalInLastMinutes` now uses the same two-branch sargable `UNION ALL` that ST-4643 applied to `dailyExecutionStats`: `placed_at >= :cutoff` and `(placed_at IS NULL AND created_at >= :cutoff)`, both served by `idx_trade_proposals_user_account_status_placed`.   The cutoff is truncated to whole seconds because `datetime(x) >= datetime(y)` compared whole-second-normalized instants; every writer stores the same ISO-8601 UTC shape, so the TEXT comparison is the same instant comparison.   An EMPTY (not NULL) `placed_at` is excluded exactly as before.   The pre-trade hourly caps in `src/lib/strategy.ts` (2 call sites) and `src/lib/strategy-execution.ts` (1 call site) now stop walking the account's whole proposal history.
- `test/notional-in-last-minutes.test.ts` (new, 4 tests).   Row-set parity against the verbatim pre-rewrite predicate (including a sub-second cutoff and an empty-string `placed_at`), the opening-only notional rule with the proposal fallback, and an `EXPLAIN QUERY PLAN` assertion that both branches are index range seeks with no table scan.
- `src/lib/rag/universe-manifest-build.ts` (new).   Pure assembly step for the generator: ordered candidates (DB history → index membership → SEC prominence order), quarantine of any issuer without a verified listing exchange or a real quote, backfill from the next SEC row until the 1,000-issuer contract is met, alias merging for a second SEC ticker on the same CIK, schema validation with the target count, and a sentinel-shape self-check.   It throws instead of returning a degraded manifest.
- `scripts/eval/generate-universe-manifest.ts` (rewritten shell).   The old script could not be executed at all: it imported `src/lib/db.ts`, which begins with `import "server-only"`, so `tsx` threw before `main()` ran.   It now reads the local SQLite file directly (`better-sqlite3`, read-only, no migrations) and uses a small local fetch helper, which also removes the `src/lib/web-sources/http.ts` import (that module imports `db.ts` and is equally server-only).   Market data comes from the Nasdaq delayed screener in one bulk request (real last sale, volume, market cap, sector and industry, `download=true`), with the existing Yahoo per-symbol path kept as a capped fallback.   New `--out=<path>` flag for dry runs.
- `test/universe-manifest-build.test.ts` (new, 7 tests).   Backfill to the target, no `exchange:"UNKNOWN"` and no non-`live` markers in the output, tranche provenance, alias merging without cross-CIK ticker claims, refusal below the target, zero-volume refusal, and share-class ticker normalization (`BRK.B` / `AKO/A` → `BRK-B` / `AKO-A`).
- `data/rag-universe-manifest.json` (regenerated from a live run).   Snapshot `sec-rag-2026-11-26`, 1,000 issuers, all `dataQuality:"live"`, real exchange (NYSE 608, Nasdaq 294, OTC 96, CBOE 2), real market cap and dollar volume, sector on 998, 210 alias tickers, 82 candidates quarantined with explicit reasons (76 no usable quote, 6 index symbols not in SEC's ticker list).   No `UNKNOWN` exchange and no placeholder `1` anywhere.
- `STATUS.md`: top stanza.

## 3. Decisions & Trade-offs

- **The script's server-only import chain was the real blocker.**    `db.ts` throws outside a React Server Component build, so the documented `npx tsx scripts/eval/generate-universe-manifest.ts` command could never have worked, which explains why the "live run" A4e asks for never happened.   Reading the SQLite file read-only also stops a generator from running migrations against a production database as a side effect.
- **Sentinel rows are now structurally impossible, not just avoided.**   An issuer whose CIK is absent from SEC's `company_tickers_exchange.json` used to be written with `exchange:"UNKNOWN"` while stamped `dataQuality:"live"`; it is now quarantined with a reason and replaced by the next SEC listing.   The shared validator was deliberately NOT tightened to reject `"UNKNOWN"`: that would invalidate the intentionally-sentinel legacy artifacts and their schema tests, and the marker already exists in `dataQuality`.
- **Market data source switched to the Nasdaq delayed screener.**    Yahoo's `v7/finance/quote` answers HTTP 429 (`Edge: Too Many Requests`) from this server, so the old code would have quarantined every issuer and written an empty manifest.   The screener returns ~7,400 US listings in one request with volume, market cap, sector and industry, and is already the repo's established keyless provider.   Yahoo remains only as a fallback, unchanged in behavior.
- **Backfill plus the seeder's own contract.**   Quarantine used to happen after the 1,000 cap, so a run could write a sub-1,000 manifest; `loadManifest` in `src/lib/rag/sec-ingest-seeder.ts` validates with the default `expectedIssuerCount` of 1,000 and would refuse it.   The builder now backfills and validates against the count it promised, so the generator's `1,000` target is exactly what the seeder accepts.
- **Composition change is deliberate.**   868 of the 1,000 tickers are unchanged; 132 swaps mostly replace warrants, units and micro-caps (for example `CCXIW`, `AFJKU`) with operating companies that have verified quotes.   Research-priority is 0 in this artifact because the server lane has no local `data/app.db`; the generator reads whatever DB it is pointed at, so a run on the host that holds the production DB restores that tranche with no code change.   `selectionMethod` in the committed JSON states this honestly.
- **Not done here:** the audit chain-tip table (ST-4667 item 4, still unstarted and not an Appendix A/D "backend batch 2" row), and no other backend batch 2 rows exist in the reconciliation appendices.

## 4. Verification State

```
npx tsc --noEmit
# exit 0, no output

npx vitest run test/notional-in-last-minutes.test.ts test/daily-execution-stats.test.ts \
  test/daily-notional-reset.test.ts test/account-scope.test.ts test/placement-reconcile.test.ts
# 5 files passed, 42 tests passed

npx vitest run test/rag-universe-manifest-committed.test.ts test/rag-universe-manifest.test.ts \
  test/universe-manifest-build.test.ts test/notional-in-last-minutes.test.ts
# 4 files passed, 24 tests passed

node_modules/.bin/tsx scripts/eval/generate-universe-manifest.ts --out=/tmp/manifest-live.json
# Emitted 1000 live issuers (research-priority 0, index-member 505, market-cap-liquidity 495; 998 with sector)
# Quarantined 82 candidate(s): 76x no usable market quote; 6x index symbol not in SEC company_tickers.json
# Manifest frozen successfully! Wrote 1000 issuers (3 source receipt(s))
```

`npm run lint` is recorded in the lane hand-off (0 errors).   Full `npm test`, `npm run build` and `xcodebuild` were deliberately NOT run: this lane's rules reserve the serialized full gate for the lead, and no Swift was touched.

## 5. Next Steps & Blockers

- **OWNER MERGE REQUIRED (CODEOWNERS).**    `src/lib/db-execution.ts` is a money-path file.   The PR must be marked ready with that note and must not be auto-merged or enqueued.
- Optional operator follow-up: re-run the generator on the host that holds the production DB so the research-priority tranche reflects real trading history, then commit the refreshed artifact.   The command is unchanged: `npx tsx scripts/eval/generate-universe-manifest.ts`.
- The Yahoo fallback could not be exercised from this host (429).   The Nasdaq path is the one verified live here.
- No re-freeze schedule exists for the manifest; market figures age from the `generatedAt` stamp.   A periodic operator re-run is a separate decision.