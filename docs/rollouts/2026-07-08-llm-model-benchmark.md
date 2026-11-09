# 2026-07-08 — LLM model benchmark script (Green + Red roles, real request paths)

## Summary

New operator script `scripts/benchmark-llm-models.ts`: benchmarks every model in the curated
catalog (`app/ui/llm-model-catalog.ts` — 17 models across 6 providers) in BOTH strategy roles
(Green/Bull proposer + Red/Bear reviewer) using the app's REAL request-building code paths, so the
owner can run one command and get an empirical latency / reliability / cost / output-validity
comparison — the same dimensions the catalog's `recommendedGreen`/`recommendedRed` flags are
derived from (see 2026-07-08-model-picker-copy-recs.md).

- **Real code paths, not a re-implementation:** `resolveLlmEndpoint` (provider/transport/key
  routing, red role via explicit `redTeamLlmModel` so the cross-family Bear default never
  redirects the target), `buildLlmRequestBody` (per-transport wire bodies incl.
  `withLlmRequestBounds` token caps + reasoning params), `llmAuthHeaders`, `llmFetchCapturing`
  (soft timeout = `strategyLlmTimeoutMs`, replies never severed — late latencies are captured
  within a bounded grace window), `extractLlmText`/`extractLlmUsage`/`detectLlmTruncation`,
  `estimateLlmCostUsd`. System prompts come from the real `buildBullSystem`/`buildBearSystem`
  with representative params. The Bull `trade_proposals` and Bear `bear_proposals` JSON schemas
  mirror the literals in `src/lib/strategy.ts` `proposeTrades` (long-only representative form)
  — keep in sync if strategy.ts changes them.
- **Realistic input pack from real data:** the Green user turn is reconstructed from the most
  recent `signal_snapshot` audit event (CandidateEvidence digests mapped back to the compact
  candidate shape `compactCandidateForPrompt` sends), the cached `last_macro_sent:<user>` macro
  block, and the latest `portfolio_snapshots` row; the Red role reviews recent
  `trade_proposals` rows. Bundled fixtures cover DBs without history. Measured pack ≈ 26KB
  (~6.9k prompt tokens on DeepSeek) — in the target band.
- **Safety:** LLM calls only. NO broker imports/interaction, NO writes to the app DB, NO audit
  writes. The app DB is opened strictly READ-ONLY (`better-sqlite3 { readonly: true }`); because
  the app's own credential resolution goes through `getDb()` (which migrates), `DATABASE_URL` is
  repointed at a throwaway scratch SQLite file before any src/lib import, and the user's LLM keys
  (decrypted from the read-only real DB + env fallbacks, mirroring the boot env→store migration)
  are seeded into that scratch DB so `resolveLlmCredential` runs the SAME path production uses.
  Providers without a credential are SKIPPED with a "no credential" mark, never a failure.
