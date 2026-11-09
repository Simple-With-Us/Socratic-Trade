# Socratic usage telemetry v2 producer

## Contract

- Exact shared dependency: immutable `v2.0.0`, resolved over HTTPS to
  `19a077a4a8245963775c9fedb462a6741b0a70aa`.
- Wire envelope: `schemaVersion: 2`, `producerId: "socratic-trade"`, and up to 100 strict v2 events.
- Event identity: required `eventId`; durable source-row and aggregate-window identities remain
  stable across ambiguous retries.
- Credential attribution: legacy `keyRef` maps to `producerKeyRef`; producer identity is never
  duplicated inside events.
- ACKs and errors are parsed through the shared v2 schemas, including retryability metadata. A
  schema-valid partial ACK is still a failed delivery unless `received` equals the sent batch and
  `rejected` is zero; live events retry unchanged and durable replay leaves its watermark unmoved.

## Backlog safety

Durable LLM, RAG, and provider-dispatch rows are reconstructed from source rows. A process-local
version bump normalizes any pre-v2 HMR buffer once (`sourceApp` removed, `idempotencyKey` to
`eventId`, `keyRef` to `producerKeyRef`) before validation and retry.

Existing replay cursors were ACKed under v1's explicit persistence key, while live pushes did not
advance those cursors. Replaying that window under a v2 `(producerId,eventId)` identity could duplicate
money, and a legacy bridge introduced cross-ledger cutover races. The final design therefore uses one
synchronous `BEGIN IMMEDIATE` transaction to seed all three replay cursors to their current high-water
marks before reconciliation, event construction, or network I/O. Each seeded lane records a durable
`pre_v2_rows_skipped` count and keeps the seed row exclusive. The first newer strict-v2 ACK atomically
advances the cursor and marker to `v2-active`; normal inclusive v2 overlap is crash-safe thereafter.

This direct-v2 migration intentionally does not replay the bounded pre-v2 remainder. Most such rows
were already live-pushed under v1; any unacknowledged remainder can be lost. The owner explicitly
accepted that bounded loss in preference to duplicate spend/usage and a legacy retry storm. Unknown
or corrupt cutover/watermark state is distinct from absence and halts only that lane with zero network
or state writes. There is no v1 sender or dual-write path in the final implementation.

## Verification

- Cold tokenless install: `GIT_SSH_COMMAND=false npm ci` under Node 24; shared version 2 and v2
  exports loaded.
- TypeScript: `npx tsc --noEmit`.
- Scoped lint: producer plus both telemetry test suites.
- Focused Vitest: 7 files / 83 tests covering push, replay, ledger durability, dispatch cost,
  budgets, v2 envelopes, typed ACKs, ambiguous retry, and legacy HMR normalization.
- Full Vitest exercised 424 files / 4,952 tests; 4,951 passed and the only failure was the old v1
  `sourceApp` assertion updated during that run. The final affected producer/replay/FMP regression
  set passed 3 files / 46 tests after the update.
- Production build: `npm run build` under Node 24.
- Direct-v2 cutover revalidation under Node 24: 4 files / 66 tests (push, replay, background
  startup, and FMP producer telemetry), TypeScript, scoped ESLint, and diff-check pass. Coverage includes atomic all-ledger
  seeding, skipped-row receipts, seeded-boundary exclusion, strict-v2 activation/overlap, malformed
  JSON and invalid-timestamp fail-closed behavior, no partial seed, replay-before-producer boot, and
  stale-HMR timer replacement for the v3 direct-v2 replay state. The FMP producer suite explicitly
  establishes the same active cutover marker that production instrumentation creates before provider
  workers start, preventing a test-only pre-v2 ordering from masking provider events.
- Combined landing verification after subsuming the shared-package pin-check workflow fix: Node 24
  5 files / 71 tests, TypeScript, scoped ESLint, workflow YAML parsing, and diff-check pass.

## Promotion gate

The receiver gate cleared on exact Usage-Monitor main
`2bc276497ae28441762768911f34eb5e8e2fdd30`, committed live on Oracle with strict readiness,
fresh scheduler, Garage restore/integrity/FK/schema verification, and a committed deploy receipt.
Land through protected checks, then verify the exact Coolify production SHA plus one authenticated
v2 ACK.

## Provider-family exclusions (post-merge)

After this producer lands, the retired-provider cleanup lane filters Alpaca (including
`alpaca-news` / `alpaca-snapshot`), Tradier, and Robinhood out of live call-volume and durable
provider-dispatch replay admission. Strict-v2 event IDs, complete/partial ACK rules, replay
watermarks, and cutover seeding are unchanged; those families simply never enter the monitor feed.
See `docs/rollouts/2026-07-22-retired-provider-usage-cleanup.md`.
