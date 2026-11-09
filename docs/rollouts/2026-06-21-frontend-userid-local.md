# Rollout: 2026-06-21 Frontend userId=local Cleanup

## Summary

Removed hardcoded `userId=local` query parameter from four API call sites in the frontend. This is a pure mechanical cleanup with zero functional impact, as the backend (`src/lib/request-user.ts`) resolves user identity exclusively from the verified `x-authenticated-user-email` header and ignores any `userId` parameter in the query string or request body.

## Why

The frontend was sending `userId=local` to the API, but this parameter was never used by the server. Removing it simplifies the API contract and reduces unnecessary parameter passing.

## Files Changed

- `app/dashboard-client.tsx` (2 locations)
  - Line 2824: Removed `?userId=local` from GET `/api/keys`
  - Line 2863: Removed `userId=local&` from DELETE `/api/keys?service=...`

- `app/ui/dashboard/settings.tsx` (2 locations)
  - Line 404: Removed `?userId=local` from GET `/api/keys`
  - Line 443: Removed `userId=local&` from DELETE `/api/keys?service=...`

## Verification

All verification commands passed:

```bash
npx tsc --noEmit
# (no errors)

npm test
# Test Files  60 passed (60)
#      Tests  464 passed (464)

npm run build
# (completed successfully)
```

Post-change verification that all instances were removed:
```bash
grep -rn "userId=local" app/
# (no results)
```

## Follow-ups

None. The change is complete and verified.
