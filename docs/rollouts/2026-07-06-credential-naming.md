# SEC User-Agent Credential UI Fix

## Summary
Updated the API Keys settings page to support custom credential terminology, specifically for the SEC EDGAR User-Agent which is not a "key" but a "contact" string.

## Why
The UI previously hardcoded the word "key" in all interactions on the API keys settings page (e.g. "Add key", "server key", "Remove key"). The user noticed that for the SEC User Agent, this terminology was incorrect since it requires a descriptive contact string (name/email), not an API key. 

## Files
- `app/api/keys/route.ts`: Added an optional `credentialName` field to `API_KEY_CATALOG` entries, setting it to `"contact"` for the SEC User-Agent.
- `app/console/settings/lib.ts`: Added `credentialName?: string` to the `ApiKeyEntry` interface.
- `app/console/settings/api-keys.tsx`: Updated the UI to dynamically use `entry.credentialName ?? "key"` for all labels, buttons, toasts, and placeholders, ensuring accurate wording.

## Verification
- `npx tsc --noEmit` - Passed
- `npm run lint` - Passed
- `npm run build` - Pending

## Follow-ups
None at this time. All other credentials correctly default to "key".
