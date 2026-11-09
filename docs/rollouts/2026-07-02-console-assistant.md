# 2026-07-02 — /console Assistant chat destination (Claude)

## Summary

Ported the AI Assistant chat into the new `/console` UI as its own destination at
`/console/assistant` (branch `claude/console-assistant`, part of the parallel
console-port effort). New files only, all under `app/console/assistant/`:

- `page.tsx` — the route (server component with metadata, renders the client chat).
- `chat.tsx` — the chat surface: transcript (server-persisted history via
  `GET /api/chat-history`), composer with Enter-to-send / Shift+Enter newline and
  auto-growing textarea, suggestion chips on empty state, native grouped
  `<select>` model picker (per-provider "no key" disabling from
  `GET /api/chat/providers`, custom-model-id input, sticky choice in
  `localStorage["console.assistant.model"]`), per-provider missing-key gate,
  Clear-conversation (two-click confirm → `DELETE /api/chat-history`), and
  Retry on failed sends.
- `draft-card.tsx` — assistant-produced trade drafts as a compact order ticket:
  an AUTOMATIC policy dry-run preview on appearance
  (`POST /api/proposals/from-draft { dryRun: true }` → approved/blocked +
  reasons + est. notional), then "Stage for approval" (commit POST) which hands
  off to the console's Approvals screen (201/200-deduped → toast + "Review in
  Approvals" link + snapshot refresh so the badge updates; 409 POLICY_BLOCKED →
  reasons rendered plainly; preview network failure → honest notice, staging
  stays available because the server re-checks on commit and again at approve).
- `markdown.tsx` — assistant-reply markdown via react-markdown + remark-gfm
  (no raw HTML rendering), styled with `--con-*` tokens; table rows get the
  console hover highlight.
- `models.tsx` — local chat-model catalog + client mirror of the server's
  `chatProviderForModel` routing (see Follow-ups).

## Why

The legacy assistant (`app/ui/assistant-console.tsx`) predates the console
design system. This port keeps its capabilities (chat, citations, model choice,
draft tickets, policy dry-run, history persistence) and improves the parts that
were awkward:

- **Draft → approval handoff**: instead of duplicating an approve/reject rail
  inside chat, staged drafts route to Approvals — the console's single decision
  surface (which owns the LIVE typed-confirm contract). The dry-run preview now
  runs automatically, so the user sees approved/blocked before choosing to stage.
- **Honest failure handling**: a failed send keeps the user's message and offers
  Retry instead of fabricating an apologetic assistant turn; history-load
  failure is a non-blocking notice; every error is a toast + inline notice,
  never a blank screen.
