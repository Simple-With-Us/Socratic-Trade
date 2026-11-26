# 2026-11-26 — ST-4689 web batch 2: dashboard `fields=` slice, three snapshot-independent routes, consent in the payload, single-tree Orders/Watchlist/Positions, ApprovalCard decision link

## 1. Context & Objective

Child of the ST-4668 roadmap reconciliation, queued as "web batch 2" with no owner decision needed (section 5).  Four web-console residuals from the 2026-11-21 audit and the OD-11 batch: W13 (server-side dashboard slice plus three routes that should not wait on the snapshot), W15 (consent state missing from the dashboard payload), W20 (Orders, Watchlist and Positions each mounted a desktop table AND a phone card list), and W27 (the approval card had no link to its decision trace).  It also absorbs the `fields=` item from ST-4667 and applies the scan page's single-tree pattern to the two pages ST-4667 names.

## 2. Changes Made

- **`app/dashboard-slice.ts` (new).**  `DASHBOARD_SNAPSHOT_FIELDS` lists every top-level `DashboardSnapshot` field, with a compile-time completeness guard (`DASHBOARD_FIELD_LIST_IS_COMPLETE`) so adding a field without listing it fails typecheck.  `parseDashboardFields` accepts a comma list, repeated parameters, or both; unknown names are returned (sorted, deduped) instead of dropped; an empty value means the full payload.  `sliceDashboardSnapshot` returns the requested keys in the snapshot's own insertion order plus two partial markers and the consent block.
- **`app/api/dashboard/route.ts`.**  Parses `fields=` before any compute and answers `400 { error, allowed }` for unknown names.  Merges `buildDashboardConsent(user.userId)` AFTER the coalesced read so an accept is visible on the next poll rather than after the ~10s snapshot TTL, then slices when a selection was given.
- **`src/lib/dashboard-consent.ts` (new).**  `DashboardConsent` record and `buildDashboardConsent(userId)` — legal record, data-pool record, both current versions, and the combined `needsConsent` flag.  No user id, email, token, or key is in the record.
- **`app/dashboard-types.ts`.**  `DashboardSnapshot.consent?: DashboardConsent` (optional so older payloads and fixtures stay valid).
- **`app/console/components/consent-gate.tsx`.**  Reads `useConsoleSnapshotOptional()?.consent` and fires NO consent requests on a normal load; the old two-GET path remains as a fail-closed fallback for a payload without the field.  Accepting still POSTs to `/api/legal-notice` and `/api/consent`, and a local accept latches the dialog closed while the in-flight/cached snapshot may still say `needsConsent`.
- **`app/console/components/shell.tsx`.**  `/console/watchlist` joins `SNAPSHOT_INDEPENDENT_ROUTES` (it reads nothing from the snapshot); `/console/lessons` and `/console/decisions` join `SELF_SKELETON_ROUTES` (they read the snapshot only through the optional hook and own their data fetch), with the allowlist comments updated to say exactly what each reads.
- **`app/console/lessons/framework-proposals.tsx`.**  A null snapshot now renders "Waiting for the dashboard snapshot to list framework proposals" instead of the false "No framework proposals yet" while the list is still in flight.
- **`app/console/orders/page.tsx`.**  `OpenOrderTr` + `OpenOrderCard` collapse into `OpenOrderRow({ layout })`, and the finished-orders inline row + `FinishedOrderCard` collapse into `FinishedOrderRow({ layout })`.  The page mounts ONE tree with `useIsDesktopConsole()`; the `hidden lg:block` / `lg:hidden` pair is gone.
- **`app/console/watchlist/page.tsx`.**  Both inline trees become `WatchlistRow({ layout })`, gated the same way.
- **`app/console/components/positions.tsx`.**  `PositionRow({ row, layout })` and `OptionPositionRow({ opt, layout })`, gated the same way; the per-position derivation stays computed once in `PositionsCard` and is shared by both layouts.
- **`app/console/components/approval-card.tsx`.**  A pending proposal whose `proposalId` matches a `SocraticDecisionCase` in the snapshot now shows an "Open decision trace" link to `/console/decisions/<decision id>`.  When no case is in the account-scoped latest-50 window, the link is omitted rather than fabricated.
- **`test/web-batch-2.test.ts` (new).**  16 tests: parse/slice rules, the route's 400 and its consent-after-coalesce ordering, the consent record shape and version flip (temp SQLite), the route allowlists, the Lessons waiting copy, the one-component/two-call-site/gated shape of all three surfaces, and the ApprovalCard lookup+link wiring.

