# 2026-07-17 - earningscalls-codex-triage-pickup

## Summary

Cap-reset pickup (owner-directed "restart all efforts") finishing PR #1680's Codex review
findings. All 7 unresolved chatgpt-codex-connector threads on the EarningsCalls.dev
transcript source are now addressed in code, each with a regression test. No feature scope
changed: the source still lands dormant, hard-budgeted, and rights-gated exactly as the
2026-07-16 rollout note describes.

Work provenance: a background implementation agent produced the 6 core code fixes, then
stalled before tests/docs/gate (~90 min silent; stopped and confirmed dead). The orchestrating
session adversarially reviewed every fix against the real contracts (verbatim
`StoreContextsResult` receipt contract in `src/lib/vector-db.ts:55-83`; sibling producer lease
idiom in `fmp-transcripts.ts` / `sec-filings.ts`), then wrote the tests, docs, and this note,
and ran the full gate.

## The 7 findings -> fixes

1. **P1 - EarningsCalls chunks misclassified as FMP-derived** (`src/lib/web-sources/
   fmp-transcripts.ts` `fmpTranscriptDerivedProvenance`): the shared `earnings-transcript`
   doc type alone no longer implies FMP. FMP-derived now requires the FMP source, with the
   doc-type-only fallback reserved for legacy rows carrying no source identity. Without this,
   strategy runs threw "FMP-derived strategy context has no active rights generation" as soon
   as an EarningsCalls chunk was retrieved without the FMP rights claim.
2. **Failed transcript requests were negative-cached** (`earningscalls-transcripts.ts` pass
   body): auth/rate-limit/transient failures now leave NO cache row (retryable); only answered
   responses (usable-text-free success, or a definitive transcript 404) negative-cache.
3. **Per-pass override could exceed the provider window** (`earningsCallsMaxRequestsPerPass`):
   env override clamped to a provider-safe ceiling of 6 - a rolling 31-day subscription window
   intersects <= 32 UTC-day passes, 32 x 6 = 192 <= 200; 7 would allow 224. Override can lower,
   never raise; out-of-range falls back to the default 6. `.env.example` re-derived.
4. **Unentitled FMP calendar removed every symbol** (`fmpRecentlyReportedSymbols`): now calls
   `requestFmp` directly (bypassing `getEarningsCalendar`'s null->[] normalization) so a
   402/403-unavailable calendar returns `undefined` and the latest-call-probe fallback engages;
   only a real array is an authoritative calendar.
5. **Failed probes were watermarked** (pass body): the per-symbol check watermark is recorded
   only for an answered probe (success or definitive 404). Failed probes stay retryable next
   pass; auth/rate-limit still stop the pass early.
6. **Ingest bypassed the shared RAG single-flight** (`refreshEarningsCallsTranscriptsIfDue` +
   `src/lib/scheduler.ts` comment): the whole pass (including free cached-ingest retries) now
   runs under the durable `OPERATION_LEASE_GROUPS.RAG_REINDEX` lease like the filings/FMP
   producers; a busy lease is a benign deferred pass (daily watermark moved INSIDE the lease,
   with a post-acquire due-recheck, same idiom as the FMP producer). Return type is now
   `OperationLeaseAware<EarningsCallsRefreshResult>`.
7. **Partial multi-chunk writes were marked ingested** (`ingestCachedTranscript`): completion
   now requires `storeDocument`'s full receipt - `documentComplete === true` plus exact
   `indexed === attempted` cardinality or an exact `reusedCommitted` receipt - exactly the
   contract `StoreContextsResult` documents. The coverage ledger records `attempted` (the
   proven complete chunk count).

## Round 2 (same session)

Codex re-reviewed `fd943c1` and raised one P2: the leased pass discarded the
`runWithOperationLease` callback's `claim`/`signal`, and unlike the filings/FMP producers
passed no `leaseGuard` to `storeDocument`, so a lease lost MID-pass (TTL expiry / failed
heartbeat) would not have fenced further provider calls or vector writes. Fixed with the
sibling idiom: `assertLease` (cancellation + durable-ownership check) runs before every HTTP
dispatch and each free-ingest retry, and `ingestCachedTranscript` threads
`{ signal, assertOwnership }` into `storeDocument`. A fence throw stops the pass (self-guard
records it in `result.errors`); `runWithOperationLease` independently re-asserts ownership at
the success boundary. Test extended: the receipts test now captures `storeDocument`'s options
and proves the leaseGuard wiring (AbortSignal + assert function).

## Files

- `src/lib/web-sources/fmp-transcripts.ts` - provenance classification (finding 1)
- `src/lib/earningscalls-transcripts.ts` - findings 2-7 (cap clamp, calendar fallback,
  watermark discipline, lease serialization, receipt-complete ingest)
- `src/lib/scheduler.ts` - comment-only (lease serialization documented at the call site)
- `.env.example` - per-pass cap comment re-derived for the enforced ceiling
- `test/earningscalls-transcripts.test.ts` - new "codex review fixes (PR #1680)" block:
  8 tests / all changed behaviors, incl. hoisted partial mocks for `vector-db.storeDocument`
  and `fmp-common.requestFmp` (passthrough by default so the 23 pre-existing tests are
  untouched)
- `STATUS.md`, `docs/EFFORT-LOG.md`, this note

## Verification

- `npx tsc --noEmit` - clean
- `npm run lint` - 0 errors (pre-existing grandfathered warnings only)
- `npx vitest run test/earningscalls-transcripts.test.ts` - 31/31 (23 pre-existing + 8 new)
- `npm test` + `npm run build` - full results recorded in the PR before push (run after this
  note was drafted; the commit carrying this note only lands if they pass)

## Follow-ups

- PR #1680 threads: reply + resolve each of the 7 with the fix receipts (auto-merge armed;
  resolving the last thread with green CI merges and auto-deploys - the source still lands
  DORMANT pending the owner's RapidAPI subscription).
- The stalled implementation agent's disappearance (no completion notification, no transcript
  tail) is a session-tooling curiosity, not a repo issue; no repo-side action.
