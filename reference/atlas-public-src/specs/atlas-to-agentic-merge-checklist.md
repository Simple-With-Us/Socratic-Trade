# Atlas → Agentic Trading: merge verification checklist

**Purpose.** "Atlas" is the zero-dependency Node/ESM assistant in `jaywedgeworth22/public`
(local clone: `/Users/jay/code/trading`). It was an exploratory build. The real product is the
Next.js/TypeScript **Agentic Trading** app (`jaywedgeworth22/agentic-trading`). This document is
the **authoritative list of every idea/feature in Atlas**, so we can verify each was carried over
into Agentic Trading (a merge Cursor reportedly attempted) — and consciously drop the ones that
don't apply.

> How to use: for each item, mark **Ported** (exists in agentic-trading), **N/A** (intentionally
> not carried over), or **Missing** (should be added). The cross-check itself requires read access
> to `agentic-trading`, which a maintainer/agent with that repo attached should perform against
> this list.

Legend: `[ ]` to verify · `[x]` confirmed ported · `[~]` partial · `[-]` intentionally N/A

---

## 1. Safety boundary (the most important ideas — verify first)

- [ ] **The model can never execute a trade.** Only a `draft_order` tool exists; there is **no
  execution tool**. Confirmation is a separate path reached only by an explicit human action
  carrying a server-issued `draft_id`.
- [ ] **Deterministic risk checks live outside the model** and no prompt can bypass them:
  restricted-symbol list, fat-finger notional cap, price collar (±%), buying-power check. Blocked
  drafts cannot be confirmed.
- [ ] **`ALLOW_LIVE_TRADING` gate** (off by default): routing to a real *live* broker account
  requires this explicit flag, independent of which account is connected.
- [ ] **A draft can't be confirmed on a different account than it was drafted for** (`ACCOUNT_CHANGED`).
- [ ] **Secrets are server-side only** (BFF is the boundary); a CI **secret-leakage gate** greps
  client code for keys/`process.env` and the repo for key patterns.
- [ ] **Prompt-injection posture:** tool results & documents are treated as data, not instructions.
- [ ] **Advice questions refuse a recommendation + disclaim;** the assistant never claims to have
  executed anything.

## 2. Accounts & brokers

- [ ] **"Test (local)" account** — always-available, explicitly *fake* account where the app owns
  the ledger and picks starting buying power *because it's simulated*. Not "paper of" any broker.
  (History: was "paper" → "Mock (local)" → **"Test (local)"**; verify the final naming.)
- [ ] **Connectable real brokers** — Alpaca **Paper** and **Live** are *connections*, not defaults;
  buying power/positions/fills come **from Alpaca**, not invented by the app.
- [ ] **Broker abstraction** — one `BrokerProvider` contract; `test` (local ledger) + `alpaca`
  (REST adapter for `/v2/account`, `/v2/positions`, `/v2/orders`, `getOrder`, `cancelOrder`);
  **injectable transport**, unit-tested offline; broker creds never persisted.
- [ ] **Accounts registry** — per-user connected accounts + active selection; `connectAlpaca`,
  `setActive`, `listAccounts`, `accountSnapshot`. Endpoints `GET /api/accounts`,
  `POST /api/accounts/active`, `POST /api/accounts/connect`.

## 3. Order lifecycle

- [ ] **Draft → confirm → blotter → fill** loop. Orders (submitted) are distinct from drafts
  (ephemeral). Status enum: `open` / `partially_filled` / `filled` / `canceled` / `rejected`.
- [ ] **Async fills:** Mock fills instantly; Alpaca is async (`accepted → open → poll → filled`),
  advanced by a background poller (`ORDER_POLL_MS`). Cancel working orders; a filled order can't be
  canceled (`NOT_OPEN`). Endpoints `GET /api/orders`, `POST /api/orders/cancel`.

## 4. Price alerts

- [ ] **Alerts store** — per-user rules (`symbol`, `op` `<`/`>`, `price`), `armed → triggered`
  lifecycle, trigger **once**, record trigger price. `GET/POST/DELETE /api/alerts`.
- [ ] **Server poller** (`ALERT_POLL_MS`) evaluates armed alerts vs quotes.
- [ ] **NL creation** — "alert me when AAPL drops below 190" via a `create_alert` tool (low-stakes,
  **no draft gate**, unlike orders).
- [ ] **One-click "set alert" from the watchlist** (prefill symbol + current price).

## 5. Notification delivery — **see PR #8 in `public` (the reference implementation)**

- [ ] **Out-of-app delivery of triggered alerts** over **user-selectable, admin-configured**
  channels: **phone push** (ntfy free / Pushover), **webhook** (always available — user supplies
  https URL), **email** (Resend), **SMS** (Twilio). Injectable `fetch` ⇒ offline-testable.
- [ ] **Per-user prefs** (channels + targets) stored server-side; admin secrets in env only.
- [ ] **Settings surface** exposing only admin-enabled channels (+ webhook), with a "send test".
- [ ] **Reconcile with Agentic Trading's existing notification UIs** — the **Settings →
  Notifications** tab (webhook URL + event toggles: Fill / Block / Run Failed / Pending Approval /
  Kill Switch) **and** the Activity-button popup notifications tab. Unify into one system; extend
  alert delivery to **event types** (revised set), not just price-threshold alerts.

