# 2026-07-15 - learning-review-settings-followups

## Summary

Closed out the remaining open items from a long-running chat thread on model attribution,
Alert Center/mobile UI fixes, and the daily learning-review feature (owner-directed "ensure
all the work on this chat is fully complete/implemented" sweep):

1. **Learning-review threshold/max-wait UI knobs** (`app/console/settings/learning-review.tsx`):
   added the two numeric fields the trigger backend (`learningReviewMinNewLessons` /
   `learningReviewMaxWaitDays`, landed 2026-07-10 via #1278) never got a UI for — "Run after this
   many new lessons" and "Or after this many days, whichever is first," gated behind the review's
   own enabled toggle, following the existing Market-scan-shape numeric-field idiom (`RawNumInput`,
   local draft state, commit-on-blur). Fixed the card's local `save()` helper to return a
   success/failure boolean so the new fields can actually revert their optimistic draft on a
   failed save (it previously always resolved `true`, swallowing errors into a toast only).
2. **Verified, not touched**: the "Global Settings" section ask is already satisfied — PR #1340
   (2026-07-10) made `/console/settings` global-only by construction, with explicit "ALL YOUR
   ACCOUNTS" labeling on every card; and the learning-review cost-line plain-English label is
   already done (`app/ui/llm-usage-labels.ts:25`, landed since, with its own exhaustiveness test).
3. **Container-width normalization** — fixed the 2 undocumented offenders a verification sweep
   found: `app/console/results/page.tsx` now imports `CONSOLE_PAGE_WIDTH` instead of hardcoding
   `max-w-3xl` (the exact "Journal at 768px" class of inconsistency the shared constant's own doc
   comment cites as the original bug); `app/console/approvals/page.tsx`'s genuinely-necessary
   wider two-column layout (`max-w-6xl`, 360px fixed aside) now carries a documented-exception
   comment mirroring the two that already existed (console home, decision-trace ready state).
   Also documented (not changed) `app/admin/llm-usage/llm-usage-client.tsx`'s independently
   maintained `max-w-5xl` (shared outside the console shell; only coincidentally matches).
4. **Mobile section spacing** — `app/ui/ios-components.tsx`'s `List` wrapper (used only by
   `/console/settings`) now uses `gap-8 sm:gap-6`: more breathing room between stacked
   `ListSection`s on narrow viewports, unchanged on desktop. A verification sweep found the
   original owner ask ("a little more space between sections on mobile") was never actually
   implemented — the gap had been flat `gap-6` since the component's creation.
5. **Model attribution — post-mortem/reflection gap** — the original attribution feature
   (#1076, "on every decision surface incl. failure states") explicitly deferred post-mortem/
   reflection as a follow-up ("the served model lands only in the llm_usage ledger today").
   Closed it: `generateReflectionSummary` (`src/lib/post-mortem.ts`) now includes `model`/
   `provider` on its `post_mortem_reflection` audit payload (success path), and — previously
   entirely unaudited — a failed reflection LLM call (non-2xx response) now also writes a
   `post_mortem_reflection` audit with `status: "failed"`, `model`, `provider`, and `reason`, so
   a failed reflection is no longer invisible everywhere in the app. `formatAuditEvent` in
   `src/lib/dashboard-feed.ts` surfaces this as `"<model> via <Provider>"` text in the Journal
   feed, matching the existing `llm_step` kind's established text-attribution pattern for this
   same dense-list-row surface (a full `ModelBadge`+logo card treatment doesn't fit a scrolling
   text row the way it fits `ApprovalCard`/`decisions/[id]`, which already carry it unchanged).

A 10-claim adversarial verification workflow (fresh reads of live code, not memory) confirmed 7
of the 10 earlier UI-wave items were already correctly implemented and un-regressed by 5 days of
subsequent churn: Alert Center heading redesign, the LRCX ticker-spacing fix, the sparse/
held-but-out-of-scan drawer fallback, compact finished-order cards, mobile bottom-nav active-tab
color, and the desktop rail's Configure-last ordering + width consistency.

## Why

Final wrap-up of a long multi-session thread. The owner asked to verify (not just assume) that
every promise made across the conversation actually landed and still holds after 5 days of heavy
fleet activity on `main` (many commits, PRs, and refactors from other agents/sessions in the
interim) — memory/prior-turn claims are not proof of current state.

## Files

- `app/console/settings/learning-review.tsx`
- `app/ui/ios-components.tsx`
- `app/console/results/page.tsx`
- `app/console/approvals/page.tsx`
- `app/admin/llm-usage/llm-usage-client.tsx`
- `src/lib/post-mortem.ts`
- `src/lib/dashboard-feed.ts`
- `test/post-mortem.test.ts`
- `test/dashboard-feed.test.ts`
- this note

## Verification

- `npx tsc --noEmit` clean (node@24 — Mac default node26 ABI-mismatches better-sqlite3; also hit
  and fixed a stale local `.claude/launch.json` dev-preview config pointing at the wrong node, see
  Follow-ups).
- `npx vitest run test/post-mortem.test.ts test/dashboard-feed.test.ts test/learning-review.test.ts
  test/learning-review-policy-route.test.ts` — 90/90 passed.
- `npm run lint` — 0 errors (488 pre-existing grandfathered warnings, none in touched files).
- Full `npm test` was attempted but genuinely stalled under heavy shared-machine contention (load
  avg 34-50, dozens of concurrent agent worktrees on the box — several CODEX rounds landed the
  same day document the identical "workstation-pressure blocked" condition for full/grouped gates
  and builds). Killed after 30+ minutes at 0% CPU with zero progress. `npm run build` was not
  attempted locally for the same reason. Falling back to the project's documented precedent:
  focused/targeted tests (above) plus tsc/lint cover every touched file's actual logic; hosted
  CI's `verify` gate (tsc + test + build on a clean box) is authoritative for the full picture.
- Browser-verified live via `npm run dev` (Turbopack): the new threshold/max-wait fields render
  and persist correctly when the review is toggled on; Results and Approvals pages render
  correctly at their (respectively new and unchanged) widths; the Alert Center pill-row and
  desktop rail Configure-last ordering were visually reconfirmed in passing.

## Follow-ups

- `docs/EFFORT-LOG.md` still has stale entries elsewhere in the file from unrelated efforts;
  out of scope for this note (only the #1326 row this session had previously touched was
  corrected).
- The local (gitignored) `.claude/launch.json` dev-preview config was fixed to invoke
  `/opt/homebrew/opt/node@24/bin/node` directly against `node_modules/next/dist/bin/next` — the
  previous `npm run dev` invocation didn't inherit a forced node24 PATH the way `scripts/land.sh`
  does, so the preview dev server loaded a node26-compiled `better-sqlite3` and 500'd every
  request. This is local-only (gitignored) and not part of this PR, but worth carrying into any
  other agent's launch.json if they hit the same "Snapshot failed (500)" / `ERR_DLOPEN_FAILED`
  symptom.
