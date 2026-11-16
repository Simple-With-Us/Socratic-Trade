# 2026-07-10 — Anthropic spend-spike investigation + benchmark script cost visibility (CLAUDE, cloud lane, branch `claude/anthropic-spend-spike-e2di8j`)

## Summary

Owner reported the Anthropic console showed spend going from ~$35 to ~$50 (~$15) in a
2-hour window while `/admin/llm-usage` (the app's own ledger) only reflected ~$35 total —
a gap between real provider billing and what the app tracks. Investigated from the
codebase (no production DB access in this cloud session — no `OPS_DIAGNOSTIC_TOKEN`
configured here) and fixed the concrete blind spot found: `scripts/benchmark-llm-models.ts`
calls the real Anthropic API through the app's real credential/request path but was
deliberately built to make **zero** writes to the app DB (readonly `realDb` + a
scratch-DB swap for `getDb()`), so a benchmark run's real billing never appears in
`llm_usage` / `/admin/llm-usage`. `scripts/eval/run-offline.ts` has the same gap
(unmodified — smaller, less likely blast radius; left as a known follow-up).

## Why

Ledger-vs-billing discrepancies are otherwise very hard to diagnose after the fact: the
provider console has no free-text attribution, and the app's own dashboard is the only
place that ties spend back to a run/context/model. Any real Anthropic call that bypasses
`recordLlmUsage` (this benchmark script, the eval harness, or any future one-off script
that reuses `resolveLlmEndpoint`) is invisible there by construction.

**Correction from the owner's later message:** the observed per-model pattern (sonnet
never called, opus dominant, ~4 scattered haiku calls) does NOT match a default
benchmark run, which hits every curated model — including sonnet — roughly evenly. That
rules out "someone ran the full benchmark sweep" as the explanation for *this specific*
spike; it's more consistent with either a benchmark run deliberately scoped via
`--models claude-opus-4-8,claude-haiku-4-5` (excluding sonnet/fable), or real production
traffic from an account whose policy has `llmModel: "claude-opus-4-8"` (fires every
strategy cycle) paired with `redTeamLlmModel: "claude-haiku-4-5"` (fires only on
risk-adding openings — "scattered" by construction, per `src/lib/red-team.ts`'s
per-opening reviewer fan-out). Not conclusively resolved without a production ledger
pull; flagged as a follow-up below rather than papered over.

## What changed

`scripts/benchmark-llm-models.ts`:

- **Total-spend rollup** (`computeSpend()` / `printSpend()`): every run now prints a
  grand total + per-provider breakdown of estimated cost to the console, and writes the
  same breakdown into both the `.json` (`spend` field) and `.md` report header — so a
  benchmark run now self-reports what it actually spent even though (by default) none of
  it touches the app's ledger.
- **Opt-in ledger write** (`--record-usage` flag, default OFF): when passed, each real
  call's usage is inserted into the REAL app's `llm_usage` table via a **dedicated
  writable connection** (`usageDb`) separate from the readonly `realDb` and separate from
  the scratch-DB-bound `getDb()` the rest of the script uses — it only ever runs the one
  `INSERT`, never migrations or any other table, so it can't reproduce the corruption
  risk the readonly design exists to prevent. Rows are tagged `user_id =
  "benchmark:<user>"` (a pretend account, per owner request, so they're never conflated
  with a real tenant) and `context = "benchmark:<role>"`, so they show up in
  `/admin/llm-usage` as their own clearly-labeled category instead of silently vanishing
  from the ledger. WAL + `busy_timeout=5000` mirror `db.ts`'s pragmas so this coexists
  safely with a concurrently-running production server on the same DB file.

## Files

- `scripts/benchmark-llm-models.ts` (only file touched).

## Verification

- `npx tsc --noEmit` — clean (one generic-inference error surfaced and fixed: `Statement.run`
  needs the `prepare<unknown[]>` generic pinned via a small `prepareInsertUsageStmt` helper,
  otherwise `ReturnType<...>` on the bare generic method collapses to an invalid rest-param type).
- `npx eslint scripts/benchmark-llm-models.ts` — 0 errors/warnings.
- `npm test` — 3395/3395 passed, 315/315 files (no test references this script).
- `npm run build` — fails identically on unmodified `main` HEAD in this sandbox
  (`Error: Failed to collect page data for /_not-found`, `TypeError: Invalid URL`,
  `input: ''`) — confirmed pre-existing via `git stash` + rebuild before making any
  change; not caused by this diff. Left uninvestigated (out of scope for this fix); flag
  for whichever session next touches the build/Sentry-edge config.
- Smoke-tested the new code path directly: `npx tsx scripts/benchmark-llm-models.ts
  --dry-run --models claude-haiku-4-5 --rounds 1 --role green` runs clean end-to-end
  (dry-run skips the ledger write path by design, but exercises `computeSpend`/`printSpend`
  and the new CLI flag parsing without touching any real DB).

## Follow-ups

- `scripts/eval/run-offline.ts` has the same "real Anthropic call, no ledger write" gap —
  not fixed here (smaller script, narrower blast radius). Worth the same treatment if it's
  used unattended/regularly.
- The per-model pattern reported (opus-dominant, haiku-scattered, sonnet-absent) still
  needs a real production `/admin/llm-usage` pull (by context + model, for the actual
  2-hour window) to confirm whether it's a scoped benchmark run or organic production
  traffic from an opus-configured account. This session had no `OPS_DIAGNOSTIC_TOKEN` to
  check directly.
