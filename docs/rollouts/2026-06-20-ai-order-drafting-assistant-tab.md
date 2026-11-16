# 2026-06-20 — AI order-drafting "Assistant" tab (chat → confirm → place)

## Summary

Added a first-class **Assistant** workspace tab: a chat console where the user converses, the AI
returns a draft order ticket, and the user dry-runs policy + confirms inline — which routes through
the **existing** `insertProposal(status:'proposed')` → approve → `executeProposal` rail. The chat
module gains **no** execution capability; this is "manual AI order placement" (the Atlas UX) with a
human confirm. Design chosen by a 5-agent design panel (hybrid of the three proposals); user picked:
full tab, live/brokerage allowed (with a red real-order confirm), inline confirm.

## Why

The ported chat orchestrator produced a draft-only `ChatDraft` that was a UI dead-end (no bridge to
a real proposal). This wires that draft into the canonical approval/execution path so the assistant
can actually help place orders — safely, behind the same gates as the strategy engine.

## What / files

- **`src/lib/chat/promote-draft.ts`** (new) — pure `chatDraftToProposal(draft)` mapper → a complete
  `TradeProposal` (sets the CLAUDE.md-required `tradeThesisTag='Manual-Chat'`/`entryMarketRegime='Manual'`
  /`type`/`timeInForce`/`marketHours`); rejects any side outside buy/sell so a malformed draft can't
  become an unvetted short/cover.
- **`app/api/proposals/from-draft/route.ts`** (new) — POST `{ draft, dryRun? }`. Resolves the user,
  rejects no-account / halted / symbol-not-in-universe, reviews + `evaluateTradeProposal` (a PREVIEW
  eval; the authoritative gate is still `executeProposal` at approve). `dryRun:true` returns
  `{decision, estimatedNotional}` without inserting; commit inserts a `proposed` row (idempotent on
  `runId='chat:'+draft_id`), audits, and emits the `proposal` SSE event.
- **`src/lib/db.ts`** — `findProposalIdByRunId(runId, userId)` for whole-lifecycle idempotency.
- **`app/ui/assistant-console.tsx`** (new) — the `AssistantView`: history load, composer → `/api/chat`,
  message bubbles + citation chips, and a `DraftOrderCard` with the staged flow (Check policy → Stage
  for approval → Confirm & place). The destination pill is derived from the **live** `executionState`
  (NOT the draft's hardcoded `account_label`); the confirm button turns red and says "places a REAL
  order" on a brokerage/live account. "Confirm & place" calls the existing `approveProposal` handler.
- **`app/dashboard-client.tsx`** — new `assistant` WorkspaceTab + render branch passing
  `executionStateFor(snapshot)` and `approveProposal`.
- **`test/chat-promote.test.ts`** (new, 6) — mapper completeness + side/qty/limit validation.

## Verification

- `npx tsc --noEmit` clean; `npm test` = **47 files / 371 tests**; `npm run build` OK
  (`/api/proposals/from-draft` registered; `/_not-found` prerenders).
- **Live browser** (`:3000`, Test account, system Halted): Assistant tab renders with the TEST
  destination pill + safety banner pinned above; "buy 10 AAPL at 200" → AI draft reply + a
  `BUY 10 AAPL · limit @ $200` card; **Check policy** correctly showed **"Blocked by policy — System
  is stopped"** and withheld the Stage button (safety gate enforced before any row is minted).

## Follow-ups / notes

- Chat uses the deterministic **MockLLM** until `CHAT_LLM=anthropic` + an Anthropic key are set.
- The dry-run is a PREVIEW (no full market scan); `executeProposal` re-evaluates authoritatively at
  approve against fresh data, branching paper/live on the active account.
- A staged chat draft can now be **rejected inline** from the card (post-stage) too — `DraftOrderCard`
  shows Confirm + Reject in the `proposed` phase, Reject calling the existing `rejectProposal` rail.
- Deliberately NOT changed: chat drafts carry `Manual-Chat`/`Manual` and stay excluded from the regime
  scorecard / learning loop (manual trades shouldn't tune the strategy engine); and chat uses MockLLM
  until `CHAT_LLM=anthropic` + a key are set (config, not code).
