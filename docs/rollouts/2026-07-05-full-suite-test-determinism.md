# 2026-07-05 — Full-suite test determinism: kill real-network scans + import-cost flakes

## Summary

Fixed the intermittent full-suite failures observed during a 2026-07-05 local `land.sh` run
(3 timeouts across 254 files; all pass solo):

- `test/order-confirmation-status.test.ts` — both `executeProposal` tests hit ~30s timeouts.
- `test/chat-orchestrator-search-knowledge.test.ts` — first test hit ~25s against the 20s default.

Also hardened `test/approval-lock.test.ts`, the previously-recurring offender of the same class
(its 2026-06-21 "fix" only padded timeouts to 20s; the underlying cause was untouched).

## Root causes (measured, not guessed)

1. **Real network in `executeProposal` tests.** `executeProposal` calls `scanMarket(...)` on the
   approval path. Nothing in `src/lib/market.ts` / `src/lib/data-providers.ts` is test-gated, so
   these "unit" tests ran a REAL Nasdaq-screener fetch + Yahoo quote-only fallback + enrichment
   cascade — each fetch with a 6–8s abort timeout and a 429-retry backoff (`fetchWithRetry`).
   Measured solo: **~12–13s per test** (`does NOT mark…placed` 12.96s, `marks…placed` 11.92s).
   Under full-suite load (vitest `maxWorkers: 4`, other files also on the network, shared
   provider rate limits, CPU contention) that reliably crosses even the padded 30s budget.
   `vi.resetModules()` per test additionally re-evaluates the whole strategy module graph.

2. **Module-graph import cost charged to a test body.** In the chat-orchestrator file, each test
   did `await import("../src/lib/chat/orchestrator")` — a graph that pulls in effectively the
   whole app (vector-db → Pinecone/Voyage SDKs, data-providers, broker, memory stores). Only the
   FIRST import pays; measured solo it took **15.5s inside the first test's 20s `testTimeout`**
   (file duration 21.7s, transform 9.9s). Under 4-worker contention it exceeds 20s → flake.

## Fix (no blind timeout bumps)

- `test/order-confirmation-status.test.ts` + `test/approval-lock.test.ts`: partial-mock
  `../src/lib/market` via `importOriginal` — **only `scanMarket` is stubbed** (returns a minimal
  fresh AAPL scan so policy.ts price/staleness gates still see a quote); `mergeQuoteData` and all
  other exports stay real. The scan is incidental to what both files verify (broker order-state
  confirmation; the TOCTOU run-lock). The Alpaca SDK was already mocked — this closes the one
  remaining live-network hole. The existing 30s timeouts are kept as contention headroom but the
  comments now state what they actually cover (resetModules re-import under CPU load).
- `test/chat-orchestrator-search-knowledge.test.ts`: hoisted the orchestrator import into
  `beforeAll(async () => { orchestrator = await import(...) }, 120_000)` — one-time setup cost
  now has its own explicit budget instead of being charged to the first test's 20s. Test bodies
  are now millisecond-fast. Behavior-safe: the module was already shared across tests (no
  `resetModules` in this file), and `RAG_CITATION_STALENESS` is read per call, not at import.

## Measured after

Three files together: **12/12 pass, tests 1.11s total** (previously ~25s+ of wall per run solo).
The reject/accept tests dropped from ~12–13s each to 490ms/23ms; approval-lock's throw-tolerant
tests from up-to-20s to <20ms.

## Files

- `test/order-confirmation-status.test.ts` — scanMarket partial mock + accurate timeout comment.
- `test/approval-lock.test.ts` — same scanMarket partial mock.
- `test/chat-orchestrator-search-knowledge.test.ts` — beforeAll import hoist (120s hook budget).
- `docs/EFFORT-LOG.md` + `/Users/jay/apps/TRADING-EFFORT-LOG.md` — board rows.
- `STATUS.md`, this note.

## Verification

```bash
npx vitest run test/order-confirmation-status.test.ts --reporter=verbose   # before: 12.9s/11.9s tests
npx vitest run test/chat-orchestrator-search-knowledge.test.ts --reporter=verbose  # before: 15.5s first test
npx vitest run test/order-confirmation-status.test.ts test/approval-lock.test.ts \
  test/chat-orchestrator-search-knowledge.test.ts --reporter=verbose       # after: 12/12, tests 1.11s
npm run lint        # 0 errors (308 grandfathered warnings)
npx tsc --noEmit    # clean
npm test            # full suite — see STATUS.md for result
npm run build       # see STATUS.md for result
```

## Follow-ups / risks

- Other test files may still make live provider calls (the class is only closed for the three
  `executeProposal`/orchestrator files diagnosed here). If new full-suite flakes appear, check
  for unmocked `scanMarket`/enrichment paths first — the pattern and the fix shape are here.
- The chat-orchestrator `beforeAll` budget (120s) is deliberately generous for cold-cache CI
  workers; it does not slow warm runs.
