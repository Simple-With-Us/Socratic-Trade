# 2026-10-14 — SEC XBRL fundamentals from cached companyfacts (default ON)

## Context & Objective

Fill missing fundamentals (ROE, ROA, gross profit margin, shares outstanding, implied market cap) from the SEC companyfacts JSON we already fetch, without blocking market scans on EDGAR.  Align docs and `source-settings-catalog.ts` on default **ON** and retire the per-scan 8s SEC fetch budget in favor of a nightly SQLite cache sweep.

## Changes Made

- `src/lib/web-sources/sec-facts.ts` — cache full companyfacts JSON under `sec_facts` (`__companyfacts_json__`); `readCompanyFactsCache` / `upsertCompanyFactsCache`; ingest stores cache before structured rows.  A non-array unit value, or a concept whose `units` is not a record, is skipped.  Sibling concepts still insert.
- `src/lib/web-sources/sec-companyfacts-sweep.ts` — nightly scheduler sweep with cursor + UTC day watermark (`SEC_COMPANYFACTS_SWEEP_PER_TICK`, default 25).
- `src/lib/data-providers.ts` — `parseCompanyFacts` extended; `SecXbrlEnrichmentProvider` reads cache only; cascade derives `marketCap` from SEC shares × live price.
- `src/lib/scheduler.ts` — `runSecCompanyFactsSweepIfDue` on scheduler tick.
- `src/lib/market.ts`, `src/lib/enrichment-coverage.ts`, `src/lib/source-capability-matrix.ts`, `src/lib/source-settings-catalog.ts` — coverage + matrix + catalog copy.
- `docs/market-data-provider-pricing.md`, `docs/source-capability-matrix.md` — operator docs.
- Tests: `test/sec-xbrl.test.ts`, `test/sec-facts.test.ts`, `test/sec-companyfacts-sweep.test.ts`, `test/data-providers.test.ts`, `test/enrichment-coverage.test.ts`.  The malformed-unit test mocks `politeFetch` with `new Response` at both call sites.

## Decisions & Trade-offs

- **marketCap** is computed in the cascade merge (not in `parseCompanyFacts`) because SEC enrichment runs parallel with quote providers; price may arrive from Yahoo in the same wave.
- **Cache row** stores JSON in `sec_facts.segment` (large payloads); structured concept rows unchanged for RAG/evidence cards.
- **Sweep** uses demand-first symbol ordering and 300ms inter-symbol delay; failure backoff 1h per batch error.  A throwing symbol advances the cursor past itself so one bad CIK cannot stall the rest of the universe.  That symbol is retried on the next full sweep after the cursor wraps.
- **Screener market cap wins** over the SEC shares × price fallback.  The cascade cannot see the Nasdaq cap, so `applyEnrichment` refuses a `sec-xbrl` marketCap when the quote already has a positive cap.
- **Evidence cards** exclude the `__companyfacts_json__` cache sentinel so it does not occupy a prompt slot.
- **Companyfacts JSON** is parsed with `CompanyFactsSchema` (passthrough, not strict).  Live filings include `cik`, `entityName`, and taxonomies other than `us-gaap` / `ifrs-full`.  A strict object would reject them.  Taxonomy maps are not `z.record(CompanyConceptSchema)`: one off-shape concept used to fail the whole document, the sweep advanced past that CIK, and every structured fact was lost.  `conceptsFromTaxonomy` keeps concepts that match and skips the rest.  A `facts` value that is not an object still throws so the worker retries.  Parse failures are not treated as a silent success.

## Main merge

`git merge origin/main` brought in `82162336` (#4663, fleet-fully-dark detector) with no conflicts.  No migration files were renumbered.  A later fetch was already up to date with that same `origin/main`.  Kody then opened thread `PRRT_kwDOS7mOVM6sjbIh` on the new `as any` fetch mocks.  Those two call sites now use `new Response`.  The thread is left unresolved.

## Verification State

Re-ran on 2026-10-14 after the `new Response` mock fix, in this order:

```bash
npm run lint -> ok (0 errors; 854 warnings)
npx tsc --noEmit -> ok
npm test -> fail (2 failed | 9315 passed | 51 skipped)
npm run build -> ok
```

The two `npm test` failures are outside this diff.  `test/egress-guard.test.ts` rejects the discord.com lookup in this sandbox.  `test/data-catalog-completeness.test.ts` sees peRatio completeness 1 because the local `data/app.db` cascade report has one filled symbol, and the scorer falls back to that report when the named universe has no durable row.  Hosted `verify` passed on `f921cc43` before this mock fix and is the merge gate.  `npx vitest run test/sec-facts.test.ts` passed (7).

## Next Steps & Blockers

- Push this branch, reply on the open Kody thread without resolving it, and comment `@kody start-review`.  Do not merge the PR from this lane.  Production picks up the sweep after merge to `main`.
- `.github/workflows/autofix.yml` still fails at startup on this branch and on main.  `pr-autofix-reusable.yml` at pin `2e671004` and on coordinator main `7508b399` both use `secrets` in a step `if`.  A pin bump does not remove that expression.  Not changed here.

## Zero-Code Findings

- Historical rollout `docs/rollouts/2026-06-25-sec-xbrl-enrichment.md` still describes default-OFF and 8s scan budget; superseded by this note for operator behavior.
