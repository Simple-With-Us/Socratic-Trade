# Congress share schema drift observability + inbound guards (2026-10-05)

## 1. Context & Objective

Board item `bf84ffba` (P1): outbound `dropInvalidShareRows` silently shrank Congress.Trade coverage when
`congress-trading-shared` row schemas drifted; inbound `/api/admin/securities/import` had no body cap;
neither inbound route had request-rate limits.  Harden observability and inbound guards in Socratic.Trade
without editing the shared package (`schemaVersion` on `SharePayload` remains a follow-up there).

## 2. Changes Made

- `dropInvalidShareRows` now returns per-stream drop counts plus aggregated Zod issue reasons; outbound
  `shareWithCongressTrade` receipts and `runCongressDailyShare` summaries surface `dropped` /
  `rowsDropped` fields.
- Row drops are reported via `audit()`, `logWarn`, and fingerprinted Sentry `captureMessage` (not
  `logApiHealth`, which would reset consecutive transport-failure counters).
- Optional `schemaVersion` on inbound/outbound share-shaped JSON is accepted and logged (tolerant reader).
- `SECURITIES_IMPORT_MAX_BYTES` (5 MB, same as congress webhook) + `readJsonWithLimit` on
  `/api/admin/securities/import`.
- Per-IP rate limits on `/api/admin/securities/import` and `/api/webhooks/congress`.
- Inbound coerce paths report `rowsDropped` in the import response when malformed rows are skipped.

Files:

- `src/lib/congress-share.ts`
- `src/lib/bounded-body.ts`
- `src/lib/rate-limit.ts`
- `app/api/admin/securities/import/route.ts`
- `app/api/webhooks/congress/route.ts`
- `test/congress-share.test.ts`
- `test/securities-import.test.ts`
- `test/congress-trade-events.test.ts`

## 3. Decisions & Trade-offs

- Still per-row drop, not whole-payload reject — matches existing share contract.
- Sentry at `warning` level: payload-quality signal, not a transport outage.
- `schemaVersion` not added to shared `SharePayloadSchema` in this repo; CT/ST must add it in
  `congress-trading-shared` as a follow-up.

## 4. Verification State

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build  # PASS
```

## 5. Next Steps & Blockers

- Add `schemaVersion` to `SharePayloadSchema` in `congress-trading-shared` and pin the version in both apps.
- None for this ST change set.

## 6. Zero-Code Findings

Shared-schema drift should be surfaced with per-stream drop counts and aggregate validation reasons so outbound coverage loss is diagnosable instead of silent.

`recall contribute "Shared-schema drift should be surfaced with per-stream drop counts and aggregate validation reasons so outbound coverage loss is diagnosable instead of silent." --category lesson --app socratic-trade`
