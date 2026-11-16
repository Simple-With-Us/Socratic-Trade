# Free data gaps: deep history, Form 4, Senate eFD

## Context & Objective

Three free-tier holes were still leaving dashboard fields thin.  Massive free aggregates stop near two years, so a five-year daily request could win the cascade with a truncated series, and Stooq is already out because the server blocks it.  `insiderSentiment` stayed partial across a large symbol set because the Form 4 atom pass defaulted to 60 filings and then sliced the watchlist to 20.  `senateTrades` had a Senate eFD scraper, but Congress.Trade-first mode never used it when the primary source failed.

## Changes Made

Deep daily OHLC (`lookbackDays` above 730, including the 1825-day default) skips Massive.  The live order is imported EOD, App A, Yahoo chart `range=max` under `withProviderLimit("yahoo-finance")`, Tradier history, Twelve Data, then Alpaca, Robinhood, ROIC, Tiingo, and Marketstack.  Lookbacks of 730 days or less keep the previous broker-first order, including Massive and Yahoo `range=1y`.  Both Yahoo ranges use that pacer because they share the chart host.  The abort timer starts after the slot is acquired.  Twelve Data responses pass `TwelveDataTimeSeriesSchema` before bars are built.  SQLite `history_cache_eod` remains a permanent upsert with no age delete.  On a deep request a fresh local series returns with no network when its oldest bar is on or before the requested start, or when a prior `range=max` fetch stored `history:listing-start:<symbol>` and the cached series still starts on or before that date.

Insider refresh still runs from the existing `web-source-refresh` lane (default 24h TTL).  It downloads the current SEC insider-transactions ZIP and the quarter that covers the prior 90 days, parses open-market `P` and `S` rows, and merges the Form 4 atom feed as a delta on the same accession.  The score is `round(100 * buyValue / (buyValue + sellValue))` over that window, which is `50 + 50 * (net purchases / total value)`.  Unpriced rows fall back to shares, then to transaction counts.  Signals are stored on the dataset.  `WEB_SOURCE_INSIDER_MAX_FILINGS` now defaults to 0, and 0 means the atom feed is uncapped.  The watchlist XML pass runs unless the current quarter ZIP downloaded.  A previous-quarter ZIP does not count as coverage, and the pass is not sliced to 20.  When bulk and XML share an accession, dollar, share, and transaction totals keep the larger side.  SEC requests still go through the existing limiter, and the User-Agent fallback is `Socratic Trade research jay@socratic.trade` (an explicit `SEC_EDGAR_USER_AGENT` still wins).

When `CONGRESS_TRADE_AS_CONGRESS_SOURCE` is on, a Congress.Trade error or an empty non-incremental result falls back to `scrapeSenateEfd` (agreement cookie, CSRF, PTR HTML).  A successful empty incremental poll keeps the prior dataset and does not scrape eFD.  Quiver is not called.

