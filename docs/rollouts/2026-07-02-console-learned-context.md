# 2026-07-02 — Console: learned-context approval inbox on /console/approvals

Branch `claude/console-learned-context` (cut from `origin/main` @ 78ecc98). Part of the
parallel legacy-feature-port effort into the new `/console` UI.

## Summary

Ported the learned-context confirmation queue (the legacy dashboard's "Pending Learned
Changes" SlideOver, `app/ui/learned-context-queue.tsx`) into the console as a
**Learned context** inbox section on `/console/approvals`, below the pending trade
proposals. Each pending item — an AI-inferred risk observation or strategy directive
queued by an autonomous run / document ingestion — renders as a console card with full
provenance (origin, source, kind, classifier reason, humanized timestamp with
exact-on-hover), an honest tier-specific statement of what approval actually does, and
Approve / Reject actions. Reject is one tap (optimistic removal + toast + server
reconciliation on failure). Approve opens a confirmation sheet first (asymmetric
friction: approval adds standing influence) showing, for strategy directives, the exact
attributed `<!-- AI-LEARNED … -->` block that will be appended to the strategy prompt.
After a directive approval the shared console snapshot is refreshed so the Strategy page
shows the updated prompt immediately.

Improvements over the legacy version:

- **Honest directive preview date.** The server stamps the appended block with the
  APPROVAL date (`mergeStrategyDirectiveBlock`), but the legacy preview rendered
  `createdAt` — so what the user saw could never match what landed. The console preview
  uses today's date and says the date is stamped at approval time.
- **Clearer provenance**: origin ("autonomous run" / "document ingestion"), source,
  kind, and the classifier's queue reason are always visible on the card, each with a
  plain-language tooltip.
- **Honest copy everywhere**: "Not applied until you approve" on every card; the risk
  tier explicitly says approval NEVER changes numeric risk limits (those live in
  Guardrails); rejection copy says nothing was applied anywhere. Post-review
  correction (valid Codex finding on PR #324): an approved risk observation is stored
  with `riskTier: "risk"`, but `listLearnedContextForDecision` (db-learning.ts) only
  retrieves `risk_tier = 'fact'` rows — so approved risk rows are recorded durably yet
  NOT fed back into runs today. All risk-tier copy (card caption, confirm sheet, toast,
  tooltips) now says "recorded, not yet fed into runs" instead of "the AI reads it on
  future runs".
- **Race + copy hardening (two more valid Codex P2s on PR #324)**: (1) a poll /
  tab-visible / manual load in flight when the user approves/rejects could resolve
  AFTER the action and resurrect the just-resolved card (second click then hit the 404
  path) — fixed by aborting any in-flight load when an action starts, tracking
  session-resolved IDs and filtering them out of every applied load, and refetching
  after successful actions so state converges; (2) with zero trade proposals but
  pending learned items, the page's "Nothing is waiting for you" empty card sat
  directly above cards that WERE waiting — the empty state is now explicitly scoped:
  "No trade proposals are waiting for you."
- **Resilient**: the queue has its own data source (GET pending, 60s visibility-guarded
  poll + refresh button); fetch errors surface as a non-blocking warn notice while the
  last good list stays rendered; action failures toast the server's own error text and
  re-fetch to reconcile. Nothing crashes the page.
- **Owner UX standard** (added mid-build by the owner, baked in): tooltips (`title=`)
  on every interactive control, badge, data point, and status; row hover/focus-within
  highlight on each card via inline Tailwind + existing `--con-*` tokens
  (`hover:bg-[color:var(--con-surface-2)]`), light + dark.

## Why

The learned-context queue was the last human-in-the-loop approval surface missing from
the console: without it, `/console` users could not see or act on AI-learned facts
awaiting confirmation (badge existed only in the legacy dashboard header). Approvals is
the console's decision inbox, so the queue belongs there.

## Endpoint shapes (inspected, unchanged)

- `GET /api/learned-context/pending` → `LearnedContextPendingRow[]` (server filters to
  `status === "pending"`, newest first). Row: `{ id, userId, scope, kind, subject,
  symbol, value, source, origin, riskTier: "risk" | "strategy-directive",
  classifierReason, createdAt, status, resolvedAt }` (`src/lib/types.ts`).
- `POST /api/learned-context/pending/[id]/approve` → `{ status: "approved", tier }`;
  404 plain text when missing/not-pending; 400 plain text on apply failure.
- `POST /api/learned-context/pending/[id]/reject` → `{ status: "rejected" }`; 404 as
  above.
- `GET/PUT /api/learned-context/sharing` exists (sharing prefs) — deliberately NOT
  surfaced here; it is a settings concern and `app/console/settings/page.tsx` is owned
  by a parallel agent this cycle. Recorded as a follow-up.

## Files

- `app/console/approvals/learned-context.tsx` — NEW: `LearnedContextInbox` (cards,
  confirm sheet, optimistic actions, empty/error/loading states, tooltips, hover
  highlight).
- `app/console/lib/learned-context.ts` — NEW: self-contained typed fetch/act helper
  (deliberately not in `lib/api.ts` to avoid parallel-agent collisions) +
  `directiveBlockPreview` (reuses `formatStrategyDirectiveBlock` from
  `src/lib/learned-context-queue-helpers` with the approval-time date).
- `app/console/approvals/page.tsx` — EDIT: mounts `<LearnedContextInbox />` below the
  pending-proposal list; trade-proposal flow untouched.
- `STATUS.md`, `PLAN.md`, this note — handoff docs.

No edits to `src/lib/**`, `app/api/**`, `app/console/console.css`, `lib/api.ts`, or any
other console file owned by parallel agents.

## Verification (exact commands run, in order)

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (282 pre-existing warnings). The one warning in the new
  component (`react-hooks/set-state-in-effect` on the fetch-on-mount effect) matches
  the identical grandfathered pattern in `app/console/lib/useConsoleData.tsx`.
- `npm test` — 2241 passed, 234 files.
- `npm run build` — compiled successfully; `/console/approvals` present (static).
- End-to-end against a temp DB (never the dev `data/app.db`): seeded one `risk` + one
  `strategy-directive` pending row via `insertPendingLearnedContext`
  (`DATABASE_URL=file:<scratchpad>/lcdb/app.db`), ran `npx next dev --webpack -p 3457`,
  then verified: GET pending returns both; `/console/approvals` renders 200; POST
  approve on the directive returned `{"status":"approved","tier":"strategy-directive"}`
  and the `user_settings.strategyPrompt` gained the exact
  `<!-- AI-LEARNED <id> 2026-07-02 -->` block (approval-date stamp confirmed — matches
  the new preview) + `learned_context.approve` audit row; POST reject returned
  `{"status":"rejected"}` and emptied the queue; double-reject returned the 404 plain
  text `Pending learned-context item not found.` (the text the UI toasts).
- Notable: `npm run dev` (Turbopack) 500s on ANY console page — pre-existing on main
  (Tailwind scans a literal `shadow-[var(--shadow✱)]` — ✱ stands for a real asterisk,
  defused here — in `docs/rollouts/2026-07-01-ux-ia-aesthetics.md`; documented in
  STATUS.md 2026-07-02 console entry). `next dev --webpack` and `npm run build` are
  unaffected. Fixed 2026-07-02 via `@source not "../docs";` in `app/globals.css`.

## Follow-ups

- **Approved risk-tier observations are stored but never retrieved**: the approve path
  (`applyApprovedPending`) inserts a `learned_context` row with `riskTier: "risk"`, but
  `listLearnedContextForDecision` filters `risk_tier = 'fact'`, so the row never reaches
  the strategy/chat prompt. Whether approved risk rows should be retrieved is a
  deliberate feedback-loop design decision owned by the learning-loop work — NOT wired
  up here; the UI copy states the current behavior honestly.
- ~~Sharing preferences surface~~ and ~~nav count badge~~: both DONE by the parallel
  PR #329 (parity tail) while this PR was in review — `app/console/settings/sharing.tsx`
  now surfaces `/api/learned-context/sharing`, and `app/console/components/nav.tsx`
  folds the pending learned-context count into the Approvals badge (which routes to the
  page this inbox lives on). No further action here.
- The legacy dashboard listens to the `pending-learned-change` SSE event for instant
  badge refresh; the console inbox polls (60s, visibility-guarded) + refreshes after
  actions. Wire SSE if the console ever grows an event stream.
- No component-level UI tests: the repo has no React testing tooling (vitest only, no
  @testing-library/jsdom); behavior was verified end-to-end as above.