- **Metrics per model+role:** attempts, successes, timeouts, http-errors, unparseable, p50/p95
  latency, avg completion tokens, est. cost/call (app's `MODEL_PRICE_PER_M` table), schema-valid
  rate, avg proposal count, bracketStopLoss-populated rate (green). Output: console table +
  `<out>.json` (raw per-call records) + `<out>.md` (per-role ranked summary with run
  date/rounds/input-pack provenance header).
- **Cache-aware (PR #1086 coordination):** per-call records carry `cachedPromptTokens` /
  `cacheCreationTokens` and pass them into cost estimation, GUARDED optionally so the script runs
  on branches with either the pre- or post-#1086 `extractLlmUsage`/`estimateLlmCostUsd`
  signature (pre-#1086 the fields read undefined and extra args are ignored at runtime). The
  summary splits cache-COLD (round 1) vs cache-WARM (rounds 2+) p50 latency and avg cost, and the
  markdown header states the caveat: back-to-back identical prompts hit provider prompt caches,
  so warm rounds flatter vs production's spaced-out cadence (observed: DeepSeek green 631ms cold
  -> 411ms warm on consecutive rounds).

## Why

The 2026-07-08 owner directive re-derived the model-picker recommendations from actual call
history (`llm_step` + `llm_usage`), but that history is organic and uneven (zero-history models
carry no rec). This script produces the controlled, apples-to-apples empirical evidence — same
prompt pack, same schemas, same transport shaping, N rounds per model per role — that history
alone can't, so future rec updates can cite a benchmark run instead of waiting for organic calls
to accrue.

## Usage

Run from a checkout that has `.env.local` + `data/app.db` (the standby `/Users/jay/apps/trading-live`):

```bash
npx tsx scripts/benchmark-llm-models.ts                       # every catalog model, both roles, 3 rounds
npx tsx scripts/benchmark-llm-models.ts --models deepseek-v4-flash,gemini-3.5-flash --rounds 1 --role green
npx tsx scripts/benchmark-llm-models.ts --dry-run             # build+print every request, no network
# Flags: --models a,b,c | --rounds N | --role green|red|both | --out basePath | --timeout-ms N | --user id | --dry-run
```

NOTE: the standby checkout's `.env.local` no longer carries `ENCRYPTION_KEY` (secrets moved to
Infisical, 2026-07-07 Coolify migration) — DB-stored keys need it to decrypt, so run via the
Infisical loader or export `ENCRYPTION_KEY` first, e.g.
`ENCRYPTION_KEY=... npx tsx scripts/benchmark-llm-models.ts` (env keys alone also work).

## Files

- `scripts/benchmark-llm-models.ts` (new; single file)
- `docs/rollouts/2026-07-08-llm-model-benchmark.md` (this note)
- `STATUS.md`, `docs/EFFORT-LOG.md` (protocol updates)

## Verification

Run in the `monet/llm-model-benchmark` worktree:

- `npx tsc --noEmit` — 0 errors.
- `npm run lint` — 0 errors (335 pre-existing grandfathered warnings, none in the new file).
- `npx vitest run` — 288 files / 2901 tests passed (script adds no runtime surface to the app).
- Dry run (worktree, no keys): builds all 34 model×role requests with correct per-transport
  shapes (deepseek/gemini chat-completions, anthropic messages, openai responses) and per-model
  soft timeouts (60s base, 150s thinking-enabled).
- Real run against `/Users/jay/apps/trading-live` data (read-only): all 6 provider credentials
  decrypt + resolve; input pack from the real `signal_snapshot @ 2026-07-07T23:18` /
  `last_macro_sent` / latest portfolio snapshot; `--models deepseek-v4-flash --rounds 1` real
  network calls succeeded in BOTH roles (green: 749ms, valid `{"proposals":[]}`, 6889 prompt
  tokens, est $0.0010; red: ~0.5-0.7s, parsed OK), plus a `--rounds 2` green run confirming the
  cold/warm split (631ms -> 411ms). Verified the app DB file is opened read-only (better-sqlite3
  `{ readonly: true }`; the app's own getDb() only ever sees the scratch file).

## Findings from the verification calls

- **deepseek-v4-flash (red, json_object mode) emitted a bare top-level ARRAY of proposals**
  instead of `{"proposals": [...]}` in both trial calls. The app's Bear parse
  (`parsedBear.proposals ?? []`) would read that as ZERO survivors — i.e. a silent full veto —
  rather than an unparseable-fallback-to-Bull. The benchmark flags this as schema drift (with an
  output excerpt in the JSON records) while still counting the drifted items. Worth a follow-up
  look at the Bear parse if DeepSeek is ever seated as Red (it currently holds a `recommendedRed`
  flag for v4-pro).

## Follow-ups

- Full catalog run (17 models × 2 roles × 3 rounds ≈ 102 sequential calls, tens of minutes,
  small $) is the owner's call — the command is above.
- The two schema literals mirror `strategy.ts`; if the proposal schema changes, update the
  script (header comment says so).
- Consider whether the Bear parse should treat a bare-array reply as parse-drift
  (fallback-to-Bull) instead of zero survivors — surfaced by this benchmark, advisory only.
