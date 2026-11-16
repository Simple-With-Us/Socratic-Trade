# 2026-07-06 - corpus-coverage-receipt

## Summary

- Added a per-run, advisory-only receipt for the strategy.ts filings-RAG pass: when a requested
  doc type (`10-k`/`10-q`/`8-k`/`earnings-transcript`) produces **zero retrieved chunks this run**
  AND the corpus has **zero ever-ingested rows** of that type (all tickers, all time), emit ONE
  `audit('rag_doc_type_coverage_empty', { runId, symbols, emptyDocTypes, requestedDocTypes })` +
  ONE kind-`safety` `SocraticEvidenceItem` ("Requested filings doc type never ingested") attached
  to the run's decision case(s).
- A doc type that simply didn't rank this run's query but DOES have ingested rows is normal
  (happens daily) and deliberately does **not** fire — only "this evidence structurally cannot
  exist yet" is worth a receipt.
- Purely advisory: never touches `ragContext`, sizing, or policy. Modeled directly on the existing
  `evidence_age_anomaly` receipt block (same `promptSafetyEvidence` array, same `audit()` call
  shape, same unconditional wiring — no flag, matching that precedent).

## Why

- Ground truth (triage-verified before implementation): `src/lib/strategy.ts`'s filings-RAG pass
  (`retrieveContextDetailed(..., { docType: ["10-k","10-q","8-k","earnings-transcript"] })`) is the
  only doc-type-requesting call site in the app, and `contexts.flatMap(chunks)` silently drops a
  zero-producer doc type with no receipt today. `earnings-transcript` is a genuine zero-producer
  right now (no ingestion writer exists anywhere in the repo for it) — this receipt makes that
  visible per-run instead of silently invisible.
- The both-conditions gate (not-retrieved-this-run AND zero-ever-ingested) is the load-bearing
  design choice: a naive "requested but empty this run" check would false-positive constantly on
  ordinary low-relevance misses for 10-K/10-Q/8-K, which DO have ingested rows most of the time.
- Discovered mid-implementation: `ingested_accessions.doc_type` is not uniformly named across
  writers. `src/lib/web-sources/sec-filings.ts` stores the raw SEC form letter (`"10-K"`/`"10-Q"`)
  matching the requested type case-insensitively, but `src/lib/web-sources/sec8k.ts` stores the
  sentinel `"8-K-body"` — never the plain `"8-K"`. A naive `LOWER(doc_type) === requested` lookup
  would therefore report **zero** ingested 8-K rows forever, even after real 8-K ingestion ran,
  which would make the new receipt false-positive on 8-K every single day. Fixed by having the
  count lookup treat any stored type whose lowercased form **starts with** the requested
  (lowercased) type as a match for that type — `"8-k-body"` counts toward `"8-k"`; `"10-k"` counts
  toward `"10-k"` exactly (no other stored type shares that prefix, so this is safe).

## Files

- `src/lib/db-learning.ts` — new `ingestedAccessionCountsByDocType()` (one `GROUP BY
  LOWER(doc_type)` query, no new table/migration) and `ingestedAccessionCountForDocType(type)`
  (prefix-tolerant lookup on top of it, documented naming-split rationale inline). Both
  re-exported via the `db.ts` barrel (`export * from "./db-learning"` already existed).
- `src/lib/prompt-safety.ts` — new pure `computeEmptyDocTypes(requestedDocTypes,
  retrievedDocTypes, ingestedCountByRequestedType)` alongside the existing
  `collectEvidenceAgeAnomalies`; module header comment updated to describe the third scanner.
- `src/lib/strategy.ts` — hoisted the filings-pass doc-type request list to
  `requestedFilingsDocTypes` (used by the existing `retrieveContextDetailed` call, unchanged
  behavior); added `retrievedFilingsDocTypes` (populated alongside the existing
  `evidenceAgeInputs` loop over `contexts`/chunks); added the new receipt block immediately after
  the `evidence_age_anomaly` block, following the same `audit()` + `promptSafetyEvidence.push()`
  shape. Added `ingestedAccessionCountForDocType` to the `./db` import block and
  `computeEmptyDocTypes` to the `./prompt-safety` import block.
