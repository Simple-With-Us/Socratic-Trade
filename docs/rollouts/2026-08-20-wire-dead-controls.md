# Wire dead tax / webhook / preset controls (expert review cluster `dead-controls`)

## Context & Objective

Part II of `docs/reviews/2026-08-18-full-app-expert-review.md` flagged three shipped console controls whose labels promised behavior the backend never performed.  This change wires each control to the existing server behavior (or removes it — we wired all three).

## Changes Made

- **Results net-of-tax:** `taxSettings.subtractFromResults` now subtracts `estimatedTaxLiability` from realized P&L in `BucketCard` and shows net short/long-term realized figures in `TaxBlock` when the toggle is on.
- **Policy webhook test:** `POST /api/notifications/test` now also probes `policy.notificationSettings.webhookUrl` via `sendPolicyWebhookTest` (Discord embed path), labeled **Policy webhook URL** in results.
- **Preset CRUD:** Strategy → Presets gains Create (save current account strategy), Rename, and Delete, calling existing `/api/profiles` POST/PUT/DELETE routes.

**Files touched**

- `src/lib/tax.ts` — `realizedPnlNetOfEstimatedTax` helper
- `src/lib/notifications.ts` — `sendPolicyWebhookTest`
- `app/api/notifications/test/route.ts`
- `app/console/results/page.tsx`
- `app/console/lib/api.ts` — `createProfile` / `updateProfile` / `deleteProfile`
- `app/console/strategy/page.tsx` — `PresetLibrary` component
- `test/tax.test.ts`
- `test/notifications-test-route.test.ts`

## Decisions & Trade-offs

- Net-of-tax applies to the active account bucket only (comparison accounts have no tax summary in the picker response).
- Legacy webhook test reuses `sendLegacyWebhook` / Discord embed formatter rather than the notify-channel webhook (generic JSON).
- Preset delete uses `window.confirm` — minimal scope; no new modal component.

## Verification State

```bash
npm run lint          # 0 errors (warnings only)
npx tsc --noEmit      # clean
npm test -- test/tax.test.ts test/notifications-test-route.test.ts  # 27 passed
npm run build         # clean
```

Manual: Strategy → Presets — created "Test Preset CRUD", Rename/Delete visible (screenshot `presets_crud_create.webp`).

## Next Steps & Blockers

- None for this cluster.  Other expert-review clusters remain open in the review doc.

## Zero-Code Findings

None.
