# 2026-06-26 — Four-side realized-P&L + notional cross-boundary tests (improvement program item #2)

Branch `agent/claude-risk-pnl-tests`. Completes item #2 of the improvement program (risk-breaker tests landed
in PR #186; this finishes the short/cover P&L + notional coverage).

## Summary
Test-only PR (no production code changed). Closes the CLAUDE.md "verify all four `OrderSide`s explicitly" gap
for realized P&L, plus a daily-notional window-expiry case.

`test/performance.test.ts` — added to `describe("calculatePnl — short/cover")`:
- short round-trip realizes profit + **+returnPct** when cover < short; loss + **-returnPct** when cover > short
- a **partial cover** realizes only the matched chunk; the residual short marks to market (signed qty −2)
- a long closed by a **partial-then-full sell** realizes each chunk with the right returnPct
- the **all-four-side same-symbol interleave** (buy/short/sell/cover) — the critical FIFO/sign case: sell
  consumes ONLY the long lot, cover ONLY the short lot, realized = correctly-signed sum (+40), no lot erased
- **both flat-close mirrors**: cover-with-no-short and sell-with-no-long → 0 realized, the open lot untouched
- a **mixed residual long+short** on one symbol → unrealized aggregates both signs correctly (+150)

`test/daily-notional-reset.test.ts` — added to `describe("daily/hourly notional accounting — T6")`:
- a **cross-boundary** case: opening notional counts at the default `now`, but `dailyExecutionStats(...,
  FAR_FUTURE)` and `notionalInLastMinutes(..., 1, FAR_FUTURE)` both return 0 — orders age out of the day +
  rolling windows. Uses a fixed far-future Date, not `Date.now()` arithmetic.

## Why
Short/cover P&L and daily-notional are flagged high-risk in CLAUDE.md ("verify all four sides explicitly"; "check
daily-notional tracking before assuming short/cover are production-ready"). Autonomy is now treated as
potentially live, so the money-path accounting needed explicit four-side regression coverage.

## How (model-tiered subagent team)
Authored + adversarially verified by a workflow team (run `wf_a8bc4de3-253`): one author agent wrote the tests
deriving every expected value by hand and ran vitest to green; two independent verifier agents re-derived every
asserted number from first principles (one ran a **standalone Node script with no import of the implementation**
to prove the assertions are genuine derivations, not echoes of the code) and traced the interleave FIFO step by
step. Verdict: `mathCorrect: true, echoesImplementation: false, realBugs: []`. The two symmetric cases the
verifiers flagged as missing (sell-with-no-long mirror; mixed residual long+short) were then added by hand.

## Finding: no production bug
Every first-principles derivation agreed with `src/lib/performance.ts` (`calculatePnl`) and
`src/lib/db-execution.ts` (`dailyExecutionStats`/`notionalInLastMinutes`). The short/cover realized formulas,
the side-filtered FIFO matching (never consuming an opposite-side lot at $0), the returnPct sign per side, and
the opening-only notional + NY-midnight window are all correct.

## Stale-plan correction
The tracking doc claimed daily-notional "accounting/reset" needed a new test. That was stale — T6/T13 in
`daily-notional-reset.test.ts` already covered buy/short-counted vs sell/cover-exempt, tenant isolation,
estimated_notional fallback, and the boundary math. Only the cross-boundary expiry case was genuinely missing.
Doc updated accordingly.

## Files
- `test/performance.test.ts` — 7 new `calculatePnl` cases (5 from the team + 2 symmetry adds by hand).
- `test/daily-notional-reset.test.ts` — 1 cross-boundary case.
- `docs/improvement-program-2026-06-26.md` — item #2 marked DONE; stale daily-notional claim corrected.
- `STATUS.md` — new entry.

## Verification
- `npx vitest run test/performance.test.ts test/daily-notional-reset.test.ts` → 45 pass.
- Full `tsc → test → build` trio via `scripts/land.sh`.

## Follow-ups
- Remaining program items continue under a model-tiered subagent team (haiku/sonnet/opus by task): langfuse
  eval harness, RAG hybrid-BM25 + embed congress/insider, reasoning-diversity + staleness-gate, then the opus
  DO-items (multi-query/RRF, coarse-credit attribution, scheduler CAS-lease).