- `test/rag-doc-type-coverage.test.ts` — new test file (10 tests, see Verification).
- `STATUS.md`, `docs/EFFORT-LOG.md` — pre-commit handoff updates for this lane.

## Verification

- `npx tsc --noEmit` — clean (no errors).
- `npx vitest run test/rag-doc-type-coverage.test.ts` — **10 passed / 10** (see breakdown below).
- Regression spot-checks on files/behavior this change is adjacent to — all green, no changes
  needed:
  - `npx vitest run test/prompt-safety.test.ts test/strategy-prompt-safety.test.ts
    test/strategy-rag-quickwins-wiring.test.ts test/rag-multi-query-retrieval.test.ts` — **42
    passed / 42**.
  - `npx vitest run test/sec8k-full-body.test.ts test/sec-filings.test.ts` — **31 passed / 31**
    (confirms the `insertIngestedAccession` naming-split assumption documented above against the
    real writers' own test suites).
- Did NOT run the full `npm test` / `npm run build` suite per this lane's task scope (focused
  verification only; a central operator runs full CI via `scripts/land.sh`).

### `test/rag-doc-type-coverage.test.ts` breakdown

- `computeEmptyDocTypes` (pure, 5 tests): flags only the empty-and-never-ingested type out of 4
  requested; does not flag a type with ingested rows even if missing this run; flags nothing when
  everything retrieved; flags nothing when every missing type has ingested rows; case-insensitive
  on both `doc_type` and requested type.
- `ingestedAccessionCountForDocType` / `ingestedAccessionCountsByDocType` (DB helper, 2 tests):
  reports 0 for a never-ingested type; reports non-zero for both the `"10-K"` writer shape and the
  `"8-K-body"` sentinel shape, while `"earnings-transcript"` stays 0.
- Strategy-level integration via `runStrategyOnce` with `vector-db` mocked and the local test
  broker gateway (3 tests): (b) fires exactly one audit + one evidence item naming only
  `earnings-transcript` when 2 of 4 requested types retrieve nothing and `10-q` (the other missing
  type) has a seeded ingested row; (c) does NOT fire when the only missing-this-run type
  (`earnings-transcript`) also has a seeded ingested row; (d) advisory invariant — proposal count
  and `ragContext` (`retrievedFinancialContext` in the Bull user prompt) are unchanged by the
  receipt firing, and the receipt text never leaks into `ragContext`.

## Follow-ups

- No new `earnings-transcript` ingestion writer was added — out of scope for this lane (the ground
  truth explicitly notes it's a genuine zero-producer today; this receipt only makes that visible,
  per the owner's advisory-only philosophy).
- If a future writer starts inserting `ingested_accessions` rows under yet another non-uniform
  `doc_type` naming convention (beyond the two documented here), extend the prefix-matching
  rationale comment on `ingestedAccessionCountForDocType` rather than special-casing silently.

## Correction (same day, 2026-07-06) — the `ingested_accessions`-based producer check was itself a daily false positive

A post-merge review caught that this rollout's own "Why" section above contained a load-bearing
**false claim**: it asserted 10-K/10-Q/8-K "DO have ingested rows most of the time," which is true
for 10-K/10-Q but **not** for 8-K in the default configuration. This section documents the actual
bug, why the original design was wrong, and the corrected approach. The `## Files`/`## Verification`
sections above are LEFT AS-IS (historical record of the original PR) — this section is the
authoritative account of what shipped after the fix.

### The bug

`src/lib/web-sources/sec8k.ts` has **two** independent 8-K ingestion writers, gated by different
flags:

- **8-K SUMMARY** (`refreshEightK`'s `storeContexts` call, ~line 318 and ~397 for the two call
  sites — initial dataset store + refresh-cycle store): `WEB_SOURCE_SEC8K`, **default ON**. Writes
  retrievable `doc_type: "8-k"` chunks straight to the vector corpus via `storeContexts`. **Never
  calls `insertIngestedAccession`** — it has no accession-tracking call at all, because
  `storeContexts`'s own content-hash dedup (`document_chunks`, gated on
  `VECTOR_STORECONTEXTS_DEDUP`, default ON) is what prevents re-embedding, and that table is keyed
  on content_hash/symbol/source/chunk_id — it has **no `doc_type` column**.
