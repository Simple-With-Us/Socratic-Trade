# Congress-share import consumption receipt (board `52f0143da16d44b8`)

## Context & Objective

Socratic-Trade's `shareWithCongressTrade` treated HTTP 200 + `ok:true` + empty `errors[]` as delivery success even when Congress.Trade (App A) accepted fewer rows than ST sent.  App A's `POST /api/admin/securities/import` already returns per-dataset accepted tallies on every 2xx; this change parses them, fails closed when counts are missing, and compares `accepted < sent` so partial consumption surfaces in health logs and audit instead of silent success.

## Changes Made

- Parse CT import summary fields (`refs`, `spxRows`, `pricedTickers`, `priceRows`, `insiderRows`, `shortVolumeRows`, `fundamentalsRows`, `analystRows`) and compare to outbound `sent` counts.
- Stamp optional `schemaVersion: 1` on the import POST body (unknown keys are ignored by App A).
- On shortfall or missing receipt: `audit("congress_share_import_receipt_shortfall", …)`, `logApiHealth` with `ok: false`, return `ok: false` from `shareWithCongressTrade`.
- Tests: `parseCongressImportAcceptedCounts`, `congressImportAcceptedReceiptError`, integration paths for missing counts and `accepted < sent`; `ctImportOkBody()` helper for mocks.

**Files touched**

- `src/lib/congress-share.ts`
- `test/congress-share.test.ts`
- `docs/rollouts/2026-10-05-congress-share-import-receipt.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`

## Decisions & Trade-offs

- **Mapping:** `prices` (price series chunks) ↔ `pricedTickers`; `closes` (flattened close rows) ↔ `priceRows`.  CT also returns `perfTickers` (recomputed trade anchors); ST does not use it for receipt because outbound price chunks are counted via `pricedTickers` / `priceRows`.
- **Trades:** ST may send `trades` in the payload; App A has no trades receipt field yet — if `sent.trades > 0`, receipt check fails with an explicit message (no pretend success).
- **Fail closed:** A 200 body without all eight integer count fields is a failure (same class as unparseable body for marker advancement).
- **Shared package:** No `SharePayloadSchema` change; `schemaVersion` is wire-only on the POST envelope.

## Verification State

```bash
npm run lint          # 0 errors (warnings only)
npx tsc --noEmit      # clean
npm test -- test/congress-share.test.ts   # 77/77 passed
npm test              # 9052 passed; 8 failed in unrelated files (pre-existing)
npm run build         # (run at handoff)
```

## Next Steps & Blockers

- None for merge.  Owner: no extra-ship.  If CT later adds a `trades` accepted count, map it in `congressImportAcceptedReceiptError` and extend tests.

## Zero-Code Findings

- CT import handler verified in public `Simple-With-Us/Congress.Trade` (`app/src/admin/routes.ts`, `securitiesImportRefs.test.ts`): summary shape matches the eight fields above.
