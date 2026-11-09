# 2026-07-06 - claude-nextwave-rag

## Summary

A same-day, triage-first CLAUDE-lane cluster following directly on the 2026-07-05 backlog train
(#816/#819/#820/#822, closed out in `docs/rollouts/2026-07-05-claude-backlog-train.md` and deployed
to production the same day — see Deployed section below). The session started from a 9-row triage
scope (`docs/EFFORT-LOG.md`'s "CLAUDE next-wave: RAG retrieval-quality + corpus-integrity cluster"
row) and worked it triage-first: check ground truth against `main` before building anything. Five
lanes needed real code and were built, adversarially reviewed, fixed, and landed as five separate
PRs — #970, #973, #974, #977, #979 — all merged 2026-07-06. The remaining four rows resolved
without new PRs: three were confirmed already-done in code, and one (server-side numeric as-of
Pinecone filter) is deferred pending owner design input. This note is the session-level record
tying the five lanes together; full technical detail for each lane lives in its own per-lane
rollout note (linked below), not repeated here.

## Why

Owner-directed continuation of the CLAUDE-lane backlog on `docs/EFFORT-LOG.md` (mirrors the
canonical live board `/Users/jay/apps/TRADING-EFFORT-LOG.md`) immediately after the prior train
deployed to production. Each lane closes a gap in the RAG/episodic-memory retrieval path's
observability or coverage: callers previously couldn't tell *why* a retrieval came back empty
(typed-retrieval-status), held positions outside the top-N scan slice got zero retrieved memory
for sell/hold/trim decisions (held-position-retrieval-scope), the golden-eval harness had zero
non-filings coverage so it couldn't discriminate on episodic recall (rag-golden-eval-episodic), a
requested-but-never-ingested filings doc type silently produced no receipt (corpus-coverage-receipt),
and the post-recall candidate pool that didn't make the final cut was never persisted for analysis
(persist-candidate-pool). Per the owner's binding advisory-only philosophy (`AGENTS.md` "Product
philosophy" section), every lane is additive/observational — none gates, blocks, or reorders
retrieval, ranking, or the BUY-candidate scan/prompt set.

## Lanes

- **#970 — typed retrieval-status receipt.** New `RetrievalStatus` union
  (`no_memory`/`lookup_failed`/`budget_skipped`/`degraded`/`ok`) surfaced via an optional
  `RetrieveOptions.onStatus` callback on `retrieveContextDetailed`, threaded through
  `experience-memory.ts` and `strategy.ts` into a new `rag_retrieval_status` audit row and an
  additive `SocraticDecisionCase.ragRetrievalStatus` field. Persistence only, never rendered, never
  gates chunk selection.