- **8-K FULL-BODY** (`ingestEightKBody`, ~line 489): `WEB_SOURCE_SEC8K_FULL_BODY`, **default OFF**.
  Writes via `storeDocument`, and DOES call `insertIngestedAccession(accession, "8-K-body", ...)`.

Because the summary path is the one that's actually on by default, and it never touches
`ingested_accessions`, the original receipt's "has this doc type ever been produced" check
(`ingestedAccessionCountForDocType("8-k")`) returned **0 in the default config even when the corpus
had real, retrievable 8-K chunks**. That made the receipt fire "8-k" as a false-positive coverage
gap on any day an 8-K chunk simply didn't rank in the top-3 retrieved chunks — i.e. routinely, not
rarely. This is the exact daily-false-positive failure mode the receipt exists to prevent, just
aimed at the wrong doc type via the wrong signal.

### Why `document_chunks` (the reviewer's suggested fix) doesn't work either

The reviewer's suggested primary fix was to replace the `ingested_accessions` producer-existence
check with a count over `document_chunks` (the actual local chunk-write ledger), on the theory that
ALL doc_type writers populate it. Investigated and confirmed **not viable without a schema
change**:

- `document_chunks`'s schema (`src/lib/db.ts`) is `(content_hash, symbol, source, chunk_id,
  created_at)` — **no `doc_type` column exists**, so no `GROUP BY doc_type` is possible today.
- It is also not populated unconditionally: `storeContexts` (`src/lib/vector-db.ts`) only calls
  `insertDocumentChunks` when a `dedupKeyPrefix` option is passed (true by default for the 8-K
  summary and disclosure-RAG paths via `VECTOR_STORECONTEXTS_DEDUP`, but caller-dependent, not a
  structural guarantee) — `storeDocument` (used by 10-K/10-Q and 8-K full-body) does always record
  it, so behavior differs by call site.
- Even if a `doc_type` column were added, `source`/`dedupKeyPrefix` values are not a reliable
  doc_type proxy either: `disclosure-rag.ts` uses the single prefix `"disclosure"` for BOTH
  `doc_type: "congress-trade"` and `doc_type: "insider-filing"` — ambiguous without a real column.

Adding a `doc_type` column to `document_chunks` and backfilling every writer to populate it
correctly is a real schema migration touching five+ call sites (`sec-filings.ts`, `sec8k.ts`
summary + full-body, `disclosure-rag.ts`, `experience-memory.ts`, `socratic-memory.ts`,
`vector-db.ts`'s own direct-context path) — out of scope for this fix (no scope creep) and its own
source of regression risk.

### The corrected fix

Per the task's own documented fallback for exactly this situation: **dropped the
runtime-producer-count check entirely** and replaced it with a static, hand-verified allowlist,
`COVERAGE_CHECKED_DOC_TYPES = ["10-k", "10-q", "8-k"]` (`src/lib/strategy.ts`, near the top-level
constants) — doc types confirmed by reading the writers to have an actual producer in code today
(`10-k`/`10-q` via `sec-filings.ts`'s always-on `ingestFiling`; `8-k` via `sec8k.ts`'s both writers).
`computeEmptyDocTypes` (`src/lib/prompt-safety.ts`) dropped its third parameter
(`ingestedCountByRequestedType`) and now takes only `(coverageCheckedDocTypes, retrievedDocTypes)`
— a type is "empty" simply when it wasn't retrieved this run, with no ingested-rows condition at
all. This is intentionally a coarser check than the original design (it can't distinguish "this
type has literally never once produced a chunk" from "didn't rank today" for a type that IS in the
allowlist) — but it can no longer false-positive on a producer whose write path just doesn't touch
`ingested_accessions`, which is the actual bug that mattered.

**`earnings-transcript` exclusion (Finding 2 — noise):** it remains in
`requestedFilingsDocTypes` (the literal passed to `retrieveContextDetailed`'s `docType` filter —
harmless, unrelated to the receipt) but is now deliberately **excluded** from
`COVERAGE_CHECKED_DOC_TYPES`. It has no ingestion writer anywhere in the repo, so including it in
the coverage check would fire a receipt on literally every run forever — a permanent true-but-
useless signal that trains the operator to ignore the whole receipt, masking the genuinely useful
10-k/10-q/8-k signal (e.g. a fresh account with no ingestion yet). Re-add it to
`COVERAGE_CHECKED_DOC_TYPES` the day a producer for it lands.

**Efficiency nit fixed too:** the original loop called a per-type DB helper once per requested
type (4 separate `GROUP BY` queries per run). Since the corrected design makes zero DB calls at all
(no runtime producer signal left to query), this is moot — `computeEmptyDocTypes` is now pure
in-memory set arithmetic, called once.

**Files touched by the correction:**

- `src/lib/prompt-safety.ts` — `computeEmptyDocTypes` signature narrowed to
  `(coverageCheckedDocTypes, retrievedDocTypes)`; doc comment rewritten to describe the corrected
  behavior and explain why the ingested-rows condition was removed; module header's scanner-3
  summary updated.
- `src/lib/strategy.ts` — added `COVERAGE_CHECKED_DOC_TYPES` constant (with the full rationale
  above inline); removed the now-unused `ingestedAccessionCountForDocType` import and its per-type
  loop; the coverage receipt block now calls `computeEmptyDocTypes(COVERAGE_CHECKED_DOC_TYPES,
  retrievedFilingsDocTypes)` directly; `requestedFilingsDocTypes`'s comment updated to clarify it
  is NOT the same list the coverage check uses.
- `src/lib/db-learning.ts` — `ingestedAccessionCountForDocType`'s doc comment corrected to spell out
  the caveat above (it undercounts "8-k" in the default config) and explicitly says it is no longer
  used by the coverage receipt. The function itself is UNCHANGED and kept as a general-purpose
  admin/diagnostic helper (still correct for what it actually measures: full-body accession
  counts) — not removed, since removing a still-correct, still-used-by-tests helper was unnecessary
  scope beyond the fix.
- `test/rag-doc-type-coverage.test.ts` — rewritten: `computeEmptyDocTypes` pure tests updated to the
  new 2-arg signature; added the required regression test ("(c) REGRESSION (BLOCKER fix)") that
  stores an 8-K SUMMARY chunk via the mocked retrieval path with **no** `insertIngestedAccession`
  call anywhere in the test, and asserts the receipt does NOT fire for `"8-k"` — proving the fix;
  kept a light "(d)" test asserting `earnings-transcript` never produces a receipt even though it
  always retrieves nothing; kept the DB-helper tests for
  `ingestedAccessionCountForDocType`/`ingestedAccessionCountsByDocType` (now framed as generic
  diagnostic-helper coverage, not the receipt's signal).

### Verification (correction)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/rag-doc-type-coverage.test.ts` — **11 passed / 11** (was 10; added the
  BLOCKER regression test).
