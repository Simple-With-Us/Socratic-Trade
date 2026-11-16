# Congress.Trade companion changes (ST-3846)

This cloud seat could not push to `Simple-With-Us/Congress.Trade` (403).  Apply `congress-trade.patch` on branch `cursor/congress-push-receipt-6277` and open a **ready** PR there.

```bash
cd ~/path/to/Congress.Trade
git fetch origin main
git checkout -b cursor/congress-push-receipt-6277 origin/main
git am /path/to/congress-trade.patch
npm test -- src/delivery/__tests__/pushReceipt.test.ts src/delivery/__tests__/queueRetry.test.ts src/delivery/__tests__/deliveryEntitlement.test.ts
```

`pushReceipt.ts` is included standalone for review without applying the patch.
