# 2026-08-09 — Pinecone trial knobs applied to prod + EDGAR shard-field fix unblocking the SEC seed

## Context & Objective

Owner asked to measure the Pinecone Standard-trial ingest pace and broaden RAG ingestion to make
full use of the trial. Measurement (read-only `rag_usage` queries on the box) showed the app was
using well under 10% of what the trial allows because the free-tier throttle knobs were still in
effect. This rollout applies the trial knob set from
`docs/rollouts/2026-08-09-pinecone-trial-throughput-and-monthly-pace.md` to production and fixes
the bug that broke the first full-universe SEC backfill seed.

## Changes Made

Ops (no code):

- Set in ST Infisical prod and verified live in the serving process after a Coolify restart:
  `VECTOR_EMBED_BATCH_DELAY_MS=0`, `VECTOR_EMBED_BATCH_SIZE=32`,
  `RAG_INGEST_MAX_TEXTS_PER_DAY=250000`, `RAG_PINECONE_MAX_WRITE_UNITS_PER_DAY=2500000`,
  `SEC_FILING_RAG_MAX_PER_RUN=200`, `SEC_FILING_INGEST_TTL_HOURS=6`,
  `SEC_INGEST_WORKER_ENABLED=on`. (`PINECONE_MONTHLY_WU_BUDGET` deliberately left at 0/off during
  the trial; set it to ~1600000 when dropping to a paid/free tier per the throughput rollout note.)
- Copied `data/rag-universe-manifest.json` from the repo onto the prod data volume
  (`/var/lib/docker/volumes/<ST_COOLIFY_APP_UUID>-prod-app-data/_data/`). The volume mounted at
  `/app/data` shadows the image's `data/` directory, so the seeder's default
  `path.resolve("data/rag-universe-manifest.json")` hit ENOENT in production. Any future refresh of
  the manifest must be re-copied to the volume (or the seeder taught an image-path fallback).
- Seeded the SEC ingest backfill via `POST /api/admin/sec-ingest {action:"seed"}` (x-admin-token).

Code:

- `src/lib/web-sources/sec-filings.ts` — the `SubmissionsJson.filings.files[]` type declared
  invented field names `filingStart`/`filingEnd`; real EDGAR shard entries carry
  `filingFrom`/`filingTo` (verified against live `data.sec.gov/submissions/CIK0000320193.json`).
  The shard sort `b.filingEnd.localeCompare(...)` therefore threw
  `Cannot read properties of undefined (reading 'localeCompare')` on the first issuer whose
  filing history needed shard pagination — which the full-universe seed was the first caller deep
  enough to trigger. Renamed to the real fields with a `?? ""` guard so a missing date can never
  throw again.
- `test/sec-backfill-p2.test.ts` — the fixture encoded the same invented field names (which is why
  the suite stayed green while prod broke); corrected to `filingFrom`/`filingTo`.

## Decisions & Trade-offs

- Guarded sort (`?? ""`) instead of schema validation: a shard entry with a missing date sorts
  last instead of aborting the entire multi-issuer seed. The per-shard try/catch already tolerates
  fetch/parse failures; the sort was the only unguarded dereference.
- The seed route aborts on first issuer error (no per-issuer isolation). Left as-is for now —
  seeding is idempotent, so re-running after this fix resumes cleanly. If partial-failure isolation
  is wanted later, wrap the per-issuer loop body in the seeder.

## Verification State

- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` — run via `scripts/land.sh`
  gates before the PR (see PR for receipts).
- Live verification: knob values confirmed in `/proc/<node-pid>/environ` of the new container;
  seed endpoint re-run post-deploy (see STATUS.md for the receipt counts).

## Next Steps & Blockers

- After the deploy lands, re-run the seed and confirm `GET /api/admin/sec-ingest` shows jobs
  queued and the worker draining (checkpoint distribution moving, dead-letter count ~0).
- Watch `rag_usage` daily embed/upsert volume — expect it to jump from ~4k records/day to the
  100k+/day range while the backfill drains.
- Owner decision pending on post-trial plan (free vs $20-ish) → prune/keep strategy at downgrade.
