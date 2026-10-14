# Keyless options enrichment (Cboe / Alpaca / Tradier)

## Context & Objective

`nearTheMoneyIv` and `putCallRatio` were only filled by opt-in Robinhood MCP enrichment, so shared and background market scans left those cells empty.  Wire keyless Cboe delayed options JSON as the primary source, Alpaca indicative snapshots and Tradier chains as fallbacks, using the same `deriveOptionMetrics` math as `robinhood-options.ts`.

## Changes Made

- Added `src/lib/keyless-options-enrichment.ts` with `CboeOptionsEnrichmentProvider`, `AlpacaOptionsEnrichmentProvider`, and `TradierOptionsEnrichmentProvider` (per-symbol cache, paced sequential fetches).
- Registered providers in `getEnrichmentProvider()` when `KEYLESS_OPTIONS_ENRICHMENT_ENABLED` is on (default ON).
- Updated `src/lib/source-capability-matrix.ts`, `src/lib/enrichment-coverage.ts` (`COVERAGE_OPTIONS_METRICS_FIELDS`), and `src/lib/data-catalog.ts`.
- Tests: `test/keyless-options-enrichment.test.ts`, `test/keyless-options-vendor-fetch.test.ts`, `test/enrichment-coverage.test.ts`, `test/source-capability-matrix.test.ts`.

## Decisions & Trade-offs

- Three cascade providers (not one internal fallback) so per-field `sources` attribution matches the capability matrix.
- Alpaca/Tradier lanes register only when market-data / Tradier credentials resolve (same pattern as snapshot + history tiers).
- Cboe stays `costTier: "free"` (Wave A).  Alpaca and Tradier are `costTier: "paid"` so they run in Wave B only for symbols still missing `nearTheMoneyIv` or `putCallRatio`.  Those fields stay out of `WAVE_B_GAP_FIELDS` so a missing IV does not wake Finnhub.
- Vendor JSON is parsed with Zod `safeParse` (Cboe, Alpaca snapshots, Alpaca IEX underlying snapshot, Tradier expirations, chains, and quotes).  A bad payload records a failed call and returns null.
- Alpaca reads root `impliedVolatility` and `dailyBar.v`.  Open interest is not on the snapshot payload; put/call falls back to volume.  Underlying price comes from the payload when present, otherwise an IEX stock snapshot (`feed=iex`) or a Tradier quote.  A Tradier `underlying` ticker string is not treated as a price.
- Empty metric results are negative-cached for `min(TTL, 5 minutes)`.  Unexpected throws are not cached.
- Cboe fetch uses `fetch` with redirect follow (CDN → `cdn-api.cboe.com`); Alpaca/Tradier use `politeFetch` to avoid a `data-providers` import cycle.

## Verification State

- npm run lint -> ok (0 errors)
- npx tsc --noEmit -> ok
- npm test -> 2 failed, 9315 passed, 51 skipped.  Failures are outside this diff: sandbox DNS for discord.com in `test/egress-guard.test.ts`, and `pruneTaskJournal` at 238ms against a 100ms budget in `test/event-loop-stall-hot-path.test.ts`.  Targeted options and coverage tests (43) passed.
- npm run build -> ok
(2026-10-14, cloud VM)

## Next Steps & Blockers

- None for merge; production will pick up on deploy after `main` merge (docs-only paths excluded from Coolify `watch_paths` — runtime files are in the diff).

## Zero-Code Findings

- Live Cboe options JSON for `AAPL` includes `data.current_price` and per-contract `iv` / `open_interest` / OCC `option` symbols; many deep ITM rows carry `iv: 0`, so ATM filtering in `deriveOptionMetrics` remains important.

## Review round (2026-10-14 GROK) — vendor passthrough + partial IEX snapshot

**Context & Objective.**  Unresolved Kody threads on PR #4658 asked for `.strict()` vendor schemas and a looser Alpaca IEX snapshot parse.  Sentry threads on underlying price, Alpaca IV/volume keys, and Wave B `costTier` were already fixed in `99da1478`.

**Changes Made.**

- `src/lib/keyless-options-enrichment.ts` — every vendor `z.object` is `.passthrough()` via `vendorObject`.  Alpaca IEX and option `dailyBar` fields are nested records.  `readAlpacaStockSnapshotPrice` reads `latestTrade.p`, else `dailyBar.c`, else `prevDailyBar.c`.
- `test/keyless-options-enrichment.test.ts` — extra Cboe keys still parse; partial IEX snapshot still yields a price.
- `test/keyless-options-vendor-fetch.test.ts` — ATM IV from `dailyBar.c` when `latestTrade` is omitted.
- `STATUS.md`, `PLAN.md`, this note.

**Decisions & Trade-offs.**  `.strict()` is the wrong close for live Cboe/Alpaca/Tradier envelopes; extra keys are kept.  Cboe `option` stays `z.string()` because an OCC symbol contains letters and a JSON number cannot be a valid contract id.  Threads are replied to and left unresolved.

**Verification State.**

- `git merge origin/main` — already up to date
- `npm run lint` — 0 errors, 866 grandfathered warnings
- `npx tsc --noEmit` — ok
- `npx vitest run test/keyless-options-enrichment.test.ts test/keyless-options-vendor-fetch.test.ts test/enrichment-coverage.test.ts` — 39 passed
- `npm test` — 9319 passed, 51 skipped, 1 failed outside this diff (`test/egress-guard.test.ts` sandbox DNS for discord.com)
- `npm run build` — ok

**Next Steps & Blockers.**  Comment `@kody start-review`.  Do not resolve threads.  Do not merge from this lane.

**Zero-Code Findings.**  The three Sentry threads remain valid descriptions of the pre-`99da1478` diff and are already fixed on HEAD.

## Autofix Round 1 (2026-10-14) — triage only, no code change

**Context & Objective.**  Automated fixer pass over PR #4658 to address review-bot feedback.

**Changes Made.**  None to source or tests.  Documentation only:

- `STATUS.md` — round-1 triage note added to the existing CURSOR entry.

**Decisions & Trade-offs.**  All six `kody-ai` threads were already resolved and their findings verified as genuinely fixed in `99da1478` (Zod schemas in place of the `as unknown` casts, `underlyingPrice` threaded into the Alpaca and Tradier parsers, keyed options providers at `costTier = "paid"` gap-filling on the options fields in Wave B, per-endpoint Tradier error labels, negative caching for empty chains).  Zero `[codex-autofix]` commits on the branch, so this is round 1 of 10.  The three still-open threads are from `sentry[bot]`, which is outside the set of reviewers the fixer resolves; their fixes are already in the branch, but `required_review_thread_resolution` on ruleset `17945518` blocks the merge until they are dismissed.  Escalated to the maintainer rather than resolving them unilaterally.

**Verification State.**  No source change, so no local verify trio was run — CI is the gate for this PR.

- gh pr checks 4658 -> `gitleaks` pass; `verify-hosted` pending at time of writing
- gh pr view 4658 -> `mergeStateStatus: BEHIND` (one commit behind `main`), `mergeable: MERGEABLE`

**Next Steps & Blockers.**  Maintainer to dismiss the three `sentry[bot]` threads (or authorize the fixer to).  Auto-merge is armed (`gh pr merge 4658 --squash --auto`) and will squash-merge once `verify` and `gitleaks` are green and the thread gate clears.

**Zero-Code Findings.**  Every finding from `chatgpt-codex-connector`, `kody-ai`, and `cursor` on this PR is already addressed and resolved in the branch; no actionable in-scope item remained this round.
