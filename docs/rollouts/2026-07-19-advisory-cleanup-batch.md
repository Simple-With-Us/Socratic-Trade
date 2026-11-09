# 2026-07-19 - advisory-cleanup-batch

## 2026-07-22 PR #1792 hosted typecheck remediation

The prior head failed TypeScript because its merge resolution used stale provider dispatch/cost
references. Commit `28a09b84` keeps the durable `voyage-rerank` service identifier, narrows the
active provider passed to the health lane, and uses `estimateRagDispatchCost`.

Files: `src/lib/vector-db.ts`, `STATUS.md`, `PLAN.md`, this rollout note, and `docs/EFFORT-LOG.md`.

Verification: hosted `verify-hosted` on the previous head failed only at TypeScript with the stale
references; `npx tsc --noEmit` passed on the repaired branch before the docs-only receipt commit.
No production, provider, corpus, or broker writes were made.

Follow-up: confirm hosted verify green, then allow auto-merge and verify the exact post-merge
Coolify deployment SHA.

## Summary

Four small, independent verifier advisories from this week's adversarial reviews, landed together
as one batch on `claude/advisory-cleanup-batch`:

1. **Declare the `jose` dependency.** Added `"jose": "^6.0.6"` to `package.json` `dependencies`.
   `jose` is directly imported by `src/lib/auth/session-token.ts` (`SignJWT`/`jwtVerify`/`JWTPayload`
   from `jose`, `jose/jwt/sign`, `jose/jwt/verify`) but previously only resolved as a phantom
   transitive dependency of `next-auth` -> `@auth/core`. `npm ls jose` now shows it as a direct,
   non-extraneous dependency, deduped against `@auth/core`'s own `jose@6.2.3` requirement.

2. **Machine-flag the manifest sentinel data.** `data/rag-universe-manifest.json` carries converter
   sentinels (`exchange:"UNKNOWN"`, `marketCapUsd:1`, `dollarVolumeUsd:1`) on all 1,000 issuers with
   no machine-checkable marker. Added a `dataQuality: "sentinel" | "live"` field to
   `SecUniverseIssuer` (optional, additive) and validator support in
   `src/lib/rag/universe-manifest.ts`: present-but-invalid values are a blocking error
   (`data_quality`); an absent field is back-compat-tolerated as a non-blocking **warning**
   (`data_quality_missing`, `severity: "warning"`) rather than a hard failure, so manifests frozen
   before this field existed (or in flight on other branches) don't suddenly fail validation. Added
   `blockingUniverseValidationIssues()` — every existing `issues.length > 0` gate
   (`sec-ingest-seeder.ts`'s `loadManifest`, `convert-universe-manifest-v1-to-v2.ts`,
   `generate-universe-manifest.ts`, `validate-rag-universe.ts`) now filters through it so a
   "warning" never blocks an otherwise-valid manifest. Stamped the committed artifact via a new
   one-time script, `scripts/eval/stamp-universe-manifest-data-quality.ts` (reuses
   `hashSecUniverseIssuers`/`validateSecUniverseManifest` from `universe-manifest.ts`, same
   read -> transform -> re-hash -> re-validate -> write pattern as
   `convert-universe-manifest-v1-to-v2.ts`): all 1,000 issuers matched the sentinel pattern exactly
   (`exchange==="UNKNOWN" && marketCapUsd===1 && dollarVolumeUsd===1`) and were stamped
   `dataQuality:"sentinel"`; `issuerSha256` was recomputed over the updated issuer array;
   `generatedAt` was bumped to record the stamping event; `selectionMethod` got an appended note
   (not a silent rewrite of the 2026-07-18 conversion history). `generate-universe-manifest.ts` now
   stamps `dataQuality:"live"` on every issuer it emits (it only reaches the issuer-construction
   branch after a real Yahoo Finance quote succeeded). The committed-artifact CI test
   (`test/rag-universe-manifest-committed.test.ts`, `toEqual([])`) stays green because the stamped
   artifact now carries zero issues at all — not just zero *blocking* ones.

3. **Halve SEC discovery requests.** `sec-ingest-seeder.ts` called `fetchRecentFilings` twice per
   issuer (`["10-K"]` then `["10-Q"]`), hitting the identical EDGAR submissions URL for the same CIK
   twice. Extended `fetchRecentFilings`/`parseRecentFilings` in `src/lib/web-sources/sec-filings.ts`
   to accept a per-docType limit map (`FilingTypeLimits = number | Partial<Record<"10-K"|"10-Q",
   number>>`) alongside the existing single-number form (fully backward compatible — every existing
   caller passing a plain number is unaffected). The seeder now makes ONE call:
   `fetchRecentFilings(issuer.cik, ["10-K", "10-Q"], { "10-K": tenKLimit, "10-Q": tenQLimit })` — was
   two calls (`Promise.all([...(["10-K"]),...(["10-Q"])])`). ~1,000 requests saved per full seed of
   the 1,000-issuer universe. Updated `test/sec-ingest-seeder.test.ts`'s `mockFilingsFor` helper to
   combine `tenKs`/`tenQs` by requested docTypes (previously branched to a single list per call,
   which assumed two separate calls).