- **Per-provider key gate**: the missing-key warning names the provider the
  SELECTED model actually routes to (mirrors the server's 412 logic), instead of
  the legacy "any provider has a key" check.
- **Clear conversation** — new; the legacy UI had no way to delete the transcript.
- Owner UX standard baked in: `title=` tooltips on every interactive control /
  badge / picker option group, and `--con-*` hover highlights on row-like
  elements (markdown table rows, suggestion chips). No Tooltip primitive exists
  in `app/console/ui/primitives.tsx`, so native `title=` is the floor used.

Per the parallel-work contract this branch does NOT touch `console.css`, nav,
`app/console/lib/api.ts`, approvals/settings pages, or any `src/lib/*`; the
`/console/assistant` nav entry arrives with the foundation PR. Client imports
from `src/lib` are type/pure-only (`@/lib/chat/types`, `@/lib/llm-errors`).

## Endpoint notes (verified against route sources + smoke calls)

- `POST /api/chat` `{ message, model }` → `{ text, draft|null, citations[], model }`;
  412 `llm_credential_required`, 429 rate-limit/budget, 500 `chat_failed` with the
  raw provider error in `message` (humanized client-side via `humanizeLlmError`).
- `GET /api/chat-history?limit=100` → turns oldest→newest; citations are plain
  strings there (objects only on live replies). The orchestrator persists both
  turns server-side, so the client never POSTs to chat-history. Drafts are not
  persisted — tickets exist on live replies only (same as legacy).
- `POST /api/proposals/from-draft`: dry-run returns the staleness-folded
  "effective" decision, so a staleness-only block already previews as approved —
  no special client handling. Commit is idempotent per draft (`deduped: true` on
  retry). Errors carry `reasons[]` (falling back to `error`).

## Files

- `app/console/assistant/page.tsx` (new)
- `app/console/assistant/chat.tsx` (new)
- `app/console/assistant/draft-card.tsx` (new)
- `app/console/assistant/markdown.tsx` (new)
- `app/console/assistant/models.tsx` (new)
- `STATUS.md`, `PLAN.md`, `docs/rollouts/2026-07-02-console-assistant.md` (this note)

## Verification

Run in this worktree (branch cut from `origin/main` @ 78ecc98):

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors (283 warnings repo-wide; the 2 new ones are the
  grandfathered `react-hooks/set-state-in-effect` pattern already used across
  the console).
- `npm test` — 234 files, 2241 tests, all pass.
- `npm run build` — ok; `/console/assistant` present as a static route.
- Smoke against `next start`: `GET /console/assistant` → 200;
  `GET /api/chat/providers` → all-false map (keyless env);
  `POST /api/chat` with `model:"mock"` → reply persisted and returned;
  `GET /api/chat-history` shows both turns;
  `POST /api/proposals/from-draft` (dry-run + commit) → 400 `NO_ACCOUNT`
  `{ reasons: ["No account is selected."] }` on a fresh DB — the card renders
  that as a plain blocked reason.

Known cascade nuance: Tailwind 4 layers utilities while `console.css` is
unlayered, so `con-select`/`con-textarea` box rules beat width/resize utilities —
handled with fixed-width wrappers and inline styles, not `!important`.

## Post-merge update (same day)

`origin/main` advanced mid-task with PR #321 (console-port foundation:
`app/console/lib/models.ts`, `ui/provider-logo.tsx`, `ui/ticker-logo.tsx`,
`ui/symbol-drilldown.tsx`, nav gains the Assistant entry). Merged main into
this branch (clean — STATUS/PLAN kept both sides) and adopted the foundation
where it genuinely helps, without a broad refactor:

- `models.tsx` now delegates provider routing/labels to
  `app/console/lib/models` (`providerForModel` + `providerLabel`), keeping only
  the assistant-specific pieces: the grouped `<select>` catalog (tiers,
  Mock/custom options — the shared module deliberately carries attribution
  only, not a picker catalog) and the "mock" keyless special case.
- Assistant replies attribute their model with the shared `ModelBadge`
  (vendor logo + display name); the offline `mock` model keeps a plain-text
  label so no vendor logo is faked.

Full verify gate re-run after the merge (results below are post-merge).

## Codex review fixes (PR #325, same day)

All four P2 findings were verified against the code and confirmed; fixed in
`app/console/assistant/chat.tsx`:

1. **Late history clobbered live messages** — a send before the initial
   `GET /api/chat-history` resolved would be replaced by the late
   `setMessages(history)`. Fixed with a `localEchoRef` "conversation changed
   locally" flag: a late history response is discarded (those turns persist
   server-side and appear on the next full load).
2. **Clear during an in-flight send** — confirming Clear mid-reply could delete
   the persisted user turn while the in-flight request later re-appends its
   assistant turn (client- and server-side). Fixed two ways: the Clear button
   is disabled while sending/clearing (title says why), and a `clearGenRef`
   generation counter makes a still-unfinished send drop its late reply after
   a successful clear. Sending is likewise blocked while the DELETE is in
   flight.
3. **Retry double-persists the prompt** — confirmed in
   `src/lib/chat/orchestrator.ts`: the user turn is `appendTurn`ed BEFORE the
   provider call, so a post-receipt failure + Retry re-POSTs an
   already-persisted prompt. `/api/chat` has no idempotency key and `src/lib`
   is out of scope for this PR, so the client is honest instead: on Retry it
   probes the transcript tail (`GET /api/chat-history?limit=1`) and, when the
   failed prompt is already the trailing persisted user turn, tells the user
   plainly ("history will show this message twice") while keeping the
   on-screen transcript deduped (Retry reuses the existing bubble, never adds
   a second one). Server-side dedupe recorded as a follow-up below.
