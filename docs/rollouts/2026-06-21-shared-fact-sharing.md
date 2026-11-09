# 2026-06-21 — Shared Fact Sharing (learned_context)

## Summary

Implemented cross-user shared-fact sharing for `learned_context` rows. Only **fact-tier** rows
are ever eligible to become `scope='shared'`; risk and strategy-directive tiers are routed to
the pending-approval queue and are never shared automatically. PII is excluded upstream before
`ingestLearned` is called.

## What Changed

### New: `LearnedContextSharingPrefs` helpers in `src/lib/db-settings.ts`

Two flags stored as `user_settings` (reuses `getUserSetting` / `setUserSetting`):

| Flag | Default | Meaning |
|------|---------|---------|
| `includeShared` | `true` | Read shared facts written by other opted-in users |
| `contributeShared` | `false` | Share this user's own learned facts with the pool |

`getLearnedContextSharing(userId)` returns the prefs (with safe defaults).
`setLearnedContextSharing(userId, patch)` merges a partial update and persists.

### Modified: write side in `src/lib/learned-context/store.ts`

`ingestLearned` now reads `contributeShared` for the writing user:
- `contributeShared = true` → fact row written with `scope='shared'` + `contributorUserId` stamped.
- `contributeShared = false` (default) → `scope='private'` (existing behavior).
- Risk/strategy-directive rows still route to the pending queue, never reach this branch.

### Modified: read side in `src/lib/learned-context/store.ts`

`retrieveLearnedContext` now reads `includeShared` from the user's stored preference:
- When `options.includeShared` is supplied explicitly (e.g. from tests), it takes precedence.
- Otherwise the user's persistent `includeShared` preference is used (default `true`).
- Delegates to the pre-existing `listLearnedContextForDecision` db helper which already
  implements the safe `(user_id = ?) OR (scope = 'shared')` query — a different user's
  `scope='private'` rows can **never** be returned to another reader.

### New: `app/api/learned-context/sharing/route.ts`

- `GET /api/learned-context/sharing` — returns current prefs for the authenticated user.
- `PUT /api/learned-context/sharing` — accepts `{ includeShared?, contributeShared? }` partial.

### Modified: `app/dashboard-client.tsx`

Added two toggles to the Settings → Data section, below the existing shared data-pool toggle:
- **Include shared learnings** (defaults ON) — controls `includeShared`.
- **Contribute my learnings to the shared pool** (defaults OFF) — controls `contributeShared`.

State is loaded on first visit to the "data" section via `GET /api/learned-context/sharing`.
Each toggle fires `PUT /api/learned-context/sharing` immediately on change.

## Safety Invariants (all tested)

1. **Only fact-tier rows are ever `scope='shared'`** — risk/directive rows go to the pending queue.
2. **A different user's `PRIVATE` row is NEVER returned to another reader** — the db query widens
   only to `scope = 'shared'`, never to another user's `scope = 'private'`.
3. **Default `contributeShared = false`** — nothing is shared without explicit opt-in.
4. **PII never enters a shared row** — the PII gate runs before scope is decided.

## Files Touched

- `src/lib/db-settings.ts` — added `LearnedContextSharingPrefs`, `getLearnedContextSharing`, `setLearnedContextSharing`
- `src/lib/learned-context/store.ts` — write side scopes facts per `contributeShared`; read side reads `includeShared` from prefs
- `app/api/learned-context/sharing/route.ts` — new API route (GET/PUT)
- `app/dashboard-client.tsx` — two new toggles in Settings → Data section
- `test/learned-context-sharing.test.ts` — new test file (13 tests)
- `docs/rollouts/2026-06-21-shared-fact-sharing.md` — this file

## Verification

```bash
cd /Users/jay/apps/wt-sharing && npx tsc --noEmit   # ✓ no errors
cd /Users/jay/apps/wt-sharing && npm test            # ✓ 753/753 passed (83 files)
cd /Users/jay/apps/wt-sharing && npm run build       # ✓ compiled successfully
```

## Follow-ups / Deferred

- No deferred items — backend, API, UI toggles, and tests are all complete and green.
- The existing `listLearnedContextForDecision` query does not require modification; it already
  supports the `includeShared` boolean added in a prior slice.
- A future slice could add per-contributor provenance display in the UI (contributor attribution
  is already stored via `contributorUserId`).