4. **Rename voyage-labeled RAG health lanes.** `withRagApiHealth`'s 4 embed/rerank call sites in
   `src/lib/vector-db.ts` hardcoded the health/alert service name `"voyage"`/`"voyage-rerank"`
   regardless of which embed/rerank provider is actually active (Voyage, OpenRouter, or
   SiliconFlow) — a documented, deliberate follow-up left by the 2026-07-18 bge-m3-metering-gate
   work (see the caveat comment it left in `app/api/health/route.ts`). Added an optional 8th
   parameter to `withRagApiHealth`, `healthLane?: { lane: "rag-embed" | "rag-rerank"; provider:
   "voyage" | "openrouter" | "siliconflow" }`: when set, `logApiHealth`/`alertRagConnectionFailure`
   record the provider-generic lane name instead of the historical `service` argument (which is
   otherwise UNCHANGED and still drives the internal durable-dispatch/credential path — a separate
   concern, not touched). All 4 call sites (2x embed-document in `storeDocument`'s batch loop, 1x
   embed-query in `retrieveContextDetailed`, 1x rerank in `rerankMatches`) now pass the real active
   provider (`activeEmbeddingProvider(userId)` / `activeRerankProvider(userId)`, both already
   computed at each site) alongside the new lane name. `alertRagConnectionFailure`'s title/payload
   now say e.g. "OpenRouter embed connection failed" instead of a hardcoded "Voyage connection
   failed"; the payload's `provider` field carries the real active provider, and a new `lane` field
   carries the health-lane identifier itself.
   - `db-health.ts`'s `RAG_SERVICES_WITH_OWN_ALERTING` suppression set (prevents `logApiHealth`'s
     generic auto-alert from double-firing alongside vector-db.ts's own richer alert) now also
     includes `"rag-embed"`/`"rag-rerank"` (kept `"voyage"`/`"voyage-rerank"` too — still written by
     `recordMissingRagKey`'s missing-API-key path, deliberately NOT renamed since that's a distinct
     "is a Voyage key configured at all" check, unrelated to which provider serves a given call).
   - `app/api/health/route.ts`'s dependencies/criticality logic simplified: since the lane is now
     provider-generic, the old `if (ragEmbedProvider === "voyage" || ragEmbedProvider === null)`
     conditional (which meant a dead OpenRouter/bge-m3 lane never failed liveness — a real gap) is
     gone; `"rag-embed"`/`"rag-rerank"` are unconditionally critical (still excluded when
     `RAG_EMBED_PROVIDER` is pinned-but-keyless, to avoid a config-error restart-loop, matching prior
     behavior for that one edge case).
   - `app/api/admin/connections-health/route.ts`'s `EXPECTED_BACKEND_LANES` placeholder rows renamed
     to `"rag-embed"`/`"rag-rerank"`; `toCanonicalService` now resolves the ACTIVE provider
     (`activeEmbeddingProvider`/`activeRerankProvider`, falling back to `"voyage"` on a
     pinned-but-keyless throw) instead of a hardcoded `"voyage"` mapping, so `hasUserKey`/
     `credTierForService` check the real credential regardless of which provider is pinned.
   - Updated `test/connection-health-routing.test.ts`: renamed lane names in the health-lane tests;
     replaced the two "provider-aware voyage criticality" tests (which tested the OLD gap-y
     behavior — non-Voyage failures never 503'd) with tests asserting the NEW correct behavior (a
     hard-stopped `rag-embed`/`rag-rerank` lane 503s regardless of which provider is active) plus a
     new regression test confirming the legacy literal `"voyage"` lane name is no longer critical
     (back-compat/historical rows visible but not liveness-gating). Updated
     `test/vector-db-lease-fencing.test.ts`'s raw-SQL `api_health_log` queries
     (`service IN ('pinecone', 'voyage')` -> `'rag-embed'`) — it directly reads the real DB rows
     `storeContexts`'s embed path writes.

## Why