- Regression spot-checks (unchanged from the original run, all still green):
  - `npx vitest run test/prompt-safety.test.ts test/strategy-prompt-safety.test.ts
    test/strategy-rag-quickwins-wiring.test.ts test/rag-multi-query-retrieval.test.ts` — **42
    passed / 42**.
  - `npx vitest run test/sec8k-full-body.test.ts test/sec-filings.test.ts` — **31 passed / 31**.
- `npx eslint src/lib/strategy.ts src/lib/prompt-safety.ts src/lib/db-learning.ts
  test/rag-doc-type-coverage.test.ts` — 0 errors, 4 pre-existing warnings in `strategy.ts`
  unrelated to this change (`isMarketOpen`/`e`/`currentPrices` unused-var grandfathered warnings).
- Did not run the full `npm test`/`npm run build` suite for this focused fix — same scope
  boundary as the original rollout; a central operator runs full CI via `scripts/land.sh`.

## Second correction (same day, 2026-07-06) — the retrieval-only design was itself a daily-noise bug

The first correction above (dropping the `ingested_accessions` producer-count check entirely, and
gating the receipt on this-run-retrieval-emptiness alone for `COVERAGE_CHECKED_DOC_TYPES =
["10-k","10-q","8-k"]`) fixed the 8-K false-positive but introduced a different daily-noise bug: it
now fires the receipt whenever an allowlisted type simply isn't RETRIEVED this run, with no
producer/corpus check at all. 8-K is event-sparse and frequently won't rank in a run's top-3
chunks, so the receipt would fire on a large fraction of normal runs — undesirable noise in the
shared `safety` evidence channel of a real-money app. This section documents the corrected,
low-noise design that actually ships.