4. **Clear copy claimed account scoping** — `DELETE /api/chat-history` calls
   `clearTurns(userId)`, which clears the transcript for the whole user across
   ALL accounts. The confirm title and the success toast now say exactly that
   (your entire assistant conversation, one transcript shared across all your
   accounts); the server was deliberately not re-scoped.

Full verify gate re-run after these fixes (tsc / lint / test / build — green).

A fifth P2 followed (`draft-card.tsx`): the dry-run preview effect depended
only on the draft, so switching the active account left the PREVIOUS scope's
approved/blocked verdict + estimated notional on screen while the reality chip
updated (presentation-honesty bug; the server still re-checks at commit and
approval). Fixed by deriving a stable `scopeKey` from the console snapshot
(active connected-account id + `policy.accountNumber` + reality mode — stable
strings, so the 15s poll can't re-trigger it) and including it in the preview
effect deps; `runPreview` now clears the old verdict up front so the card shows
"Checking against your guardrails…" instead of a stale verdict while re-running.
Once staged/discarded (or mid-commit), a scope flip deliberately does NOT
restart the preview — the created proposal is a fact about the old scope.

## Review round 3 (PR #325, same day)

Four more findings, each verified and fixed:

1. **CI lint error `draft-card.tsx` "Cannot access refs during render"** — the
   phase-mirror ref was written in the render body. Reworked: `scopeKey` is now
   a `useMemo` over stable ids, and the preview effect compares the last
   previewed scope INSIDE the effect (`lastPreviewScopeRef`) with `phase` in
   the deps — no render-time ref access at all.
2. **Image auto-fetch in assistant markdown** — untrusted model/RAG text could
   exfiltrate viewer metadata via `![x](https://attacker/...)` because
   react-markdown emits a real `<img>` the browser fetches on render.
   `markdown.tsx` now renders images as visible non-fetching links
   (`[image: alt]`, opens in a new tab only on click). Audited the remaining
   defaults: no rehype-raw (HTML stays escaped), links/autolinks require a
   click, GFM adds only tables/strikethrough/task-list checkboxes — `img` was
   the only auto-fetching element.
3. **Stale preview response race** — overlapping dry-runs (rapid scope flips,
   manual Re-check during an auto run) could resolve out of order, letting an
   older response overwrite the newer verdict; a late preview could also flip
   phase after stage()/discard. Added a monotonic `previewGenRef`: each run
   captures its generation and only the latest may write
   decision/estimate/phase; stage() and discard() bump the generation to
   invalidate anything still in flight.
4. **Staged tickets freeze their scope** — at stage() time the reality
   word/phrase/tone/clarification + account label are frozen into `stagedScope`
   and the staged ticket renders from those frozen values (chip + LIVE approval
   copy). When the console has since switched accounts, the ticket says so
   plainly: "Staged on X (WORD · phrase) — the console has since switched
   accounts. Switch back to that account to review it in Approvals" (Approvals
   lists only the ACTIVE account's proposals).

Also merged `origin/main` through #323/#324/#329/#330 during this round
(clean merges; STATUS/PLAN kept every lane's entries). Full verify gate re-run
on the final merged tree.

## Follow-ups

- **Chat idempotency (server-side, separate PR)**: accept an optional
  `clientTurnId` on `POST /api/chat` and skip the user-turn `appendTurn` when
  that id is already recorded, so a client Retry after a post-receipt failure
  cannot duplicate the prompt in the transcript (the clean fix for review
  finding 3; requires a `src/lib/chat` change, which is out of this PR's lane).
- The grouped select catalog in `models.tsx` still mirrors
  `app/ui/llm-model-catalog.ts` — if the console ever grows a shared picker
  catalog, fold it there.
- Ticker logos / symbol drilldown not used here (no symbol rows in chat);
  revisit if the assistant ever renders position/quote tables natively.
- `/api/chat` is non-streaming; if the endpoint grows streaming support the
  composer/transcript here can adopt it without layout changes.
- Draft tickets vanish on reload because the transcript doesn't persist drafts
  (pre-existing server behavior) — worth persisting `draft_id` on turns someday.