- `src/lib/history.ts`
- `src/lib/history-cache.ts`
- `src/lib/web-sources/insider-bulk.ts`
- `src/lib/web-sources/sec.ts`
- `src/lib/web-sources/http.ts`
- `src/lib/web-sources/sec-facts.ts`
- `src/lib/web-sources/congress.ts`
- `src/lib/source-settings-catalog.ts`
- `test/history.test.ts`
- `test/web-sources-sec.test.ts`
- `test/web-sources.test.ts`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-9-web-sources.md`
- `STATUS.md`
- `PLAN.md`

## Decisions & Trade-offs

A live source still wins on two or more bars.  Requiring the full lookback before a source wins would drop the existing two-bar fixtures through to Marketstack.  The coverage gate applies only to the SQLite early return on deep requests.

Twelve Data is only on the deep path.  Its key is the per-user `twelvedata` service (`TWELVEDATA_API_KEY` migrates in; it is not read as a live env override).  Calls admit one request against the 8/minute and 800/day quota.

Cached insider signals are reused when `windowDays` matches and are not recomputed against a later `now` until the next refresh.  The TTL is 24h.

The SEC XBRL 8s budget in the enrichment cascade and the scheduler RTH cap of 3 filing bodies are 10-K/10-Q company-facts and RAG ingest.  They are not the Form 4 sentiment path and were left unchanged.

Bulk ZIP parsing keeps only in-window `P`/`S` filings, and each submission, owner, and transaction row is checked with a Zod schema before it is aggregated.  The collapsed filing is checked again with the exported strict `BulkInsiderFilingSchema`.  `BulkInsiderFiling` is `z.infer` of that schema.  An undeclared key fails the parse.  A 404 on the ZIP does not wipe the atom path.  The 1825-day default is unchanged from main's hardcoded start.  Callers that want the short cascade pass `lookbackDays` of 730 or less.

Review follow-up for PR #4661 (board `b53cc5f8970c469e8f561767c35fc334`).  A later pass merged `origin/main` at `79df823d` (motion lockfile only).  No source conflicts.

Senate HTML uses the browser User-Agent already on `scrapeSenateEfd`, not the SEC research User-Agent.  PTR detail fetches stay paced at 350ms.

## Verification State

Each block below is only `npm run lint`, `npx tsc --noEmit`, `npm test`, and `npm run build`, in that order.  The next four sentences are that block's pass or fail, in the same order.  Targeted file runs are prose after the four statuses, never a fifth command in the block.

First pass on this branch:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings on the first pass; a second pass after the mock fixes was 0 errors and 867 warnings, then the new unused fetch argument was referenced).  `npx tsc --noEmit` pass after the test-type fixes.  `npm test` fail (full suite, no fast mode): 29 failed, 9278 passed, 51 skipped, 826 files, about 19 minutes.  The wrapper can exit 0 while vitest prints failures; this run's log ended `EXIT:1`, and the `Tests ... failed` line is authoritative.  `npm run build` pass.  It compiled with the existing warning backlog and collected page data.

Six of those `npm test` failures were this diff and are fixed:

- `test/congress-share.test.ts` expected the old count score 75.  Unpriced rows with shares now score `12000/14000` = 86.
- `test/sec-facts.test.ts` and `test/sec-ingest-worker.test.ts` mocked `web-sources/http` without `secUserAgent`, which `ingestCompanyFacts` now calls.

The other 23 failures are this cloud shell, not this diff: OpenRouter and native LLM routing tests see a configured key (`chat-llm`, `llm-provider`, `framework-review`, `red-team`, `openrouter-credits`); Pushover and email tests see injected notify credentials; `cpuprofile-summary` cannot load a `.ts` module under Node 22; `server-metrics` does not treat this VM as the local host; Alpha Vantage mid-chunk fast-stop counted 3 fetches instead of 2.  None of those files are in this diff.  Targeted history and web-source tests on that pass, outside the block: 63 passed.  After the full suite, the three files the new score and User-Agent import broke were fixed and re-run: 144 passed.

Review follow-up (`origin/main` was already merged, no merge commit):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 1 failed, 9310 passed, 51 skipped, 826 files.  The failure is `test/egress-guard.test.ts` resolving `https://discord.com` with real DNS.  This shell cannot resolve that host.  The file is not in this diff.  `npm run build` fail on that pass because the build was not run.  Targeted history and web-source tests, outside the block: 67 passed.

Schema colocation after merging `origin/main` (`79df823d`):

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 1 failed, 9311 passed, 51 skipped, 826 files.  The same discord.com DNS failure remains.  That file is not in this diff.  `npm run build` fail.  It compiled with warnings in 82s, then the process was killed (exit 137) during Next.js "Running TypeScript".  Standalone `tsc --noEmit` had already passed.  Hosted `verify` runs the real build.  Targeted history and web-source tests, outside the block: 68 passed.

