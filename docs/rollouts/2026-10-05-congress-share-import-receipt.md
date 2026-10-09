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

- **Mapping:** `prices` (price series chunks) ↔ `pricedTickers`. `countCloses` (`sent.closes`) includes SPX rows, which App A reports as `spxRows`; the receipt compares `sent.closes - sent.spx` to `priceRows` (per-ticker closes only). CT also returns `perfTickers` (recomputed trade anchors); ST does not use it for receipt.
- **Trades:** App A has no `tradesRows` field yet. A trades-only payload is POSTed (it counts toward the empty check). If `sent.trades > 0` and the body has no integer `tradesRows`, the receipt fails with an explicit message; an integer `tradesRows` is compared like the other tallies.
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

**2026-10-07 rebase.**  Rebased onto `origin/main` with no conflict hunks.  `sent.closes` no longer compared raw to `priceRows` (SPX rows stay on `spxRows`).  Trades count toward the empty check and honor an integer `tradesRows` when present.  The pre-existing schemaVersion test now mocks a full receipt body.

```bash
npx vitest run test/congress-share.test.ts   # 84 passed
npx tsc --noEmit                             # exit 0
```

## 2026-10-09 — Kody receipt schema + shortfall dropMeta

### Context & Objective

Kody rules 8 and 11 flagged `parseCongressImportAcceptedCounts` for reading App A's 2xx JSON through an `as Record<string, unknown>` cast and `nonNegativeIntField`.  A third finding noted the receipt-shortfall return omitted `dropMeta`, so a POST that both drops schema-invalid rows and fails the receipt check under-reported dropped rows in the nightly summary.

### Changes Made

- Exported `ImportedReceiptSchema`: a strict `z.object` whose eight tally fields are `z.number().int().nonnegative()`.
- `parseCongressImportAcceptedCounts` calls `ImportedReceiptSchema.strip().safeParse(response)` first.  On failure it returns the existing `{ ok: false, reason }` strings (empty/unparseable vs missing counts).
- `tradesRows` is read with `TradesRowsReceiptSchema` instead of a cast.  `nonNegativeIntField` is gone.
- The shortfall return in `shareWithCongressTrade` spreads `...dropMeta`.

**Files touched**

- `src/lib/congress-share.ts`
- `test/congress-share.test.ts`
- `docs/rollouts/2026-10-05-congress-share-import-receipt.md`
- `docs/EFFORT-LOG.md`
- `STATUS.md`
- `PLAN.md`

### Decisions & Trade-offs

- **Strip, do not reject, envelope keys.**  `.strict()` on the eight fields rejects `ok`, `errors`, and `perfTickers`, which App A's documented 2xx body includes.  Rejecting them would fail every valid receipt and stop the daily marker.  `strip()` keeps the tally types strict and leaves valid-receipt counts unchanged.  A direct `ImportedReceiptSchema.safeParse` (no strip) still rejects unknown keys.
- **`tradesRows` stays off the eight-field schema.**  A non-integer `tradesRows` still means "no receipt" and does not fail the other tallies.

### Verification State

```bash
npx vitest run test/congress-share.test.ts test/congress-share-price-targets.test.ts   # 91 passed
npx tsc --noEmit                                                                       # exit 0
```

Branch was already even with `origin/main` (`git rev-list --left-right --count origin/main...HEAD` = 0 ahead on main).  No merge commit.

### Next Steps & Blockers

- Push.  Do not merge.  Do not resolve Kody threads from this lane.  CI `verify` is the merge gate.

## Next Steps & Blockers

- None for merge.  Owner: no extra-ship.  If CT later adds a `trades` accepted count, map it in `congressImportAcceptedReceiptError` and extend tests.

## Zero-Code Findings

- CT import handler verified in public `Simple-With-Us/Congress.Trade` (`app/src/admin/routes.ts`, `securitiesImportRefs.test.ts`): summary shape matches the eight fields above.