## 3. Decisions & Trade-offs

- **The console's shared poll still requests the full snapshot.**  The shell's chrome reads a wide subset of the snapshot on every route (policy, accounts, pending counts, notifications, run state), so switching the one shared poll to per-route slices would make the snapshot object change shape under mounted pages.  The slice is server support for narrow callers (scripts, diagnostics, a future per-route client profile); a client rollout is deliberately left out of this batch.
- **`consent`, `partialData`, and `partialReason` are always included in a slice.**  A narrowed response that hid them could render a complete-looking screen from partial data or skip the first-use gate.  Consent is never fabricated: a snapshot that predates the field stays without it and the gate falls back to its own GETs.
- **Lessons and Decisions are SELF_SKELETON, not SNAPSHOT_INDEPENDENT.**  Both read the snapshot through the optional hook (account labels; admin flag and framework list), so listing them as "reads zero fields" would make the allowlist comment untrue even though the visual result is identical.
- **One tree per breakpoint, not two hidden ones.**  This is the audit #9 fix and the ST-4667 item: CSS `hidden` does not unmount, so every order, watchlist row and position existed twice in the DOM.  `useIsDesktopConsole()` corrects the initial `true` in a layout effect before paint, matching the scan table.
- **The ApprovalCard link uses the existing snapshot lookup, no new endpoint.**  `snapshot.socratic.decisions` is account-scoped and capped at the 50 newest cases, so a proposal older than that window has no link.  The alternative (fetching `/api/socratic/decisions?limit=100` per card) would add a request per card for a link that is usually present.

## 4. Verification State

All commands run in the lane `<lane>` (Node 22 on this box; CI uses Node 26):

- `npx tsc --noEmit` — PASS (exit 0).
- `npx vitest run test/web-batch-2.test.ts` — PASS (19 tests).
- `npx vitest run test/dashboard-coalesce.test.ts test/console-web-p0-fixes.test.tsx test/console-batch-a2-ux.test.ts test/console-decisions-index.test.ts test/legal-notice-consent.test.ts test/data-pool-consent.test.ts test/console-route-data-profile.test.ts` — PASS (51 tests).
- `npx vitest run test/console-*.test.ts test/console-*.test.tsx` — PASS (44 files, 496 tests).
- `npx eslint` over the changed files — 0 errors; the 3 warnings are pre-existing lines (approval-card 1011/1127, watchlist 98).
- `node scripts/copy-rules-lint.mjs --dir app/console` — totals identical to `main` (46 sentence-gap / 109 title-case backlog, 0 new), after restoring a U+00A0 the rewrite had flattened in the consent-gate error sentence.
- Full `npm run lint`, full `npm test` and `npm run build` are the lead's serialized gate — not run here per the batch protocol.
- Kody review of PR #5494 (5 findings, all fixed in the same lane): order deep-link effect depends on `isDesktop`; the consent gate now blocks with a checking state until consent resolves (never fails open) and still fails closed on a failed fallback; the Lessons framework panel surfaces the snapshot error with Retry; the rollout path uses `<lane>`; the new test file captures and restores `DATABASE_URL` in `afterAll` (Kody rule 33).

## 5. Next Steps & Blockers

- Lead: run the serialized full gate, push `zc/4689-web-batch-2`, open the ST-4689 PR (`Fixes ST-4689`), and update ST-4667 (items 1 and 3 are absorbed here; its motion/audit-tip/iOS-residual rows stay open).
- Visual baselines: none of these changes render inside a captured surface (`test/e2e/visual.spec.ts` covers login, the autonomy desk, header dropdowns and the api-keys confirm), so no baseline regeneration is expected — the lead's e2e pass is the confirmation.
- Residuals deliberately left: the console's own poll does not use `fields=` yet; `DataSharingCard` on Settings still reads `/api/consent` for the pool row (it is not a gate and also needs the learned-context state from a second route).

## 6. Zero-Code Findings

- `snapshot.socratic.decisions` is capped at 50 and scoped to the active account (`src/lib/dashboard.ts`), which is why the ApprovalCard link is honest-by-omission outside that window rather than backed by a new fetch.
- The scan page's `useIsDesktopConsole` module already documented the exact defect W20 fixes ("the CSS twin kept BOTH trees in the DOM"); the hook's default-`true` layout-effect correction is what makes the swap paint-free.
