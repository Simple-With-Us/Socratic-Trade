# 2026-08-30 -- PR #3120 Codex thread unstick

## Context & Objective

PR #3120 (`ag/st-auth-and-transcripts`, head `bab1cb840`) was MERGEABLE but
BLOCKED on unresolved Codex threads.  Fail-closed mobile snapshot decode,
legacy session-cookie salt, EarningsCalls lane merge, and the ops-snapshot
rollout path.  Do not extra-ship.  Do not TestFlight upload.

## Changes Made

- `MobileSnapshot` again requires a real `readiness` and `policy` object.
  Missing or wrong-shape values reject the snapshot instead of substituting
  `needsAppConsent: false` or `systemState: "stopped"`.
- Mobile auth-redirect carries the source cookie name through the PKCE
  handoff.  Exchange re-encodes a verified NextAuth v4 JWT under the current
  Auth.js cookie salt, or fails closed.
- Connections-health canonicalizes `earningscalls` / `earningscall` onto
  `earningscalls-dev-rapidapi` before injecting the expected lane, so the
  dashboard is one EarningsCalls.dev card.
- Ops-snapshot pin rollout now names `app/admin/connections/connections-health-client.tsx`.

Touched:

- `ios/SocraticTrade/MobileModels.swift`
- `ios/SocraticTradeTests/MobileModelsTests.swift`
- `src/lib/auth/session-cookie-names.ts`
- `src/lib/mobile-auth-handoff.ts`
- `app/api/mobile/auth-redirect/route.ts`
- `app/api/mobile/auth/exchange/route.ts`
- `app/api/admin/connections-health/route.ts`
- `test/session-cookie-names.test.ts`
- `test/mobile-auth-handoff.test.ts`
- `test/mobile-auth-exchange-route.test.ts`
- `test/connections-health-route.test.ts`
- `test/health-lane-cap.test.ts`
- `docs/rollouts/2026-08-30-pr-3120-ops-snapshot-pin.md`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`, this rollout

## Decisions & Trade-offs

- Reject malformed readiness/policy rather than a consent-required fallback.
  The money path must not present a desk that looks consented or stopped
  when the server did not say so.  Inner fields of a valid object still
  keep older-payload defaults.
- Keep accepting NextAuth v4 cookie names, but only the four known names.
  The previous `includes("session-token")` catch-all is gone.
- Merge overlapping EarningsCalls log lanes instead of last-wins so counts
  from both historical names survive as one card.

## Verification State

- `./node_modules/.bin/tsc --noEmit` -- clean.
- `npx vitest run test/session-cookie-names.test.ts test/mobile-auth-handoff.test.ts test/mobile-auth-exchange-route.test.ts test/connections-health-route.test.ts test/health-lane-cap.test.ts` -- 5 files, 27 passed.
- iOS decode tests added; `ios-build` on the next push is the Swift gate.
- No TestFlight.  No `--force-ship`.

## Next Steps & Blockers

- Push `ag/st-auth-and-transcripts`.  Reply then resolve Codex threads.
- Arm `gh pr merge 3120 --squash --auto`.  Do not `--admin`.

## Zero-Code Findings

None.
