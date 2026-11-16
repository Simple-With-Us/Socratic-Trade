# Congress share schema drift observability + inbound guards (2026-10-05)

## Context & Objective

Board item `bf84ffba` (P1): outbound `dropInvalidShareRows` silently shrank Congress.Trade coverage when
`congress-trading-shared` row schemas drifted; the inbound securities-import flow had no body cap;
neither inbound App A → App B receiver had request-rate limits.  Harden observability and inbound guards
in Socratic.Trade without editing the shared package (`schemaVersion` on `SharePayload` remains a
follow-up there).

## Changes Made

- `dropInvalidShareRows` now returns per-stream drop counts plus aggregated Zod issue reasons; outbound
  `shareWithCongressTrade` receipts and `runCongressDailyShare` summaries surface `dropped` /
  `rowsDropped` fields.
- Row drops are reported via `audit()`, `console.warn`, and sparse `logWarn` structured logs (not
  `logApiHealth`, which would reset consecutive transport-failure counters).
- Optional `schemaVersion` on inbound/outbound share-shaped JSON is accepted and logged (tolerant reader).
- `SECURITIES_IMPORT_MAX_BYTES` (5 MB, same as congress webhook) + `readJsonWithLimit` on the guarded
  securities-import receiver.
- Per-IP rate limits on the securities-import receiver and the congress webhook ingest route.
- **2026-10-06 follow-up (PR #4220 Kody):** inbound import uses strict `SecuritiesImportPayloadSchema.safeParse` (HTTP 400 on failure) instead of per-row coerce/drop; `src/lib/schema-version.ts` strips control chars and bounds `schemaVersion` length; tests use `TEST_INGEST_TOKEN` / `TEST_WEBHOOK_SECRET`.

Files:

- `src/lib/congress-share.ts`
- `src/lib/securities-import-schema.ts`
- `src/lib/schema-version.ts`
- `src/lib/bounded-body.ts`
- `src/lib/rate-limit.ts`
- `app/api/admin/securities/import/route.ts`
- `app/api/webhooks/congress/route.ts`
- `test/congress-share.test.ts`
- `test/securities-import.test.ts`
- `test/congress-trade-events.test.ts`

## Decisions & Trade-offs

- Still per-row drop, not whole-payload reject — matches existing share contract.
- Row-drop warnings are payload-quality signals, not transport outages (deliberately not `logApiHealth`).
- `schemaVersion` not added to shared `SharePayloadSchema` in this repo; CT/ST must add it in
  `congress-trading-shared` as a follow-up.

## Verification State

```bash
npx tsc --noEmit
npx vitest run test/securities-import.test.ts test/congress-trade-events.test.ts
npx vitest run test/congress-share.test.ts  # intermittent flake: shareWithCongressTrade breaker probe fetch count when full file runs
```

## Next Steps & Blockers

- Add `schemaVersion` to `SharePayloadSchema` in `congress-trading-shared` and pin the version in both apps.
- None for this ST change set.

## Zero-Code Findings

Shared-schema drift should be surfaced with per-stream drop counts and aggregate validation reasons so outbound coverage loss is diagnosable instead of silent.

When aggregating Zod drop reasons for array fields, collapse numeric path indices to `[]` so one bucket covers every bad element instead of minting a key per row index.

`recall contribute "When aggregating Zod drop reasons for array fields, collapse numeric path indices to [] so observability buckets stay bounded under large nightly fan-outs." --category lesson --app socratic-trade`
