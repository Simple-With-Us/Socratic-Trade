# Congress.Trade push receipt (ST-3846)

## Context & Objective

Congress.Trade pushes gap-fill market data to Socratic-Trade `POST /api/admin/securities/import`.  A 200 with `ok: true` did not say which push it was, whether the rows were stored, or whether they were readable again.  A retry could not be told apart from a new push.  This adds an idempotent receipt: a push id, a delivered ack, a consumed ack, a health field, and an alert when an ack is missing.

## Changes Made

Socratic-Trade stores the first receipt for `x-push-id` and returns it on replay without writing the cache again.  `health` is `ok` only when the id and both acks are present.  Otherwise the route audits `peer_push_ack_missing` and writes the `congress-inbound-push` health lane, which is the existing connection-failure alert path.  `GET /api/ops/snapshot` includes `congressInboundPush`.

Congress.Trade `shareWithPeer` sends the push id, reads the receipt, and alerts (Sentry warn plus the throttled admin email) when either ack is missing.  HTTP success without a receipt is not treated as a delivered push.

- `src/lib/peer-push-receipt.ts`
- `src/lib/securities-import-schema.ts`
- `src/lib/db.ts`
- `src/lib/db-securities-import.ts`
- `src/lib/ops-snapshot.ts`
- `app/api/admin/securities/import/route.ts`
- `test/peer-push-receipt.e2e.test.ts`
- `docs/congress-trade-share.md`
- `docs/rollouts/2026-10-15-ct-push-receipt.md`
- `STATUS.md`
- `PLAN.md`
- Congress.Trade `app/src/share/peerPushReceipt.ts`
- Congress.Trade `app/src/share/outbound.ts`
- Congress.Trade `app/src/share/__tests__/outbound.test.ts`
- Congress.Trade `app/src/share/__tests__/peerPushReceipt.test.ts`
- Congress.Trade `docs/rollouts/2026-10-15-st-push-receipt.md`

## Decisions & Trade-offs

- The push id travels in `x-push-id` and in the JSON body.  The header wins.  The shared `SharePayloadSchema` still strips unknown keys, so Congress.Trade adds `pushId` after that parse and Socratic-Trade's local schema keeps it.
- Delivered means the request was accepted.  Consumed means every persistable row (refs, prices, spx) reads back from the import cache, or the push had nothing this cache stores (empty, own-origin, or acknowledged-not-persisted datasets).  A failed read-back leaves `consumed` null.
- A 500 is not stored.  The same push id can be retried.  A stored receipt, including `missing-consumed-ack`, is what a replay returns.
- Own-origin skips still get both acks (`reason: own-origin`) so the no-echo path does not page.
- Datasets this cache does not store (insider, short volume, fundamentals, analyst, trades) stay in `acceptedNotPersisted`.  They do not by themselves clear the consumed ack.
- Congress.Trade does not open the peer circuit on a missing ack.  The HTTP call succeeded.  The alert is the receipt, not an outage.

## Verification State

```bash
npx vitest run test/peer-push-receipt.e2e.test.ts test/securities-import.test.ts
# 31 passed after the push-id resolver fix (3 in the e2e file, 28 in securities-import)
npx tsc --noEmit
# exit 0
npx eslint src/lib/peer-push-receipt.ts src/lib/securities-import-schema.ts src/lib/db-securities-import.ts src/lib/ops-snapshot.ts app/api/admin/securities/import/route.ts test/peer-push-receipt.e2e.test.ts
# 0 errors (one pre-existing no-explicit-any warning in ops-snapshot.ts)
```

Congress.Trade, from `app/`:

```bash
npx vitest run src/share/__tests__/outbound.test.ts src/share/__tests__/peerPushReceipt.test.ts
# 12 passed
```

## Next Steps & Blockers

- Both pull requests need to be live before a production push carries the receipt.  Until Socratic-Trade is deployed, Congress.Trade will alert on the old `{ ok: true }` body.  That alert is throttled to one email per 12 hours.
- Do not mark ST-3846 completed until both pulls are merged.

## Zero-Code Findings

- PR #4228 already parses App A's accepted counts on the opposite push (Socratic-Trade to Congress.Trade).  This note is the return path, Congress.Trade to Socratic-Trade.
