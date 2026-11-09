# 2026-06-21 — Semantic gate + templated-fact allowlist (learned-context second classifier layer)

## Summary

Added a SECOND layer to the learned-context risk classifier: a templated-fact **allowlist** plus an
LLM **semantic gate**, wired into the ingest path. This is the expert panel's medium-term
recommendation — a keyword blocklist can be paraphrased around, so a paraphrase-resistant semantic
check now backstops it.

New module `src/lib/learned-context/semantic-gate.ts` exposes
`classifyWithSemanticGate(candidate, opts?)` (async). `ingestLearned` now calls it instead of the sync
`classifyRiskTier`. The sync `classifyRiskTier` is unchanged and still used directly by the keyword
layer, the pending queue, and existing sync tests.

## Why

The keyword classifier (`classify.ts`) catches risk vocabulary, but a user/agent can paraphrase
around it ("comfortable with much bigger swings now", "let the winners run a good while longer", "no
need to be cautious on this one") and the keyword layer returns `'fact'`. Those paraphrases still
touch risk tolerance / sizing and must not silently reach the brain as advisory facts. The semantic
gate asks an LLM "does this touch risk?" only for the residual (keyword-`'fact'`, not-allowlisted)
candidates and upgrades them to `'risk'` when warranted, routing them to the human confirmation queue.

## Design — STRICTLY ADDITIVE (the safety contract)

`classifyWithSemanticGate` runs in this order:

1. **Keyword layer first (authoritative for risk).** Run sync `classifyRiskTier`. If it returns
   `'risk'` or `'strategy-directive'`, return that immediately. The gate can only ever **upgrade** a
   keyword `'fact'` → `'risk'`; it **never downgrades** a keyword `'risk'` → `'fact'`.
2. **Templated-fact allowlist (cheap, deterministic, no LLM).** A keyword-`'fact'` matching a
   known-safe structural shape — index membership (S&P 500 / Nasdaq 100 / Dow / Russell / FTSE),
   sole/only/primary supplier-or-customer relationships, sector/industry classification,
   earnings/report-date statements, identity facts (HQ, ticker, CUSIP, ISIN) — is **definitively**
   `'fact'` and returns **without** calling the LLM.
3. **LLM semantic gate.** Otherwise (keyword `'fact'`, not allowlisted) call `getLLM()`/`ChatLLM` with
   a tight system prompt asking strictly for `{"tier":"fact"|"risk"}`. `'risk'` → upgrade; `'fact'` →
   keep.
4. **Fail-safe.** If the LLM is unavailable, throws, times out, or returns unparseable output, **fall
   back to the keyword result** (which on this path is `'fact'`). The gate never blocks all fact
   ingestion when the LLM is down, and never silently downgrades a keyword `'risk'`. It degrades to
   today's behavior.
5. **Flag.** `LEARNED_CONTEXT_SEMANTIC_GATE` (default `"on"`; any value `!== "off"` = on). When
   `"off"`, the LLM gate is skipped entirely — exactly today's behavior plus the (safe) allowlist.

### Chat hard-cap preserved

The chat-origin hard-cap lives in `store.ts`, not in the gate. A chat candidate the gate upgrades to
`'risk'` is still **DROPPED** (`chat_risk_dropped`), never queued — identical to the prior semantics.
Only autonomous/ingest risk-tier candidates route to the pending confirmation queue. An end-to-end
test pins this.

### Async plumbing

Making the gate async makes `ingestLearned` async. Threaded `await` through its callers, all already in
async contexts: `src/lib/chat/orchestrator.ts` (chat ingest loop) and `src/lib/post-mortem.ts`
(`writeThesisTrackRecordFacts`, now async, awaited inside the async `generateReflectionSummary`). The
salience producer (`extractLearnedCandidates`) is a pure extractor and did not change.

## Files

- `src/lib/learned-context/semantic-gate.ts` — NEW. Allowlist + `classifyWithSemanticGate` + flag helper.
- `src/lib/learned-context/store.ts` — `ingestLearned` is now `async` and calls the gate; takes an
  optional `opts` (injectable LLM). Routing/audit/hard-cap semantics unchanged.
- `src/lib/chat/orchestrator.ts` — `await ingestLearned(...)` in the chat producer loop.
- `src/lib/post-mortem.ts` — `writeThesisTrackRecordFacts` is now `async` + awaited.
- `test/semantic-gate.test.ts` — NEW. MockLLM (call-counting); see Verification.
- `test/learned-context.test.ts` — `await` ingest calls; flag pinned `off` in `beforeAll` (these tests
  scope the keyword + allowlist routing deterministically/offline).
- `test/learned-context-pending.test.ts` — same `await` + flag-off scoping.

## Verification

```bash
cd /Users/jay/apps/wt-semgate
npx tsc --noEmit          # clean (exit 0)
npm test                  # 82 files, 740 tests pass
npm run build             # succeeds (exit 0)
```

`test/semantic-gate.test.ts` asserts:
- keyword-dodging paraphrases (asserted keyword-`'fact'` first) → `'risk'` with a MockLLM returning
  `{"tier":"risk"}` (LLM call count = 1);
- templated facts ("ASML is the sole EUV supplier", "NVDA is in the S&P 500", Nasdaq-100, earnings
  date, HQ) → `'fact'` with the **LLM not called** (count 0);
- a keyword risk ("back up the truck on tech", "raise to 30%") → `'risk'` with the **LLM not called**
  (count 0) — even when the mock would say `'fact'` (proves no downgrade);
- LLM throws → fail-safe to keyword `'fact'`; LLM garbage → fail-safe to keyword `'fact'`;
- flag `off` → LLM not called, keyword + allowlist behavior only;
- end-to-end: a gate-upgraded **autonomous** candidate lands in the **pending queue** (not the fact
  store); a gate-upgraded **chat** candidate is **dropped** (hard-cap holds).

## Follow-ups / risks

- The default LLM provider is `getLLM()`, which is `MockLLM` unless `CHAT_LLM`/key are configured.
  `MockLLM` does not emit `{"tier":...}`, so with the default (no provider) the gate's LLM step always
  fails the parse and **fail-safes to `'fact'`** — i.e. the gate is effectively inert until a real
  provider is wired. This is intentional fail-safe behavior, but operators should know the gate only
  bites when a JSON-capable provider is configured.
- The allowlist templates are deliberately tight (anchored on structural cues). Broaden only with
  owner review — a too-loose template would let risk-adjacent prose ride in on a benign substring and
  skip the gate.
- Per the protocol, `STATUS.md` was intentionally **not** edited for this rollout (explicit instruction).