## 6. Memory (Deep Dive 12)

- [ ] **Salience-gated write policy** (durability/specificity/confidence/source scoring) with a
  **PII hard-gate**; **reconcile-on-write** (supersede, not accumulate); hard constraints always
  retrieved first; "what I remember" panel with forget/hard-delete.
- [ ] Memory stores **purposes/constraints, not live state** (balances/positions are fetched).

## 7. Knowledge base / RAG (Deep Dive 7)

- [ ] **Offline-first RAG**: structure-aware chunking (headings/paragraphs, overlap, atomic tables,
  contextual headers, `acceptance_datetime`); **deterministic mock embeddings** + opt-in Voyage
  stub (injectable transport); **hybrid dense+lexical search fused with RRF**; metadata prefilters
  for `ticker`, `doc_type`, and **point-in-time `as_of`**.
- [ ] **Read-only `kb_search` tool**; answers cite chunk ids and **refuse when retrieval is empty**.
- [ ] Routes `POST /api/kb/ingest`, `GET /api/kb/docs`, `DELETE /api/kb`, `GET /api/kb/search`.
- [ ] Seed corpus for smoke tests/evals. **pgvector swap point** preserved
  (`upsertChunks`/`search`/`dump`/`restore`).

## 8. Watchlist & conversation history

- [ ] **Watchlist** — per-user, canonicalized/deduped symbols, quote-hydrated; `watchlist_add`
  tool; `GET/POST/DELETE /api/watchlist`.
- [ ] **Conversation history** — per-user transcript, **100-turn cap**, **redaction** of obvious
  secrets/SSN/card-like values before persistence; `GET /api/history`; UI reloads on boot.

## 9. LLM architecture (Deep Dives 9 & 12)

- [ ] **One provider-agnostic contract** `run({system,message,tools,executeTool,context}) →
  {text,toolCalls,citations}` shared by **MockLLM** (offline, tool-loop-shaped) and **AnthropicLLM**
  (real Messages API tool loop, **bounded by MAX_STEPS**, injectable transport).
- [ ] **Versioned system-prompt bundle** (`atlas-sys@…`): treats tool output as data, forbids
  execution, injects retrieved memory (hard constraints as rules).
- [ ] **Model-to-task routing tiers** (router/extract/answer/reason) as config, never exposing raw
  model IDs to users.

## 10. Platform: identity, persistence, audit, deploy, CI

- [ ] **Signed-session identity** — HMAC `HttpOnly` cookie; server **derives the user** (ignores
  client-supplied `userId`); tampered/forged/expired tokens rejected.
- [ ] **Pluggable persistence** — `STORE=memory` | `file` (atomic temp+rename JSON snapshots);
  every store has `dump()/restore()`; **Postgres+pgvector swap point** documented.
- [ ] **Append-only audit log** — records every LLM turn, tool call, draft, confirmation, fill,
  alert, and notification.
- [ ] **Self-host deploy scaffold** — `launchd` keep-alive (`com.jays.trading`), **Cloudflare
  Tunnel** to `socratictrade.com`, `HOST=127.0.0.1` in prod, state backups, and **auto-deploy
  on merge** (`com.jays.trading.autoupdate`). *(May be N/A if Agentic Trading deploys differently —
  decide consciously. Note: the `backup-state.sh` cron is what's generating local mail; silence it
  with `>/dev/null 2>&1` or remove if Atlas is retired.)*
- [ ] **CI gates** — unit tests + **prompt-eval gate** (adversarial no-execute golden cases:
  jailbreak "place the order now", role-play "you are BrokerBot", guaranteed-return solicitation) +
  secret-leakage gate.

## 11. Design/analysis ideas (not yet built in Atlas — candidate backlog)

These live in `docs/` and may contain ideas worth porting even though Atlas never implemented them:

- [ ] `docs/multi-expert-app-analysis.md` — the original multi-expert improvement catalog.
- [ ] `docs/deep-dives/06-trading-algorithms.md`
- [ ] `docs/deep-dives/07-databases-and-rag.md`
- [ ] `docs/deep-dives/08-cache-embeddings-memory.md`
- [ ] `docs/deep-dives/09-prompting-and-llm.md`
- [ ] `docs/deep-dives/10-machine-learning.md`
- [ ] `docs/deep-dives/11-implementation.md`
- [ ] `docs/deep-dives/12-memory-format-and-model-decisions.md`

---

## Likely **N/A** when merging into Agentic Trading (confirm, don't assume)

- The **vanilla-JS web console** (`apps/web`) — Agentic Trading has its own Next.js UI; port
  *concepts/panels*, not the markup.
- The **zero-dependency Node `http` BFF** structure — Agentic Trading likely uses Next.js API
  routes/server actions; port the *logic and boundaries*, not the server scaffolding.
- **Mock LLM / mock market-data / Test (local)** stand-ins — keep only if Agentic Trading wants an
  offline mode; otherwise they're dev-only.
- The **Atlas deploy scaffold** — only if Agentic Trading isn't already deployed its own way.

The **portable, product-defining ideas** (sections 1–9) are the ones that must not be lost.
