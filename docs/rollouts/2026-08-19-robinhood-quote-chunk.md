# 2026-08-19 — Chunk Robinhood quotes so a 250-name gather can price

## Context & Objective

#2848 is live.  Roth Manual Run once `9d71dda4` started 00:58:57Z, sat llm=0, then `stalled_no_progress` at 01:29:44Z.  ASC/Trading Ops: robinhood `too many symbols (max 10, got 250)` at 00:59:15Z (18s after start).  congress.trade HTTP 404 at 01:01:53Z.  Only LLM-ish call was one OpenRouter embed document.  Zero completion `llm_usage`.  account-miss 404 did not fire.  New PR (do not reopen #2848).  Goal: gather can price a 250-name / full-scan universe through Robinhood, and Manual Run once can reach an `llm_usage` row within a few minutes.

## Changes Made

`RobinhoodBrokerGateway.getEquityQuotes` sent the whole symbol list in one MCP `get_equity_quotes`.  Robinhood rejected the batch.  The catch returned `{}`, so cascade never priced through Robinhood and gather never reached Green.  Chunk every Robinhood multi-symbol read to the live max of 10.  Do not shrink the universe.  A failed chunk is recorded and skipped; other chunks still merge.  congress.trade 404 is secondary: the free enrichment wave no longer awaits App A before Yahoo/Finnhub start.

- `src/lib/robinhood.ts`
- `src/lib/data-providers.ts`
- `test/robinhood-mcp.test.ts`
- `test/data-providers.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/phase-4-market-data-scoring.md`
- `docs/phase-7-strategy.md`
- `docs/rollouts/2026-08-19-robinhood-quote-chunk.md`

## Decisions & Trade-offs

- Root-caused from the live 00:59:15Z reject (`max 10, got 250`), not another skip.  Did not reopen #2848.  Did not guess drain/embed.
- Chunk size is the live error (10), not a guessed smaller cap.  Concurrency 4 so 25 chunks do not run fully serial.
- Same 10-symbol chunk on tradability and fundamentals so those MCP tools cannot repeat the reject.
- congress.trade 404 stays logged (`ok: false`).  It must not serialize the free wave.  Did not hide it with copy.
- Did not touch #2850 / #2849 / #2841 / strategy picks.  Did not merge, deploy, or bounce.

## Verification State

```bash
npx vitest run test/robinhood-mcp.test.ts
npx vitest run test/data-providers.test.ts -t "does not fail the free wave when congress.trade 404s"
npx tsc --noEmit
```

Focused receipt: robinhood-mcp 17/17 (incl. 250-name chunk + partial-chunk survival).  congress 404 free-wave test passed.  `tsc --noEmit` clean.

## Next Steps & Blockers

- Rebased onto #2853 `df1f5a37` (same branch `cursor/robinhood-quote-chunk-befc`; did not open a second PR).  The only real conflict was `docs/phase-7-strategy.md`.  `strategy.ts` / quote-cascade did not overlap.  Jay merges.  Do not merge / deploy / bounce / TF from this seat.
- After merge, the next Manual Run once should get Robinhood prices on a 250-name universe and an `llm_usage` row within a few minutes.

## Zero-Code Findings

The 00:59:15Z robinhood reject is the gather blocker.  Background embed skip / ROIC pause from #2848 is not this stall.  congress.trade 404 at 01:01:53Z is a later miss, not the reason quotes never landed.
