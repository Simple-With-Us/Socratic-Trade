# DEEPSEEK → Implementer Handoff: Desktop Console Review (docs-only)

Source review: `/tmp/deepseek-review-desktop-web.md` (45 findings, full evidence). Repo: `/Users/jay/apps/trading-deepseek`, read-only review — this file is the handoff; no code was changed. Base `41a7a438d`. Live prod is `e0a4959a7` (~4 commits behind main — verify against main, not live).

## 1. Implement FIRST (in this order)

1. **P1 — Approve dead-end for pending rows without stamped `executionMode`** — `app/console/components/approval-card.tsx:248,258,383-393`; `app/console/approvals/page.tsx:217-221,196-204`; server truth: `src/lib/strategy-execution.ts:257-284`.
2. **P1 — Guardrails "Discard" must clear `universeDraft`** — `app/console/components/policy-form.tsx:364-366`; `app/console/guardrails/page.tsx:199-232,218-231,541-542`.
3. **P2 — Per-page document titles** — `app/console/layout.tsx:5-7`; root template `app/layout.tsx:10-13`; `destinationLabel` canon `app/console/components/nav.tsx:78-80`.
4. **P2 — Read-notification contrast below AA** — `app/console/components/notification-inbox.tsx:118` (`read && "opacity-60"` → 4.24:1 title / 2.79:1 body).
5. **P2 — Tooltip `aria-describedby` on non-focusable wrapper** — `app/console/ui/primitives.tsx:501-522` (Tooltip) with Btn at 96-99; affects run-once "Blocked:" reasons, scan sort instructions (`app/console/scan/scan-table.tsx:443-457`), Columns trigger (204-206).
6. **P2 — Account-scope menu keyboard contract** — `app/console/components/chrome.tsx:236-241,243-275` (focusable invisible backdrop, no arrow nav, `<p>` inside `role="menu"`).
7. **P2 — Delivery "Send test" races the auto-save queue** — `app/console/settings/delivery.tsx:243-260,170-180`.
8. **P2 — Comparison tile gross vs active net-of-tax** — `app/console/results/page.tsx:228-232` (`bucketFor(...)` drops `netOfTax`); active buckets at 163,177; `BucketCard` at ~969-1000.

## 2. Recommended approach per item

1. **Approve dead-end**: Do NOT change server logic. Client-side: resolve card reality as `pending.executionMode ?? <current account mode from snapshot>` (reuse `activeConnectedAccount(snapshot)?.environment`), so `willPromptTyped` is true on live; and in the 409 catch (both single + bulk), render the server's `error.expectedText` in a `TypedConfirm`-style input instead of a toast — the `LiveConfirmationRequiredError` (api.ts:27-37) already carries `expectedText` + `reasons`. Single-card and bulk share the fix: extract one reusable "typed 409 retry" sheet used by `approval-card.tsx` and `approvals/page.tsx` (BulkLiveApproveSheet already exists at approvals/page.tsx:503+ — extend it to open on 409 rather than only pre-flight).
2. **Discard**: Lift one `discardAll()`: `draft.clear()` + `setUniverseDraft({})`, passed into `PolicySaveBar` (add an optional `onDiscard` prop called by the Discard button at policy-form.tsx:364-366), and reset the universe inputs to policy values (they already derive from `universeDraft ?? policy`, so clearing the draft suffices). Keep `hasLooser`/typed-confirm logic (policy-form.tsx:330-335) unchanged — it reads `extraEntries` which becomes empty after discard, which is the desired "nothing to review" state.
3. **Tab titles**: Add a shared `CONSOLE_PAGE_TITLES: Record<href, string>` (mirroring `DESTINATIONS`) in a non-client module (e.g. `app/console/lib/titles.ts`), and export `metadata = { title: ... }` from each page — or set titles centrally in the console layout via a small client effect if pages stay metadata-less. Simplest: one `metadata.title` per page file using literal strings kept in lockstep with `DESTINATIONS` labels ("Orders", "Guardrails", …). Pages that are server components (usage/page.tsx, assistant/page.tsx) already can't call the client `destinationLabel` — use literals there. Root template appends "· Socratic Trade".
4. **Contrast**: `opacity-60` → `opacity-70` (5.86:1 title, passes AA; dark stays 6.31:1). If you prefer a token, add `--con-read-fg` instead — do not blanket-darken other read states.
5. **Tooltip**: For a single interactive child, clone the child (React.cloneElement) and add `aria-describedby={tooltipId}` (+ merge `aria-label` for icon-only children) onto the focusable element; keep the sr-only span; drop `aria-describedby` from the wrapper when the child is interactive to avoid double announcement. Keep `tabIndex={0}` behavior for non-interactive triggers (Chip/Stat/Ago) unchanged.
6. **Menu keyboard**: Minimal safe fix — make the click-away backdrop non-focusable: keep it a `<button>` (the comment at chrome.tsx:235-236 says button was chosen for iOS touch compat) but add `tabIndex={-1}` + `aria-hidden`, and move it AFTER the menu in DOM order (or keep order and rely on tabIndex). Then implement the APG menu pattern on the `role="menu"`: on open, focus the first `menuitemradio`; ArrowDown/Up/Home/End roving; Enter/Space activates (native button click); Escape closes + returns focus (close() already does). Move the explanatory `<p>` (247-250) and divider (264) outside `role="menu"` (they're not menuitems).
7. **Send test**: In `sendTest()`, await the delivery card's pending auto-save queue before POSTing (expose a `flush()` from the card's `autoSave` controller, or disable Send test while `saving === true`); do not change the `/api/notifications/test` route contract.
8. **Comparison**: Per the dead-controls rollout decision (net-of-tax applies to the active account only — comparison accounts have no tax summary), do NOT compute net with active rates on the comparison tile. Instead pass `netOfTax={false}` explicitly and annotate the comparison realized value inline ("gross — no tax adjustment") so the basis is visible without hover.

