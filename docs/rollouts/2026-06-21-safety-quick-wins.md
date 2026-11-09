# 2026-06-21 — Failure-mode review + safety quick-wins

## Summary

Two things landed on branch `chore/safety-quick-wins`:

1. **A failure-mode review** (`docs/reviews/2026-06-20-failure-mode-brainstorm.md`):
   a 12-agent brainstorm across distinct failure dimensions (money path,
   real-money safety, risk controls, LLM loop, persistence, market data,
   concurrency, security, architecture, error handling, testing, operational) →
   114 raw findings → ~70 distinct risks, followed by a 5-agent adversarial
   verification of the Top 5 (4 confirmed; 1 — "synthetic stops place real orders
   with no risk gate" — substantially overstated, crit → low, because the sim
   guard *is* the gateway abstraction).

2. **The first batch of quick-win safety fixes** — all localized, defensive, and
   with no intended behavior change to the money path.

## Why

The brainstorm was requested to surface latent risk before it bites real money.
The quick-wins are the same-day, high-confidence subset; the dangerous structural
items (auth layer, execution-section atomicity, circuit breaker, boot interlock)
are intentionally deferred to reviewed PRs with tests.

## Changes

- `src/lib/db.ts` — after `journal_mode = WAL`, added `busy_timeout = 5000` and
  `synchronous = NORMAL`. With WAL a concurrent writer otherwise throws
  `SQLITE_BUSY` immediately (→ intermittent 500s / aborted mid-write sequences);
  now waits up to 5s for the lock.
- `src/lib/strategy.ts`:
  - Wrapped the bull and bear `JSON.parse` of the LLM response in `try/catch`.
    The bull path degrades to zero proposals for the tick; the bear path reuses
    the existing `fallbackToBull` so a malformed critique no longer discards
    already-valid bull proposals or crashes the whole autonomous run.
  - Fixed `bearSystemPrompt` join: `].join("\\n")` (literal backslash-n,
    producing a run-together prompt) → `].join("\n")`, matching the bull prompt.
  - Added `clampConfidence()` and applied it in `sanitizeProposals` so the
    LLM-supplied `confidenceScore` (which deterministically drives position size)
    is clamped to [1,100]; also added `minimum`/`maximum` to the bull JSON schema.
- CI activation: `git mv ci-pending/{ci,e2e,security}.yml .github/workflows/` and
  removed the now-stale `ci-pending/README.md`. Node pin (24) matches local
  toolchain (`v24.16.0`).
- Docs: `docs/reviews/2026-06-20-failure-mode-brainstorm.md` (new),
  `STATUS.md` (Active Focus entry), this rollout note.

## Verification

Run in the isolated worktree `~/Code/agentic-trading-safety-pr` (off clean
`main` @ 26b05a6, `node_modules` hardlinked):

- `npx tsc --noEmit` — clean.
- `npm test` — 390 passed (49 files).
- `npm run build` — succeeded.

## Process note (multi-agent collision)

This work was originally started in the `main` integration worktree, but an
active concurrent edit session there (the `AccountCapabilities` feature spanning
`alpaca.ts`, `policy.ts`, `robinhood.ts`, `types.ts`, `db.ts`, `strategy.ts`) was
intermingling with these edits in `db.ts`/`strategy.ts`. Per the owner's
decision, the safety work was rebuilt in this isolated worktree off clean `main`,
and the stray edits were reverted out of the integration worktree so the
in-progress feature is untouched. Reinforces the AGENTS.md rule: do money-path /
shared-file work on its own branch+worktree, not in the live integration tree.

## Follow-ups (deferred, from the review)

- **Auth layer** (Top #1, confirmed high): `middleware.ts` deriving a trusted
  principal; gate all mutating routes + the SSE stream. Until then, don't expose
  over the tunnel without an upstream auth proxy.
- **Execution-section atomicity** (Top #4/#5, confirmed high): CAS proposal claim
  before the broker call; per-user in-flight guard + CAS stop claim for synthetic
  stops; deterministic `refId`.
- **Portfolio circuit breaker** (#7): drawdown/daily-loss → `close_only`/halt;
  wire the currently-dead kill-switch branch.
- **Boot-time autonomy interlock** (Top #3): env opt-in / per-boot armed token so
  a restored/copied DB can't silently resume live execution.
- **Push blocker:** CI workflows can't be pushed until the GitHub token is
  re-scoped — `gh auth refresh -h github.com -s workflow`.
