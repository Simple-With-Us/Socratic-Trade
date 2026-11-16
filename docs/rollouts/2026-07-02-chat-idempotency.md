# 2026-07-02 — Server-side chat idempotency via clientTurnId (POST /api/chat)

## Summary

`POST /api/chat` now supports an optional `clientTurnId` idempotency key. The
chat orchestrator appends the user turn to the persisted transcript BEFORE the
provider call, so a client Retry (or double submit) previously recorded the
same prompt twice — the console Assistant even shipped a probe + toast telling
the user "history will show this message twice." With this change:

- `chat_turns` gains a nullable `client_turn_id` TEXT column (versioned
  migration v10, PRAGMA-guarded ALTER — same pattern as v5 `chat_turns_model`)
  plus a `(user_id, client_turn_id)` index. The base `CREATE TABLE` also
  carries the column for fresh databases.
- `findChatTurnByClientId(userId, clientTurnId)` (in `src/lib/db-api-keys.ts`,
  the module that owns chat_turns CRUD) does the per-user lookup.
- `appendTurn` (`src/lib/chat-history.ts`) accepts an optional `clientTurnId`
  and persists it; `ChatTurn` (`src/lib/types.ts`) carries the field.
- The orchestrator (`src/lib/chat/orchestrator.ts`) accepts an optional
  `clientTurnId`. When a turn with that id already exists for the user it
  SKIPS the duplicate user-turn append but still runs the provider call — the
  retry's whole point is getting the reply the failed attempt never produced.
  Requests without an id keep legacy behavior (never deduped).
- The route (`app/api/chat/route.ts`) parses/validates the field: optional; if
  present it must be a non-empty string of <=64 chars, else 400 (fail loud
  rather than silently dropping the idempotency the caller asked for).
- Clients: `/console/assistant` generates `crypto.randomUUID()` per send and
  REUSES it on Retry (keyed by the local user-message id in a ref); the old
  "recorded in the transcript twice" history probe + toast is deleted because
  the server now dedupes. The legacy dashboard chat
  (`app/ui/assistant-console.tsx`) sends a fresh UUID per send (it has no
  Retry affordance).

## Why

Verified-open follow-up (t5) from the mined backlog: double-submit/retry
protection for chat. The transcript is the audit surface for the assistant —
duplicated prompts misrepresent what the user actually asked, and the client-
side "be honest about the duplicate" toast was a workaround, not a fix.

## Files

- `src/lib/db.ts` — migration v10 `chat_turns_client_turn_id` (ALTER +
  index), `client_turn_id` in the base `chat_turns` schema.
- `src/lib/db-api-keys.ts` — `client_turn_id` in `RawChatTurnRow` /
  `mapChatTurn` / `insertChatTurn`; new `findChatTurnByClientId()`.
- `src/lib/types.ts` — `ChatTurn.clientTurnId?: string | null`.
- `src/lib/chat-history.ts` — `appendTurn` accepts + persists `clientTurnId`.
- `src/lib/chat/orchestrator.ts` — `handleTurn` accepts `clientTurnId`;
  skip-duplicate-append-but-still-answer logic.
- `app/api/chat/route.ts` — parse/validate optional `clientTurnId` (<=64
  chars, 400 on malformed) and thread it through.
- `app/console/assistant/chat.tsx` — per-send UUID reused on Retry; removed
  the now-obsolete duplicate-history probe/toast.
- `app/ui/assistant-console.tsx` — per-send UUID.
- `test/chat-orchestrator.test.ts` — 3 new tests: same-id retry records
  exactly ONE user turn (and still answers, with two assistant turns);
  distinct ids record two; no-id sends are never deduped.
- Docs: `STATUS.md`, `PLAN.md`, this note.

## Verification

```
npm run lint       # 0 errors, 295 grandfathered warnings
npx tsc --noEmit   # clean
npm test           # 2353 tests / 237 files, all pass (3 new)
npm run build      # green
```

## Follow-ups

- The dedupe is a read-then-insert (no UNIQUE constraint on
  `(user_id, client_turn_id)`), so two perfectly concurrent identical requests
  could still both append; SQLite's serialized writes plus the single-user
  retry pattern make this acceptable. A UNIQUE partial index would need
  ON CONFLICT handling in `insertChatTurn` — deferred.
- On a deduped retry the provider still sees the prior recorded user turn in
  `history` AND the message itself (transient prompt duplication in the LLM
  call only, never in the transcript). Harmless for a retry-after-failure;
  noted for completeness.
- The legacy dashboard chat has no Retry affordance, so its per-send UUID only
  protects the transcript against transport-level double submits.