## 3. Tests that must fail first + verification

For each item, write the regression test FIRST against current code (it must fail), then fix:

1. Approve: unit/integration — card with `pending.executionMode === undefined`, `policy.requireTypedConfirmation !== false`, live active account ⇒ `willPromptTyped === true` (currently false). Plus: `approveProposal` 409 path renders an input bound to `expectedText` (component test). Server tests untouched.
2. Discard: component test — edit a universe field, call Discard ⇒ save bar shows 0 changes AND next commit's payload contains no `includedIndices/additionalSymbols/blocklist/permittedOrderTypes/sellToFundBuy`.
3. Titles: assertion (grep/test) that every `DESTINATIONS` href's page exports a title, or a render test asserting `document.title` differs between `/console` and `/console/orders`; manual browser check.
4. Contrast: extend `test/console-a11y.test.ts` pattern — assert read-state composite ≥ 4.5:1 using `contrast.ts` helpers.
5. Tooltip: render test — a `Btn` inside `Tooltip` has an element with `aria-describedby` pointing at the sr-only content.
6. Menu: keyboard test (react-testing / Playwright if present) — Tab from trigger lands on first `menuitemradio` (not the backdrop); ArrowDown moves; Escape closes and refocuses trigger.
7. Send test: ordering test — toggle channel then `sendTest()` ⇒ the test POST happens after the toggle's save resolves (fake timers or injected fetch order).
8. Comparison: render test — `subtractFromResults` on ⇒ comparison `BucketCard` receives `netOfTax`/annotation.

Verification gate (AGENTS.md, in order): `npm run lint` → `npx tsc --noEmit` → `npm test` (targeted first, then full ~7.2k) → `npm run build`. Live probe where relevant: `curl -sI https://socratictrade.com/ | grep -i content-security` — if you touch CSP, note it is currently report-only; do not flip CSP_ENABLED without a separate owner decision (env-gated, `middleware.ts:183-187`). Do not run preview servers; local `npm run dev` in your own worktree only.

## 4. Pitfalls / related code to touch carefully

- **Approve path**: `LiveConfirmationRequiredError` is shared by dashboard ProposalRow (`app/console/page.tsx:1021`) and approvals bulk — keep both consumers consistent when adding the 409 retry UI. Never change `assertLiveApprovalConfirmation` / the bulk-approve route: server behavior is the contract.
- **Discard**: `PolicySaveBar`'s `useUnsavedChanges(changeCount > 0)` (policy-form.tsx:327) drives beforeunload + nav prompt — after the fix, a truly-clean page must deregister. Don't break the typed-confirm loosening detection (`hasLooser`, policy-form.tsx:330-335).
- **Titles**: `app/console/usage/page.tsx` and `assistant/page.tsx` are SERVER components importing from a "use client" module would throw (documented in their headers) — use literal title strings there.
- **Menu**: the backdrop button exists for iOS Safari/PWA touch (comment chrome.tsx:235-236) — keep it a button, just `tabIndex={-1}`+`aria-hidden`; verify click-away still works on touch after the change. `UserMenu` (chrome.tsx:912) is the reference for the correct backdrop pattern.
- **Tooltip**: cloneElement must preserve the child's existing props/handlers (Btn onClick, disabled); avoid double-attaching aria-describedby; IconButton needs `aria-label` merge so icon-only buttons stay named.
- **Results comparison**: `BucketCard` is shared by paper/live/comparison buckets — thread the new prop through all three call sites; the "no tax summary for comparison accounts" rollout decision stands (annotate, don't compute).
- **Repo protocol**: when implementing, follow AGENTS.md pre-commit protocol — add an EFFORT-LOG row (Planned→In Progress), a `docs/rollouts/YYYY-MM-DD-*.md`, update STATUS/PLAN; land via `bash scripts/land.sh` (never push main directly). Docs-only PR is fine for this review itself.
- **Live lag**: prod runs `e0a4959a7`; `/api/live` 401s at the edge today (pre-#2817 middleware) — do not "fix" it; it self-resolves on the next deploy.

## 5. What to AVOID

- **Do NOT re-file board duplicates**: 2056ceab (tone-token contrast — verified all pass at used sizes; the new instance is only the inbox read-state, item 4), 620ef423 (entry paths — post-OAuth deep-link is a *deepening* of it, cite the id, don't create a new P1), 62fb3d7d (overlay/menu keyboard — file only the new ScopeSelector/inbox instances), 8badaa3f (copy rules — concrete new instances only), 2d0f31ae (pages disagree), 031dbbec (public-site halves), dbf4b43c (P&L basis — only the comparison-tile instance), fa8dc319 (dead controls), 5d9f6340, a3ccc8a9, 30a5e1ba.
- **Do NOT "fix" already-fixed items**: dead-controls wiring (net-of-tax toggle, webhook Send test, preset CRUD — verified live in code), home proposal rows (persisted ids), console-ships-too-much (#2884), copy-guardrail claims, guardrails "Import from account" arming Autopilot (already moved to Strategy with run-state preservation).
- **Do NOT change server money-path behavior** in the approve/bulk-approve fix; do not touch `/mobile`, PWA, or `ios/**`; do not add Stripe/payments; do not create provider API keys.
- **Do NOT touch tone tokens / console.css color values** except the single read-state opacity (item 4) — the a11y batch (#2561) is landed and tests enforce it.
- **Do NOT start preview servers** (retired) and do not bounce Coolify; verify locally + the `verify` CI gate only.