All four are verifier advisories flagged in this week's adversarial reviews (bge-m3 program /
Codex-46 disposition map). Each is small and independent; landed together as one batch per the
requested scope. Item 4 was the largest: it fixes a real, previously-documented liveness gap (a
dead non-Voyage embed/rerank provider never failed `/api/health`'s liveness probe) as a byproduct of
the rename, not just a labeling cleanup.

## Files

- `package.json`, `package-lock.json` — `jose` direct dependency.
- `src/lib/rag/universe-manifest.ts` — `dataQuality` field/schema, `severity`/
  `blockingUniverseValidationIssues`.
- `data/rag-universe-manifest.json` — stamped `dataQuality:"sentinel"` on all 1,000 issuers;
  `issuerSha256`/`generatedAt`/`selectionMethod` updated accordingly.
- `scripts/eval/stamp-universe-manifest-data-quality.ts` — new one-time stamping script.
- `scripts/eval/convert-universe-manifest-v1-to-v2.ts`, `scripts/eval/generate-universe-manifest.ts`,
  `scripts/eval/validate-rag-universe.ts` — `dataQuality` stamping + `blockingUniverseValidationIssues`
  gating.
- `src/lib/web-sources/sec-filings.ts` — `fetchRecentFilings`/`parseRecentFilings` per-docType limits
  (`FilingTypeLimits`).
- `src/lib/rag/sec-ingest-seeder.ts` — single `fetchRecentFilings` call; `blockingUniverseValidationIssues`
  gating in `loadManifest`.
- `src/lib/vector-db.ts` — `withRagApiHealth`'s `healthLane` param; `alertRagConnectionFailure`'s
  `activeProvider` param + provider-generic titles; 4 embed/rerank call sites updated.
- `src/lib/db-health.ts` — `RAG_SERVICES_WITH_OWN_ALERTING` superset.
- `app/api/health/route.ts` — unconditional `rag-embed`/`rag-rerank` criticality.
- `app/api/admin/connections-health/route.ts` — renamed `EXPECTED_BACKEND_LANES`, provider-aware
  `toCanonicalService`.
- `test/rag-universe-manifest.test.ts` — `dataQuality` fixture + new dedicated tests.
- `test/sec-ingest-seeder.test.ts` — `mockFilingsFor` combines docTypes for the single-call seeder.
- `test/connection-health-routing.test.ts` — renamed lanes; replaced/added criticality tests.
- `test/vector-db-lease-fencing.test.ts` — renamed raw-SQL lane filters.

## Verification

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` (scoped to every touched file) — 0 errors, 72 pre-existing grandfathered warnings
  (`@typescript-eslint/no-explicit-any`/`no-unused-vars`), none new.
- `npx vitest run test/rag-universe-manifest.test.ts test/rag-universe-manifest-committed.test.ts
  test/sec-ingest-seeder.test.ts test/sec-filings.test.ts test/sec-backfill-p2.test.ts
  test/connection-health-routing.test.ts test/vector-db-lease-fencing.test.ts
  test/connections-health-route.test.ts test/vector-db.test.ts test/vector-db-retrieval.test.ts
  test/vector-db-rerank-floor.test.ts test/vector-db-rerank-overfetch.test.ts
  test/rag-embed-provider-gate.test.ts test/vector-db-voyage-dispatch-cost.test.ts
  test/provider-dispatch-durability.test.ts` — 15 files, 165 tests, all passed.
- `npm test` (full suite) — see exact pass/fail counts recorded at commit time below.
- `npm run build` — see result recorded at commit time below.
- `npm ls jose` — resolves as a direct, non-extraneous dependency (`jose@6.2.3`, deduped with
  `next-auth` -> `@auth/core`).
- Manually ran `npx tsx scripts/eval/stamp-universe-manifest-data-quality.ts` once against the
  committed manifest and verified `git diff --stat` only touched `dataQuality` +
  `issuerSha256`/`generatedAt`/`selectionMethod` (no other issuer fields changed).

## Follow-ups

- `package-lock.json` picked up one unrelated, pre-existing line of drift (`fsevents`'s `"dev": true`
  flag) when regenerated via `npm install --package-lock-only` — confirmed via `git stash` that this
  churn reproduces even WITHOUT the `jose` change, so it's pre-existing lockfile normalization noise,
  not something this PR introduced. Left in since re-running `npm install --package-lock-only`
  produces it regardless.
- Item 4's alert cooldown key (`${RAG_CONNECTION_ALERT_PREFIX}:${service}:${source}:${targetUserId}`)
  is keyed by the new lane name, so any currently-cooling-down `"voyage"`/`"voyage-rerank"` cooldown
  resets to a fresh, un-cooled-down `"rag-embed"`/`"rag-rerank"` key on deploy. Worst case: one extra
  alert fires immediately post-deploy if a failure is actively ongoing at deploy time. Not worth
  engineering around for a one-time deploy transition.
- `recordMissingRagKey` (vector-db.ts) still reports missing-API-key failures under the literal
  `"voyage"`/`"pinecone"` service names — deliberately NOT renamed (it's checking "is a Voyage key
  configured at all", a distinct concept from "which provider actually served this call").
- The rerank dispatch-ledger's provider derivation (`withDurableRagProviderDispatch`'s `provider =
  service === "voyage-rerank" ? "voyage" : service`) still always resolves the Voyage credential/
  rate-limit window for rerank calls, even when OpenRouter/SiliconFlow is the active rerank
  provider — a related but separate bug (rate-limit/cost governance scoping, not health/alert
  labeling) that was explicitly out of scope for this batch. Worth a follow-up.
