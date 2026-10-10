# 2026-10-07 — `__rotate__` OpenRouter access-denied failover depth

## Context & Objective

Prod Autopilot (`__rotate__` Green + Red) saw three consecutive failed runs with OpenRouter HTTP 403 ("Your OpenRouter key doesn't have access to this model or region") and "Failover chain exhausted (3 Green Team endpoints)" while the scheduler stayed healthy.  The implicit rotation failover cap was pick + two alternates, so several inaccessible slugs could exhaust the chain before a reachable seat was tried.

## Changes Made

- Raised the implicit rotation failover cap (`ROTATION_IMPLICIT_GREEN_FAILOVERS` 2 → 12, hard cap 18) so Green and Red chains can walk further through the eligible pool on 403/404 access errors.
- Added `rotationPoolExcludingCooldown()` and applied it when resolving rotation picks so per-user 403 cooldown slugs are skipped at pick time, with fail-open when every member is cooling (same rule as `/models/user` allowlist emptying).
- Tests: expanded `test/model-rotation.test.ts`; new `test/strategy-rotation-openrouter-403-failover.test.ts` (Green completes after more than three 403 attempts).

**Files**

- `src/lib/model-rotation.ts`
- `test/model-rotation.test.ts`
- `test/strategy-rotation-openrouter-403-failover.test.ts`
- `STATUS.md`, `PLAN.md`, `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Kept `__rotate__` and existing 403 per-user cooldown recording in `strategy.ts` / `red-team.ts`; this change only deepens the implicit chain and avoids re-picking recently denied slugs.
- Cap remains bounded (not the full 21-model catalog every run) to limit credit burn on empty/malformed-200 glitches.

## Verification State

Re-run on this seat 2026-10-09.  `node_modules` was missing, so install was `npm ci` (exit 0, 733 packages).  The build used the same heap cap as `verify-hosted`.

```bash
npm ci                                                  # exit 0
npm run lint                                            # exit 0 (0 errors, 866 warnings)
npx tsc --noEmit                                        # exit 0
npm test                                                # exit 1
NODE_OPTIONS=--max-old-space-size=4096 npm run build    # exit 0
```

`npm test` (`vitest run`): Test Files 1 failed | 811 passed | 1 skipped (813).  Tests 1 failed | 9120 passed | 51 skipped (9172).  Duration 1233.03s.

Environment failure, not a product regression.  Test name: `test/egress-guard.test.ts` > `validateWebhookUrl — user-configured notification webhook (SSRF guard)` > `uses real DNS by default when no resolver is injected (production path)`.  `discord.com` resolved to `198.18.0.1` (same answer for `example.com` and `openrouter.ai`).  `198.18.0.0/15` is a blocked benchmark range in `isPrivateOrReservedIpv4`, so `validateWebhookUrl("https://discord.com/api/webhooks/x")` returned `ok: false` (expected `true` on real public DNS).

`npm run build` exit 0.  The production build lists `ƒ Proxy (Middleware)`.

## Next Steps & Blockers

- Local `npm test` is exit 1 because of the sandbox DNS failure named above.  Merge only after CI `verify` is green.  No Coolify restart or deploy from this agent session (owner directive).
- After ship, confirm Autopilot Paper/Sandbox runs complete with `__rotate__` when some catalog slugs are region-restricted on the keyed OpenRouter account.

## Zero-Code Findings

- Live failure pattern matches a shallow failover chain, not SQLite/event-loop or scheduler stall.
