# 2026-07-24 Connections UI Redesign & Ghost API Key Tombstoning

## Context & Objective
1. **Connections UI Redesign (`app/console/settings/brokers.tsx`)**: Streamlined account cards to be >25% shorter vertically, reorganized account tags and badges (moved `PAPER` into the `Load` button, removed title badges, placed account tax type inline), added strategy execution status & pending proposal counts to card headers, replaced the inline `capabilities unconfirmed` yellow banner with an on-demand `Capabilities` sheet, and simplified the `Future Brokers` roadmap section.
2. **Ghost API Key Deletion Fix (`src/lib/db-api-keys.ts` & `src/lib/st-primary-bridge-writer.ts`)**: Resolved the issue where deleted Google (Gemini) and DeepSeek keys re-appeared on server restart due to ambient environment fallback and boot re-migration. Implemented explicit tombstoning (`DELETED_KEY_TOMBSTONE = "__DISABLED__"`) when a user deletes a key.

## Changes Made
- `app/console/settings/brokers.tsx`: Redesigned `renderAccountRow`, added `CapabilitiesSheet` modal, updated `Future Brokers` roadmap layout.
- `src/lib/db-api-keys.ts`: Implemented `DELETED_KEY_TOMBSTONE` in `deleteUserApiKey`, updated `getUserApiKey`, `listUserApiKeys`, `resolveApiKeyWithSource`, and `resolveLlmCredential` to fail closed and block environment fallbacks when tombstoned.
- `src/lib/st-primary-bridge-writer.ts`: Updated `desiredEntries` to treat tombstoned keys as `revoked`.
- `test/api-keys-tombstone.test.ts`: Added unit tests verifying tombstoning, environment fallback suppression, and prevention of boot re-migration.

## Verification State
- `npx eslint . --quiet`: Passed cleanly.
- `npx tsc --noEmit`: Passed cleanly with zero type errors.
- `npx vitest run test/api-keys-tombstone.test.ts`: All 3 tests passed.

## Next Steps
Land via `scripts/land.sh` and allow auto-merge to deploy to production.