Merged `origin/main` at `82162336` (PR #4663) with no conflicts, then answered the two open Kody threads:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings on the full tree before the test edit; eslint on `test/web-sources-sec.test.ts` pass after it).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9318 passed, 51 skipped, 827 files.  `test/egress-guard.test.ts` cannot resolve discord.com.  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from this workspace's stored coverage report.  Neither file is in this diff.  Hosted `verify` passed on `9b61310b`.  `npm run build` pass.  It compiled with the existing Edge warnings, finished TypeScript, and generated 43/43 static pages.  Targeted history, web-source, liveness, and halt-cause tests, outside the block: 91 passed.

`parseInsiderBulkTables` only accepts TSV tables, so the negative case injects the strict-schema rejection (an undeclared `extra` key) at the `safeParse` call the parser already makes.  The returned list is empty.  Removing that call would leave the NVDA filing in the result.

Merged `origin/main` at `1588bae8` (PR #4658 keyless options enrichment) with no conflicts.  No migration renumber.  The twelve review threads on PR #4661 were already resolved.  Kody's last note on the verification thread still called the first block and two build lines non-conforming, so those blocks now label every command pass or fail in order.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 866 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9342 passed, 51 skipped, 829 files.  `test/egress-guard.test.ts` rejects `https://discord.com` because this sandbox resolves it to a private or internal address.  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from the local `data/app.db`.  The same file passes (4 tests) when `DATABASE_URL` points at an empty database.  Neither file is in the diff against `origin/main`.  Hosted `verify` passed on `7f3ff8fa` before this merge.  `npm run build` pass.  It finished TypeScript and generated the static pages.

Merged `origin/main` at `e80386d7` (PR #4665 SEC XBRL companyfacts cache) with no conflicts.  No migration renumber.  The twelve review threads on PR #4661 were already resolved, so this pass did not reply and did not resolve any thread.  Hosted `verify` on `403e0be7` passed before this merge, including lint, tsc, `npm test`, and build.  PR Autofix runs still fail before any job.  The caller matches `origin/main`, and review events read the workflow from the default branch.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 854 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 1 failed, 9355 passed, 51 skipped, 830 files.  The failure is `test/egress-guard.test.ts` resolving discord.com.  That file is not in the diff against `origin/main`.  `npm run build` pass.  It compiled, finished TypeScript, and generated 43/43 static pages.

Merged `origin/main` at `a3d21b73` (PR #4666 SQLite storage hygiene) with no conflicts.  No migration renumber.  Twelve review threads were already resolved.  Kody then opened `PRRT_kwDOS7mOVM6sljq3` on the five PR #4665 `PLAN.md` rows, which match `origin/main`.  No authorizing board reservation is on file for that work.  Review-finding `cce9cf96` was filed during the #4665 review and was not attached.  This PR's own PLAN rows cite board `b53cc5f8970c469e8f561767c35fc334`.  The thread stays open.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 854 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9368 passed, 51 skipped, 831 files.  `test/egress-guard.test.ts` rejects discord.com because this sandbox resolves it to `198.18.0.1` (benchmark space).  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from the local database.  Neither file is in the diff against `origin/main`.  `npm run build` pass.  It compiled, finished TypeScript, and generated 43/43 static pages.

Merged `origin/main` at `2656320f` (PR #4668 Tradier sandbox HTTP 400) with no conflicts.  No migration renumber.  One unresolved thread remains: `PRRT_kwDOS7mOVM6sl4tA`.  Kody asks for a board hash on the SQLite storage hygiene row (`cursor/sqlite-storage-hygiene-181a`, PR #4666) and the matching STATUS section.  Those rows already match `origin/main`.  `board list --search` for that effort returns no reservation.  `docs/rollouts/2026-10-14-sqlite-storage-hygiene.md` records that the fleet board claim was blocked.  This pass did not insert a hash and did not resolve the thread.  Required checks on `a45a2b60` were green.  `.github/workflows/autofix.yml` is identical to `origin/main`.  Review-triggered runs still fail before any job, and `gh run view --log-failed` has no log.  Review events read the caller from the default branch.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 854 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9392 passed, 51 skipped, 831 files.  `test/egress-guard.test.ts` rejects discord.com because this sandbox resolves it to benchmark space.  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from the local database.  Neither file is in the diff against `origin/main`.  `npm run build` pass.  It compiled, finished TypeScript, and generated 43/43 static pages.

`origin/main` at `2656320f` was already contained.  No migration renumber.  Two Kody threads stay open.  `PRRT_kwDOS7mOVM6sl4tA` still wants a board hash on the SQLite hygiene row.  `board list` has no reservation for that effort.  `PRRT_kwDOS7mOVM6sms8E` wants a board hash and a PR id on the Tradier sandbox rows.  Those parentheticals now cite PR #4668 and say no board reservation is on file.  Sweep report `f5bdb15c09cf44cb903df6364d56c406` was not attached.  No hash was invented.  Hosted `verify` on `d4a22063` passed.  Review-triggered Autofix still fails before any job, and `gh run view --log-failed` has no log.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 854 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in this shell: 2 failed, 9392 passed, 51 skipped, 831 files.  `test/egress-guard.test.ts` rejects discord.com because this sandbox resolves it to benchmark space.  `test/data-catalog-completeness.test.ts` sees `peRatio` completeness 1 from the local database.  Neither file is in the diff against `origin/main`.  `npm run build` pass.  It compiled, finished TypeScript, and generated 43/43 static pages.

GB-Trader shepherd (CURSOR cloud, 2026-10-15).  `origin/main` was already contained at `df7e6d10`.  Local merge commits `1dc39c4e` and `5ee168ce` reconcile divergent history with no code conflicts.  Kody Rule 35 on this rollout block is fixed: the verification section no longer defers `npm run build`.  Open PLAN.md threads (`PRRT_kwDOS7mOVM6sl4tA`, `PRRT_kwDOS7mOVM6sms8E`, `PRRT_kwDOS7mOVM6sljq3`) are answered in PR review replies.  Those rows match `origin/main` from merge noise.  No board reservation exists for hygiene or Tradier sandbox work.  This PR's rows cite board `b53cc5f8970c469e8f561767c35fc334`.

```bash
npm run lint
npx tsc --noEmit
npm run build
```

`npm run lint` pass (0 errors).  `npx tsc --noEmit` pass.  `npm run build` pass (compiled, TypeScript finished, 43/43 static pages).  Full `npm test` was not re-run in this shepherd shell.  Hosted `verify` on the pushed HEAD is the merge gate.

## Codex Autofix pass 2026-10-15 (merge main, no new findings)

No new review items.  All 16 review threads were already resolved before this pass.  The three newest `kody-ai` comments (01:48, 02:53, 03:31) carry no findings, and no `cursor[bot]` or Codex review comments exist on the PR.  Round cap was 7 of 10 `[codex-autofix]` commits, so this pass ran.

The branch was 1 commit behind `origin/main`, and GitHub reported `mergeable: CONFLICTING` / `mergeStateStatus: DIRTY`, which blocks the required `verify` check and therefore auto-merge.  Merged `origin/main` (`3f4ef5e5`, PR #4698 honest approve).  Both `git merge-tree --write-tree` and a trial merge in a scratch worktree returned a clean merge, so the GitHub `CONFLICTING` flag was stale rather than real.  No conflicts, no manual resolution.  Both sides' `STATUS.md` and `PLAN.md` entries survived.  `package.json` did not change, so no `npm install` was needed for the merge.

```bash
npx tsc --noEmit
npm test
npm run build
```

`npx tsc --noEmit` pass.  `npm test` fail in this shell: 13 failed, 9400 passed, 51 skipped, 835 files, 1249.97s.  All 13 failures are in `test/llm-provider.test.ts`, `test/chat-llm.test.ts`, `test/framework-review.test.ts`, and `test/openrouter-credits.test.ts`.  They assert "no LLM key configured" while this sandbox exports an `OPENROUTER_API_KEY` (value redacted), so the resolver returns OpenRouter instead of the expected native endpoint.  Baseline proof: the same 4 files were run against pristine `origin/main` in a separate worktree and reproduced exactly 13 failed / 47 passed, matching the branch run.  None of the 4 files is in the PR diff, so the PR introduces zero test regressions.  Earlier passes recorded a different environmental pair (`test/egress-guard.test.ts`, `test/data-catalog-completeness.test.ts`); those are sandbox-resolution and local-database artifacts and also absent from the diff.  `npm run build` pass (compiled, finished TypeScript, 43/43 static pages).  `npm run lint` was not re-run in this shell; hosted `verify` is the merge gate.

Follow-up merge `origin/main` at `2075c857` (PR #4696 ST-4531 Slack retirement) with no conflicts.  GitHub had gone `DIRTY` again until this tip was on the branch.

2026-10-15 CURSOR: GitHub `CONFLICTING` / `DIRTY` again when `main` reached `e3ba1507` (#4716 iOS CI hygiene).  `git merge origin/main` clean (PLAN.md, STATUS.md auto-merged).  Not obsolete — branch was one commit behind base.  Fleet recall: stale GitHub mergeability under fast `main` pushes is common; local merge is tiebreaker.

2026-10-15 CURSOR (GB-Deployer): `main` at `49a76da4` (#4695 Congress push receipt).  Clean merge; `STATUS.md` auto-merged only.

GB-Trader shepherd (CURSOR cloud, 2026-10-15): reconciled local merge of `e3ba1507` (#4716) with remote `dc81c55a` (#4695) into one push tip.

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

`npm run lint` pass (0 errors, 855 warnings).  `npx tsc --noEmit` pass.  `npm test` fail in cloud shell (25 failed, environmental).  PR file subset: 215 passed in six files.  `npm run build` pass (43/43 static pages).  Hosted `verify` on pushed HEAD is the merge gate.

## Next Steps & Blockers

Ask Kody to re-review after thread replies.  Do not merge from this lane.  Do not deploy.  PR Autofix remains red on every review event.  `AI-Fleet-Coordinator` `pr-autofix-reusable.yml` line 163 uses `secrets` in a step `if` at the pin `2e671004` and still on coordinator `main` (`7508b399`).  The caller matches `origin/main`, and review events read the workflow from the default branch, so a pin change on this branch does not clear those runs.

Board row `b53cc5f8970c469e8f561767c35fc334` is claimed in progress by GROK.  Fleet Linear team ST was not moved.  `AGENT_SEAT` is unset on this cloud seat, and the board file used `--by GROK` because that is the seat writing the PR.  Do not mark the row completed until the PR merges.

## Zero-Code Findings

Stooq was already removed from the cascade; `parseStooqCsv` remains for imported files.  `history_cache_eod` was already a permanent upsert, so "cache historical bars permanently" did not need a new table or a retention delete.  The insider partials were the catalog default of 60 atom filings plus `.slice(0, 20)` on the watchlist, not the XBRL time budget or the RTH filing-body cap.  Direct Quiver access stays retired.

## Merge-main and review follow-up (MM takeover, 2026-10-16)

Cursor's shepherd errored with no handoff, so MM picked this up from the PR diff
and description and worked the review findings directly.

`origin/main` (`a5d45401e`) is merged with a merge commit — no rebase, no
force-push.  No conflicts.

**Findings addressed.**

`STATUS.md` printed the literal prefix of the sandbox `OPENROUTER_API_KEY`.  It
now reads `(value redacted)`, so the line still describes the environment
without committing any characters of the key.  The 13 failures it describes are
unaffected: they are environmental and reproduce on pristine `main`.

`src/lib/history.ts` — `TwelveDataBarSchema` and `TwelveDataTimeSeriesSchema`
used `.passthrough()` without justification.  `.strict()` was rejected on
purpose rather than applied: `fetchTwelveData` treats a `safeParse` failure as a
provider outage and returns null, so one unmodelled upstream key would silently
drop every Twelve Data lookback rather than surface as a type error.  The
rationale is now recorded above both schemas and the documented top-level `meta`
block is modelled explicitly, so known upstream drift stays visible in the type
instead of being absorbed invisibly.

`PLAN.md` and `STATUS.md` — the Tradier sandbox 9:46am entry named only its
branch.  It is PR #4685 (merged as `174cc06eb`), and no board reservation was
ever filed for it, so both entries now read `PR #4685` plus
`no board reservation on file` instead of inventing a board id.  `PLAN.md` also
carried that entry twice; the duplicate was removed.

2026-10-16 CLAUDE (autofix), third round.  Kody's re-review confirmed the two
open threads as addressed with no further code change — the `.passthrough()`
rationale (the rule's justified-passthrough limb, not an omission) and the
`PLAN.md` Tradier entry naming PR #4685.  It surfaced one genuinely new item,
the same defect class fixed in `STATUS.md` last round: the verification block
above still printed the literal `OPENROUTER_API_KEY` prefix.  It now reads
`(value redacted)`, matching `STATUS.md:73` and removing the inconsistency with
the follow-up section below.  A full-repo search for the key prefix returns zero hits.
This branch is squash-merged per protocol, so the intermediate commits that
carried the prefix collapse away; under a history-preserving merge the prefix
would stay reachable and the key should be rotated.

## Autofix round and the heading that reintroduced the prefix (MM, 2026-10-16)

The `claude[bot]` autofix round correctly redacted a second occurrence of the
key prefix in this file's verification block.  Its own new `STATUS.md` heading
then named the prefix literally, which put the very string the finding is about
back into the repository.  The heading now reads "last API-key prefix in the
rollout note".

No credential material was exposed either way — a provider prefix with nothing
after it is not a key — but the point of the finding is that credential-shaped
strings should not be committed at all, and leaving it would simply earn the
same finding again on the next review.

## Merge-main and the search sentence that named the prefix (CLAUDE, 2026-10-16)

Merged `origin/main` (`d1053ad69`) with no conflicts.  The main side touched
`src/lib/db.ts`, `src/lib/strategy.ts` and the new `sqlite-slow-timing` module,
none of which this PR changes.

Two prose sentences, one above in this note and one in `STATUS.md`, still
printed the literal key prefix inside "a full-repo search for ... returns zero
hits".  That repeated the defect and made the claim false.  Both now say "the
key prefix", and `git grep` for it over the merged tree returns nothing.

Verification, on head `e40696cd1` (the merge plus this scrub).  The trio ran in
hosted CI run 38993685733, job `verify-hosted`, not in the local lane, which has
no `node_modules`:

- `npm run lint` -> pass
- `npx tsc --noEmit` -> pass
- `npm test` -> pass
- `npm run build` -> pass
- required `verify` and `gitleaks` -> pass
- `git grep` for the key prefix over the merged tree -> zero hits
- conflict-marker grep on the touched files -> none
