# Congress.Trade → Socratic Trade push delivery/consumption receipt (ST-3846)

## Context & Objective

Congress.Trade webhook pushes previously treated any HTTP 2xx as success without reading App B's JSON body, so consumption failures (invalid events, partial batch failures) were invisible and deliveries were marked `delivered` incorrectly.  This adds a versioned consumption receipt on App B and requires App A to validate `consumed` before closing a delivery.

## Changes Made

- `src/lib/congress-push-receipt.ts` — `receiptVersion: 1` envelope (`delivered`, `consumed`, `applied`, per-event `results[]`).
- `app/api/webhooks/congress/route.ts` — returns receipt JSON; `422` when `consumed=false` (including batch partial failure).
- `docs/push-to-app-b.md` — documents §4b receipt contract.
- Tests: `test/congress-push-receipt.test.ts`, webhook endpoint expectations in `test/congress-trade-events.test.ts`.

**Congress.Trade (separate PR):** `app/src/delivery/pushReceipt.ts`, `webhook.ts` reads/parses receipt, retries on `consumed=false`.

**Shared package follow-up:** identical schema/helpers prepared for `congress-trading-shared` v2.8.0 (`pushReceipt.ts`); publish when the shared repo accepts the tag.

## Decisions & Trade-offs

- **HTTP 422** on consumption failure (was 400 for single-event failures) so App A can distinguish auth/parse errors from apply failures while still retrying both.
- **Legacy bodies** without `receiptVersion` remain parseable on App A during rollout (`ok` + `applied`).
- **SSE** unchanged — no HTTP response path; webhook is the receipt transport.

## Verification State

```bash
npx vitest run test/congress-push-receipt.test.ts test/congress-trade-events.test.ts test/congress-webhook-parity.test.ts  # 47 passed
npm run lint   # 0 errors
npx tsc --noEmit  # clean
```

Congress.Trade delivery tests (separate worktree):

```bash
npm test -- src/delivery/__tests__/pushReceipt.test.ts src/delivery/__tests__/queueRetry.test.ts src/delivery/__tests__/deliveryEntitlement.test.ts  # 23 passed
```

## Next Steps & Blockers

- Merge App B PR, then Congress.Trade PR; deploy both before relying on receipts in prod dashboards.
- Land `congress-trading-shared@2.8.0` and repoint both apps to the shared export (local duplicates today).
