# Dense plus lexical RAG retrieval integration

## Summary

Integrated the reviewed RAG program into the production retrieval path behind default-off flags.
Retrieval can now union independently recalled SQLite FTS5 filing occurrences with dense Pinecone
matches through one RRF pass, then invoke at most one explicitly routed reranker. The same branch
also carries production-path evaluation, hosted-inference comparison, bounded parent context,
exact evidence-consumption receipts, structured-vs-narrative routing, and read-only provider probes.

## Why

The previous `HYBRID_RETRIEVAL` pass computed BM25 only over candidates Pinecone had already
returned, so it could reorder recall but could not recover a missed exact accession, covenant, or
filing term. Embedding and rerank routing were also coupled, and stage latency/drop behavior was not
available as a single safe receipt.

## Files

- `src/lib/vector-db.ts`
- `src/lib/rag/recall-fusion.ts`
- `src/lib/rag/corpus-wide-lexical.ts`
- `src/lib/rag/retrieval-stage-telemetry.ts`
- `src/lib/rag/parent-context.ts`
- `src/lib/rag/evidence-consumption.ts`
- `src/lib/rag/information-routing.ts`
- `scripts/eval/rag-production-eval.ts`
- `scripts/eval/pinecone-inference-benchmark.ts`
- `scripts/eval/rag-shadow-benchmarks.ts`
- `test/rag-recall-fusion.test.ts`
- `test/corpus-wide-lexical.test.ts`
- `test/vector-db-retrieval.test.ts`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/chat-assistant-rag-learning.md`
- `docs/rollouts/2026-07-22-rag-retrieval-integration.md`

## Decisions and safeguards

- `RAG_CORPUS_WIDE_LEXICAL` remains off until the production evaluator meets quality/latency gates.
- FTS query grammar is quoted and bounded; managed occurrences must have committed receipts and be
  the current document head, or the version active at the requested point in time.
- Lexical SQL admits only the requester's authoritative shared/private tenant scopes, excludes
  licensed transcript and user-authored sources, and does not admit a legacy occurrence shadowed by
  a visible managed head/PIT version. Tenant and transcript guards run again after fusion.
- Lexical BM25 is never fabricated as cosine, and a dense cosine floor cannot erase an independently
  recalled lexical candidate.
- Dense/lexical overlaps retain the dense score and receive dual retrieval provenance.
- `RAG_RERANK_PROVIDER` may differ from `RAG_EMBED_PROVIDER`; a missing explicit rerank credential
  never falls back to another provider and never creates a fake relevance score.
- `RAG_ADAPTIVE_RERANK` and `RAG_RETRIEVAL_STAGE_TELEMETRY` remain default-off.
- Generic FTS recall does not masquerade as an exact lookup and shrink adaptive rerank depth.
- Missing/mock production embedding credentials cannot synthesize managed vectors; deterministic
  vectors remain a test-only fixture.
- Evaluation is capped at 100 cases/results, forces strict PIT, rejects broad relevance selectors,
  records the actual runtime provider/model/index/authority route, and uses the credentialed
  `RAG_EVAL_USER_ID`/`local` retrieval user separately from an isolated `rag-eval:*` run id plus a
  bounded usage window. Future or undated evidence makes the CLI fail unless explicitly diagnostic.
- Complete prompt evidence alone can enter outcome usefulness attribution. Header-only/truncated
  assembly stays diagnostic, and chat tool-result assembly is not mislabeled as model consumption.
- No provider, corpus, re-embed, purge, secret, or production mutation occurred.

## Verification

Focused verification on the current-main integration tree:

```bash
npx vitest run test/corpus-wide-lexical.test.ts test/rag-production-eval.test.ts test/rag-shadow-benchmarks.test.ts test/rag-embed-provider-gate.test.ts test/rag-evidence-consumption.test.ts test/rag-parent-context.test.ts test/rag-rerank-policy.test.ts test/strategy-rag-quickwins-wiring.test.ts test/vector-db-chunk-cap.test.ts
npx tsc --noEmit
```

Results: 9 files / 72 tests passed and TypeScript passed. Independent reviewers found and the branch
fixed the tenant, stale-legacy, synthetic-vector, attribution, evaluator-integrity, parent-dedupe,
and evidence-identity issues above.

The first ordered full-suite attempt reached 431 passing files / 5,012 passing tests but exposed
three deterministic integration failures before the build step: the new fusion composition fixture
did not create a pool larger than its requested limit; a legacy missing-rerank-authority fixture
still expected the old fabricated fallback depth; and the post-fusion adaptive planner prematurely
cut the default-off multi-query candidate union from 300 to 150. The fixtures were corrected and
the retrieval path now preserves the full fair multi-query/lexical union (bounded at 1,000) for its
single rerank when adaptive routing is off. The three affected files then passed 44/44 tests and
standalone TypeScript passed. The authoritative ordered gate will be restarted from lint.

That restarted gate passed lint (0 errors / 615 warnings), TypeScript, and the full 434-file /
5,015-test suite. The production build then found a static `node:crypto` import in the otherwise
pure parent-deduplication helper entering a Webpack-analyzed bundle path. Parent identity now uses
the exact bounded parent text instead of a cryptographic digest, eliminating both the bundle issue
and hash-collision ambiguity. The affected retrieval set passed 52/52 tests plus TypeScript; because
code changed, the final ordered gate is being restarted from lint once more.

That build advanced to the same Node-scheme issue in retrieval-stage telemetry. Its query
correlation key now uses a deterministic two-lane digest implemented without Node-only imports;
it remains text-free and is explicitly non-security metadata. Telemetry and parent-context tests
passed 11/11, TypeScript passed, and a production-build preflight completed successfully. The final
ordered gate was then restarted after this last code change and passed in the required order:

```text
npm run lint       -> passed, 0 errors / 615 warnings
npx tsc --noEmit   -> passed
npm test           -> passed, 434 files / 5,015 tests
npm run build      -> passed, 34/34 static pages generated
git diff --check   -> passed
```

After manually reviewing and merging `origin/main@55e808d8`, `scripts/land.sh` ran under the
required Node 24 runtime and passed TypeScript, the expanded 439-file / 5,027-test suite, and the
production build. It pushed the branch and opened ready PR #1892. A first Node 24 attempt was
discarded because the local `better-sqlite3` binary had been built for Node 26 ABI 147; rebuilding
that untracked dependency for Node 24 ABI 137 eliminated the cascading database-load failures.

PR review then found an id-less legacy attribution mismatch: prompt-consumption identity included
the section and immutable metadata coordinates, while the Socratic attribution path passed section
as display title and omitted the remaining fallback coordinates. A shared
`ragEvidenceIdentityFromChunk` builder now feeds both prompt candidates and attribution refs, with a
regression covering accession, section, ordinal, content hash, namespace, scope, and tenant scope.
Focused verification passes 2 files / 4 tests, standalone TypeScript, and scoped ESLint with no
errors. The final Node 24 gate then passed in order: lint with 0 errors / 613 warnings, TypeScript,
439 files / 5,028 tests, and production build.

Connector review follow-up added metadata predicates before the bounded lexical candidate cap and
changed FTS matching to filing chunk text only, preventing symbol/source/accession metadata from
consuming recall slots. The production evaluator now uses a credentialed retrieval user (explicit
`--user`, `RAG_EVAL_USER_ID`, or the normal `local` account) while keeping the report/run id isolated.

Follow-up verification:

```text
npx vitest run --maxWorkers=1 test/corpus-wide-lexical.test.ts test/rag-production-eval.test.ts -> 18 tests passed
npx eslint src/lib/rag/corpus-wide-lexical.ts src/lib/vector-db.ts scripts/eval/rag-production-eval.ts test/corpus-wide-lexical.test.ts test/rag-production-eval.test.ts -> 0 errors / 71 warnings
npx tsc --noEmit -> passed
git diff --check -> passed
```

## Follow-ups

- Complete required hosted checks on ready PR #1892, protected merge/auto-deploy, and exact-SHA
  production verification.
- Keep production flags unchanged until real-corpus PIT evaluation establishes promotion thresholds.