- **#973 — RAG golden-eval expansion (episodic + #822 single-vs-multi-query).** 10 new episodic
  fixture cases (`socratic-decision`/`coach-note`/`lesson`, near-miss hard negatives) plus a
  recall@k/MRR suite and a single-vs-multi-query suite exercising `RetrieveOptions.queries`/
  `rrfFuse` (#822) directly. Test/fixture/docs only, no production code, no RAG flag defaults
  touched.
- **#974 — held-position retrieval scope.** Widens filings-RAG, learned-context, and episodic
  retrieval in `runStrategyOnce` to UNION in every held (open) position's symbol, not just the
  score-sorted top-N scan slice — so a held name outside the top slice still gets retrieved memory
  for sell/hold/trim decisions. The BUY-candidate scan/prompt set itself is completely untouched.
- **#977 — per-run corpus-coverage receipt.** Advisory-only receipt firing when a requested filings
  doc type produces zero chunks this run AND has zero ever-ingested rows (both-conditions gate) —
  makes "this evidence structurally cannot exist yet" visible without touching `ragContext`/sizing/
  policy.
- **#979 — persist full retrieved candidate pool (flag-gated, default off).** New
  `RAG_PERSIST_CANDIDATE_POOL` flag (default OFF, byte-identical when off) captures the
  post-recall/post-dedupe candidate pool — including chunks that didn't make the final top-`limit`
  slice — via a new `recordCandidatePool` helper. IDs/scores/docType/asOf/`used` only, never raw
  chunk text.

## Review findings caught pre-merge

- **Corpus-coverage receipt — 8-K daily-false-positive BLOCKER, fixed via corpus-truth-then-ledger-
  scoped redesign (#977).** The original design gated the receipt on "zero ever-ingested
  `ingested_accessions` rows corpus-wide." That signal was itself broken: the default-ON 8-K
  SUMMARY writer (`sec8k.ts`'s `refreshEightK`) writes retrievable `doc_type: "8-k"` chunks but
  never calls `insertIngestedAccession` — only the default-OFF full-body writer does — so the
  receipt false-fired "8-k" on any day an 8-K chunk simply didn't rank top-3 (routinely, not
  rarely). A `document_chunks`-based alternative was investigated and confirmed not viable (no
  `doc_type` column, not populated unconditionally by every writer). Final design: a static
  `COVERAGE_CHECKED_DOC_TYPES` allowlist narrowed to `["10-k", "10-q"]` — the two types whose
  `ingested_accessions` producer ledger is actually complete — with the both-conditions gate
  restored on that ledger-complete subset only. 8-K stays excluded until a real per-doc_type 8-K
  corpus signal exists.
- **Held-scope — episodic-sketch gap, fixed (#974).** The initial commit widened
  `situationCandidates` in `strategy.ts` but `buildSituationSketch` (`experience-memory.ts`) still
  did a bare `slice(0, 3)`, silently dropping held symbols appended past top-3 before they ever
  reached the actual query text — episodic parity was only partial. Fixed with an additive
  `SituationCandidate.held` flag and a bounded (max 6) held-aware selection; non-held path stays
  byte-identical.
- **Held-scope / typed-status — cross-lane catch-block fallback bug, fixed (#974, caught by
  Copilot review).** With `topSymbols` widened to include held symbols, the filings-RAG pass could
  cover more than top-3, but the typed-retrieval-status lane's (#970) fallback in the later `catch`
  block still only added receipt rows for `marketScan.topCandidates.slice(0, 3)` — so a full-pass
  failure would silently omit held symbols from the `rag_retrieval_status` receipt even though they
  were now in-scope for retrieval. Fixed so the catch-block fallback iterates the same
  held-widened symbol set as the happy path.
- **Golden-eval — baseline-population + recall-discrimination fixes (#973).** A post-merge-review
  pass caught that the "filings behavior byte-identical" claim was false: the filings-only `it`s had
  no `cases` filter and were silently scoring the full 39-case mix (MRR 0.919) instead of the
  original 29 filings cases (MRR 1.0) once the 10 episodic cases existed. Fixed with an explicit
  `FILINGS_CASES` filter; filings MRR confirmed back to 1.0. Also added an explicit `recall1`
  assertion over the episodic cases, since recall@3 alone saturates at 1.0 and can't discriminate
  a regression.
- **Persist-pool — honesty note + id-less hardening (#979).** The shipped v1 only captures
  `rankPool`'s OUTPUT pool (already post-minScore/asOf/hybrid/rerank/dedupe), so candidates dropped
  upstream never appear at all — and in the flagship production caller (dedupe 0.6 + limit 3, both
  already hard-capping output at `limit`), `used:false` rows are rare/absent. Documented plainly as
  a known limitation rather than oversold; a pre-rankPool v2 with per-stage drop reasons is the real
  follow-up if "why was X dropped" is the actual goal (see Follow-ups below). Persisted fields are
  ids/scores/docType/asOf/`used` only — never raw chunk text, matching the existing "never persist
  raw query text" posture.

## Verification

Each lane ran its own local focused-test verification during development (see each lane's own
rollout note for exact commands/counts), and each PR's `land.sh` run executed the full gate
(`npx tsc --noEmit` → `npm test` → `npm run build`) before merge — confirmed green via each PR's
`verify`/`verify-hosted` CI logs. The suite grew across the session as each lane added tests: from
~2711 (pre-cluster baseline, per #970's land-time count) to 2836 passed / 282 files on this
worktree post-merge (full `npm test` re-run fresh against `origin/main` after this closeout branch
was cut; required a `npm rebuild better-sqlite3` first — the native module in this worktree's
`node_modules` was built against a different `NODE_MODULE_VERSION` than the pinned Node 24 runtime,
a one-time fresh-worktree/host-recovery step, not a code issue).

## Follow-ups

Two items are deliberately deferred, both needing owner design input before they can proceed:

- **Server-side numeric as-of epoch filter in Pinecone.** Needs an ingest-time numeric-epoch
  backfill on existing vectors plus a fail-open-vs-fail-closed decision before a server-side filter
  could replace the current post-fetch as-of filtering in `vector-db.ts`.
- **Persist-candidate-pool v2 — pre-rankPool drop capture.** The shipped v1 (#979) only sees
  `rankPool`'s output pool, so it can't explain minScore/asOf/dedupe drops — the useful "why was
  this candidate excluded" question needs a v2 that captures the pool before `rankPool` runs, with
  a per-stage drop reason. Deferred rather than built speculatively since it changes what gets
  recorded and should be scoped with the owner first.

The three triage-confirmed-already-done items (as-of-strict undated-chunk drop via
`VECTOR_ASOF_STRICT`, train/serve embedding-text skew fix via `VECTOR_EMBED_CLEAN_TEXT`, and
decision-memory re-index coverage via `indexSocraticDecisionMemory`) needed no further work — see
the annotated `docs/EFFORT-LOG.md` row for the verification detail on each.

Earlier the same day, the prior CLAUDE backlog train (#816/#819/#820/#822) was deployed to
production at `socratictrade.com` (`trading-live` published at commit `7b5450fe`) — see the
`## Deployed` section of `docs/EFFORT-LOG.md`. This next-wave cluster was built and landed on top
of that already-deployed base.
