# Rollout: docs-refresh — documentation accuracy pass

**Date:** 2026-06-21
**Branch:** agent/claude-docs-refresh

## Summary

Documentation accuracy pass: updated docs and inline code comments where an audit
found ~25 places calling something "pending/not-yet/TODO" that the code already
implements. Each finding was verified against current main before editing. No logic
changes — comments and docs only.

## Changes made (all verified against current code)

| Finding | File(s) edited | What changed |
|---|---|---|
| Market holidays ARE modeled via `getMarketHolidays()` | `src/lib/market-hours.ts:4`, `docs/phase-1-autonomy-loop.md` | Updated stale "Does NOT account" / "still not modeled" language to reflect reality |
| Multi-channel notifications (push/email/SMS) IS implemented | `docs/phase-6-customization-risk-notifications.md` | Notifications section now lists all four channels (push, webhook, email, SMS) instead of webhook only |
| Trailing stop IS implemented (synthetic-stops engine) | `docs/phase-6-customization-risk-notifications.md` | Risk Rules item updated from "optional metadata for future" to "implemented via synthetic-stops.ts" |
| `strategy_profiles.user_id` migration IS done | `docs/phase-6-customization-risk-notifications.md` | Profiles section notes the migration is done (same backfill pattern as other per-user tables) |
| Alpaca news + trade_updates WebSocket streams ARE implemented | `docs/data-architecture-push-vs-poll.md` | WebSocket row in the mechanisms table updated from "Not yet" to "Implemented"; push-candidates table rows #2/#3 updated from "Scoped below" to "Implemented" with file pointers |
| Event-driven LLM trigger engine IS built (default-off) | `docs/data-architecture-push-vs-poll.md` | "design-only / not yet built" language replaced with accurate "implemented, default-off; `TRIGGER_ENGINE` env var controls it" description |
| sec8k.ts "no per-item parsing yet" comment is stale | `src/lib/web-sources/sec8k.ts` | Comment updated to describe `parseEightKItemsFromHtml` + `eightKHasMaterialItem` that ARE implemented |
| open-questions-for-jay.md Q1 "today only AnthropicLLM + MockLLM" | `docs/open-questions-for-jay.md` | Updated to note OpenAI adapter is live; model-selector UI is the remaining NEXT item |
| PLAN.md Acceptance Checks: CI wording about workflow-scope | `PLAN.md` | Updated to state ci.yml is live and `verify` gates PRs; only security/e2e/deploy remain in ci-pending/ |
| PLAN.md Phase 11: M5 concurrent scheduling listed as remaining | `PLAN.md` | Phase 11 row updated — M5 is done (scheduler iterates users with bounded concurrency) |
| chat-multiuser-learning-design.md §2.2 gaps 3+4 (SSE filter; mcp-oauth per-user) | `docs/chat-multiuser-learning-design.md` | Both gaps marked as implemented with accurate file/line pointers |
| phase-11-multi-user.md §M2: congress.ts + chat getLLM pass userId to resolveApiKey | `docs/phase-11-multi-user.md` | M2 partial-impl description updated to include Apify/congress and chat LLM path |
| phase-7-strategy.md §3.D MAE/MFE "currently recomputed, not persisted" | `docs/phase-7-strategy.md` | Corrected: MAE/MFE IS persisted via `db-fills.ts` `persistMaeMfeById/ByKey` |

## Findings that did NOT hold (left unchanged)

- **architecture-blueprint.md intro — "Pinecone/Voyage key lookup still uses the raw app user ID"**: intentionally preserved for backward compat with identity-provider IDs containing punctuation. `phase-11-multi-user.md` M2 already documents this explicitly. Left as-is.
- **phase-8-cockpit-ui.md Layout Model + User-Facing Tabs**: the 2026-06-16 redesign note at the top of the file already accurately describes the shipped layout (7 tabs: Decision / Market Scan / Performance / Strategy in center; Operate / Risk / Profile in right inspector; Activity / Runs / Notifications in bottom drawer). No change needed.
- **data-architecture-push-vs-poll.md §Shared cache fills + pending demand + market-data SSE**: the doc already says these are implemented (the "Shared cache fills" paragraph). Confirmed correct; no change needed.
- **architecture-blueprint.md §1.2 getThemeClasses mock/paper/live state labels**: the labels in the snippet are intentional (the runtime uses "test"/"paper"/"live"). The intro note is about the Pinecone key issue (addressed above). No change needed.
- **chat-multiuser-learning-design.md §1.4 toPatch wholesale-prompt-replace concern**: this is a forward-looking design item in the file-level change plan (the work is not yet done). Left as-is — it belongs on the backlog, not the stale list.

## Files touched

- `src/lib/market-hours.ts` — inline comment
- `src/lib/web-sources/sec8k.ts` — inline comment
- `docs/phase-1-autonomy-loop.md`
- `docs/phase-6-customization-risk-notifications.md`
- `docs/data-architecture-push-vs-poll.md`
- `docs/open-questions-for-jay.md`
- `docs/phase-7-strategy.md`
- `docs/phase-8-cockpit-ui.md` — NOT modified (already accurate)
- `docs/phase-11-multi-user.md`
- `docs/chat-multiuser-learning-design.md`
- `docs/architecture-blueprint.md` — NOT modified (intentional / already accurate)
- `PLAN.md`
- `docs/rollouts/2026-06-21-docs-refresh.md` — this file

## Verification

```
npx tsc --noEmit   # clean (no output)
npm test           # 772 passed (85 files)
npm run build      # succeeded
```

## Follow-ups

- None from this pass. The items left unchanged either belong on the real backlog
  (toPatch wholesale-replace, phase-8 advanced layout details) or were already
  accurate in the doc.