### The bug in the first correction

Dropping the both-conditions check made the receipt equivalent to "was X retrieved this run?" for
every type in `COVERAGE_CHECKED_DOC_TYPES`. For `10-k`/`10-q` this is usually fine (they retrieve
most runs once ingestion has run at all), but `8-k` specifically is a low-frequency event type by
nature (companies only file 8-Ks around material events) — even with real 8-K coverage in the
corpus, a `10-k`/`10-q`/`earnings-transcript`-heavy run's top-3 filter can easily rank zero 8-K
chunks. Firing a "coverage gap" receipt in that ordinary case trains the operator to ignore the
whole receipt, defeating its purpose.

### The corrected design: both-conditions, but only where the producer ledger is complete

The fix restores the both-conditions gate (not-retrieved-this-run AND zero-ever-ingested-producer),
but scopes it to the subset of doc types where the producer ledger (`ingested_accessions`) is
actually a reliable "was this ever produced" signal:

- **10-K/10-Q**: `src/lib/web-sources/sec-filings.ts`'s always-on `ingestFiling` writes an
  `ingested_accessions` row for every 10-K/10-Q ingest (stored as the raw SEC form letter). Every
  writer for these two types records a row — the ledger is COMPLETE. A zero-producer-rows count is
  trustworthy evidence of "never ingested."
