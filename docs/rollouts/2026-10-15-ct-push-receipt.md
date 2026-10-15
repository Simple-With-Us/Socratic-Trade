# Congress.Trade push receipt (ST-3846)

## Context & Objective

Congress.Trade pushes gap-fill market data to Socratic-Trade `POST /api/admin/securities/import`.  A 200 with `ok: true` did not say which push it was, whether the rows were stored, or whether they were readable again.  A retry could not be told apart from a new push.  This adds an idempotent receipt: a push id, a delivered ack, a consumed ack, a health field, and an alert when an ack is missing.

## Changes Made

Socratic-Trade stores the receipt for `x-push-id`.  An `ok` receipt is returned on replay without writing the cache again.  A non-ok receipt is replaced when the same id is retried, so a transient consumed miss or a 500 does not stick.  `health` is `ok` only when the id and both acks are present.  Otherwise the route audits `peer_push_ack_missing`, writes the `congress-inbound-push` health lane, and pages immediately via `alertPeerPushReceiptGap` (that lane is excluded from the generic 5-streak alerter).  `GET /api/ops/snapshot` includes `congressInboundPush`, including a stored 500.

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
- A 500 is stored so the ops snapshot shows the failure.  It is not an `ok` receipt, so the same push id is processed again.  Only `health: ok` with the same payload hash is replayed.  The same ok id with a different payload returns 409 and leaves the stored rows in place.
- Consumed read-back uses the same ticker and date normalization as the writer.  A padded `YYYY-MM-DD` matches the stored date.  A date the writer skips is not a missing consumed ack.
- Own-origin skips still get both acks (`reason: own-origin`) so the no-echo path does not page.
- Datasets this cache does not store (insider, short volume, fundamentals, analyst, trades) stay in `acceptedNotPersisted`.  They do not by themselves clear the consumed ack.
- Congress.Trade does not open the peer circuit on a missing ack.  The HTTP call succeeded.  The alert is the receipt, not an outage.

## Verification State

```bash
npx vitest run test/peer-push-receipt.e2e.test.ts test/securities-import.test.ts
# 33 passed (5 in the e2e file, 28 in securities-import) after the payload-mismatch 409
npx tsc --noEmit
# exit 0
npx eslint src/lib/peer-push-receipt.ts src/lib/securities-import-schema.ts src/lib/db-securities-import.ts src/lib/db-health.ts src/lib/ops-snapshot.ts app/api/admin/securities/import/route.ts test/peer-push-receipt.e2e.test.ts
# 0 errors (one pre-existing no-explicit-any warning in ops-snapshot.ts)
```

`npm test` on the first receipt commit: 9379 passed, 51 skipped, 23 failed.  Failures were alpha-vantage-key-pool, chat-llm, cpuprofile-summary, framework-review, llm-provider, notify-body-tiers, notify-user-creds, openrouter-credits, persistence-notification, red-team, and server-metrics.  None are the receipt files.  llm-provider / openrouter-credits / chat-llm / framework-review were already failing in this sandbox.  That full run finished before the non-ok retry follow-up.  The follow-up is covered by the targeted vitest file and `tsc`.

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