- **8-K**: EXCLUDED. As established in the first correction, the default-ON 8-K SUMMARY writer
  (`sec8k.ts`'s `refreshEightK`/`storeContexts`) writes retrievable chunks WITHOUT ever calling
  `insertIngestedAccession` — only the default-OFF full-body writer does. The ledger is INCOMPLETE
  for 8-K: it cannot distinguish "this account has zero 8-K coverage" from "8-K summaries exist in
  the corpus but none ranked this run." Re-add 8-K to `COVERAGE_CHECKED_DOC_TYPES` the day an
  accurate per-doc_type 8-K corpus signal exists (e.g. a `document_chunks.doc_type` column
  populated by both writers, or the summary writer starts recording an accession row too).
- **earnings-transcript**: stays EXCLUDED, unchanged from both prior iterations — no ingestion
  writer exists anywhere in the repo for it, so it would fire every run forever.

`COVERAGE_CHECKED_DOC_TYPES` (`src/lib/strategy.ts`) is now `["10-k", "10-q"]`.

### Implementation

- `computeEmptyDocTypes` (`src/lib/prompt-safety.ts`) gained a third parameter,
  `hasProducerForDocType: (docType: string) => boolean`. A type is "empty" (receipt-worthy) only
  when it is BOTH not in `retrievedDocTypes` (case-insensitive) AND `hasProducerForDocType(type)`
  returns `false`. The module stays a DB-free leaf — the predicate is a plain function the caller
  builds, not a DB call made inside `prompt-safety.ts`.
- `strategy.ts`'s coverage-receipt block builds `hasProducerForDocType` from ONE bulk
  `ingestedAccessionCountsByDocType()` call (already existed in `db-learning.ts`, re-exported via
  the `db.ts` barrel) plus an in-memory loop that mirrors `ingestedAccessionCountForDocType`'s
  prefix-tolerant matching (any stored `doc_type` whose lowercased form starts with the requested
  lowercased type, with `count > 0`) — one query per run total, not one query per coverage-checked
  type. `ingestedAccessionCountsByDocType` was re-added to the `./db` import block in `strategy.ts`
  (it had been dropped in the first correction along with the whole producer-count approach).
- `ingestedAccessionCountForDocType`'s doc comment in `db-learning.ts` was corrected again: it no
  longer says "the coverage receipt no longer calls it" (that was only true during the first
  correction's window) — it now explains that `strategy.ts` builds its own in-memory version of the
  same prefix logic on top of the bulk call, rather than calling this function once per
  coverage-checked type.

### Tests (`test/rag-doc-type-coverage.test.ts`, rewritten again)

- `computeEmptyDocTypes` pure tests updated to the 3-arg signature (`hasProducerForDocType`
  predicate instead of nothing), including:
  - (a) `10-k` requested, not retrieved, zero producer rows -> fires naming `10-k`.
  - (b) **the key low-noise case**: `10-k` requested, not retrieved, but HAS a producer -> does NOT
    fire — proves normal-run silence.
  - A mixed case (`10-q` has a producer, `10-k` does not) to confirm the predicate is applied
    per-type, not globally.
- Strategy-level integration (`runStrategyOnce`, mocked `vector-db`, local test broker gateway):
  - (a) `10-k` not retrieved this run, zero `ingested_accessions` rows for `10-K` anywhere in the
    test's DB -> exactly one audit + one evidence item naming `10-k`.
  - (b) **the key low-noise case, integration form**: `10-k` not retrieved this run, but a real
    `insertIngestedAccession(..., "10-K", ...)` row was seeded before the run -> the receipt does
    NOT fire. This is the direct regression test for the bug this fix addresses.
  - (c) `8-k` retrieves nothing AND has zero `ingested_accessions` rows (the worst case for the
    prior retrieval-only design) -> still does not fire, because `8-k` is excluded from
    `COVERAGE_CHECKED_DOC_TYPES` entirely, regardless of retrieval/accession state.
  - (d) `earnings-transcript` never fires, unchanged.
  - (e) advisory invariant unchanged: `ragContext`/proposal count unaffected by the receipt firing.
- A test-ordering note was added to the file: the strategy-integration `describe` block and the
  `ingestedAccessionCountForDocType`/`ingestedAccessionCountsByDocType` DB-helper `describe` block
  share ONE `DATABASE_URL` for the whole file (per the existing `beforeAll`). The DB-helper block
  seeds a real `"10-K"` `ingested_accessions` row, which would silently falsify test (a)'s "zero
  rows for 10-K" premise if it ran first — it is now placed AFTER the integration tests in file
  order (vitest runs `describe`/`it` in declaration order within a file by default; no
  `sequence.shuffle` is configured in `vitest.config.ts`).

### Verification (second correction)

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run test/rag-doc-type-coverage.test.ts` — **14 passed / 14** (7 pure
  `computeEmptyDocTypes` tests, 2 DB-helper tests, 5 strategy-integration tests including the key
  low-noise case (b)).
- `npx vitest run test/strategy-prompt-safety.test.ts test/strategy-rag-quickwins-wiring.test.ts` —
  **5 passed / 5**.
- `npx eslint src/lib/strategy.ts src/lib/prompt-safety.ts src/lib/db-learning.ts
  test/rag-doc-type-coverage.test.ts` — 0 errors, same 4 pre-existing warnings in `strategy.ts`
  as both prior iterations (`isMarketOpen`/`e`/`currentPrices` unused-var grandfathered warnings —
  unrelated to this change).
- Did not run the full `npm test`/`npm run build` suite for this focused fix, per the task's scope
  (no scope creep beyond the redesign) — same boundary as both prior iterations; a central operator
  runs full CI via `scripts/land.sh` at land time.
- Did not push/open a PR/land — this is a local-commit-only fix per the task instructions.

### Why both-conditions-on-a-ledger-complete-subset is the right long-term shape

This design is intentionally narrower in COVERAGE than "check all 4 requested doc types" would be —
it only ever reports a gap for `10-k`/`10-q`. That is a deliberate trade: a receipt that fires
correctly on 2 types beats a receipt that fires incorrectly (either direction) on 3. The
both-conditions gate is what makes the receipt trustworthy: it only fires for the genuinely useful
"this corpus/account has zero coverage of doc type X" signal (e.g. a brand-new account before its
first ingestion run, or an account where 10-K/10-Q ingestion is misconfigured/failing silently),
and stays silent on the ordinary "X exists but didn't rank today" case that happens on a large
fraction of normal runs for any type. Extending coverage to `8-k` (or `earnings-transcript`) is
gated on a real producer-ledger fix, not a relaxation of the both-conditions design — see the
"Re-add" notes on `COVERAGE_CHECKED_DOC_TYPES` in `src/lib/strategy.ts`.
