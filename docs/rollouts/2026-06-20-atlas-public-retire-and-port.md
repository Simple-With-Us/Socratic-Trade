# 2026-06-20 — Retire `jaywedgeworth22/public` (Atlas) + port useful work into the private repo

Living note for the multi-step effort to salvage, port, and retire the public "Atlas" BFF repo
(`jaywedgeworth22/public`), which held work meant for this canonical private repo.

## Summary / decisions

A multi-agent inventory (14 agents) classified every Atlas subsystem against the private repo.
User decisions: **preserve AND port the useful bits into TS now**; **empty the public repo but keep
the shell**; **retire the live Atlas deployment** (after confirming the Cloudflare tunnel serves the
dashboard, not the BFF); **delete the redundant `~/agentic-trading` clone**.

Key discovery: `jaywedgeworth22/public` was not a dead repo — it was a **live, auto-deploying
deployment** on this Mac (`~/Code/trading`, launchd `com.jays.trading` BFF on :8787, a 5-min
`com.jays.trading.autoupdate` git-puller, a 30-min backup cron, behind the same
`socratictrade.com` Cloudflare tunnel as the private dashboard). The tunnel was confirmed to
serve the private dashboard on **:4000** (the BFF ran in full mock mode with zero request traffic;
no ESTABLISHED connections to :8787; private docs all point the tunnel at :4000).

## Salvage classification (verified against real code)

- **Already ported / superseded — dropped:** watchlist, alerts, orders/blotter, accounts/brokers,
  infra (auth/config/persistence/audit/market-data/types), vanilla-JS web frontend, deploy scripts,
  docs (byte-identical in `docs/atlas/`).
- **Useful — preserved + being ported to TS:** chat orchestrator (LLM tool-loop + draft-card +
  versioned safety prompt), RAG structure-aware chunking + `as_of` point-in-time filter, salience
  memory, transcript redaction store, no-execute golden eval gate, multi-channel alert delivery
  (notify), and two spec docs (account-naming, Atlas→Agentic merge checklist). The notify module +
  both specs existed only on unmerged branches.
- The inventory also found the integration map **overstated** RAG: storage (Pinecone/Voyage) is
  shipped, but chunking, hybrid retrieval, point-in-time filtering, and citation surfacing are NOT.

## Steps (chronological)

1. **Preserve (done):** complete `git bundle` of all 9 branches + PR refs → `reference/atlas-public-src/atlas-public.bundle`; useful source extracted alongside; `reference/atlas-public-src/README.md` documents provenance + the port plan.
2. **Delete redundant clone (done):** `rm -rf ~/agentic-trading` (verified clean duplicate of the private repo; worktrees intact).
3. **Retire deployment — safe half (done):** uninstalled `com.jays.trading.autoupdate`, removed the backup cron (both archived to `~/.atlas-retired/`).
4. **Retire deployment — BFF (done):** stopped + uninstalled `com.jays.trading` (mock-mode orphan, tunnel serves :4000). `~/Code/trading` checkout left on disk as instant rollback; bundle is the durable copy.
5. **Empty the public repo (done):** deleted the 8 non-`gh-pages` branches; wiped `gh-pages` to a tombstone README (`3ad7508..768e2f3`). Only the empty `gh-pages` remains.
6. **Port useful subsystems to TS (done):** all six ported, each verified (tsc + targeted test) and committed:
   - RAG structure-aware chunking + `as_of` point-in-time (`f21ba26`) — `src/lib/rag/chunk.ts`, `vector-db.ts`.
   - Multi-channel alert delivery (`68d5ca0`) — `src/lib/notify.ts`, `notification_prefs`, `app/api/notifications/*`.
   - Transcript history + redact-on-write (`1375941`) — `src/lib/chat-history.ts`, `chat_turns`, `app/api/chat-history`.
   - Salience-gated memory (`a5611be`) — `src/lib/memory/*`, `user_memory`, `app/api/memory`.
   - Chat orchestrator + no-execute eval gate (`4b6f4eb`) — `src/lib/chat/*`, `app/api/chat`, `test/atlas-golden-eval.test.ts`.
   - Build/lint fix (`03c6f27`) — normalize `node:crypto`→`crypto`; exclude `reference/**` from vitest.
7. **Fix `docs/atlas-integration-map.md` (done):** corrected the RAG "already shipped" overstatement (storage was shipped; chunking/point-in-time/citations were not) and marked all ports.

## Files (so far)

- `reference/atlas-public-src/**` (new — archive bundle + extracted source + README)
- `docs/rollouts/2026-06-20-atlas-public-retire-and-port.md` (this note)

## Verification

- Bundle integrity: `git bundle list-heads` shows all 9 branches + PR refs.
- Tunnel: `lsof` — active connections on :4000, none on :8787; BFF log shows mock-mode + no traffic.
- Secret scan of public repo (all branches): clean — only `.env.example` placeholders.

## Verification (final)

- Full gate green on `main`: `npx tsc --noEmit` clean (pre-existing `alternative-data.test.ts`
  mismatch aside), `npm test` = **46 files / 339 tests** pass, `npm run build` OK (`/_not-found`
  prerenders). New tests: rag-chunk (5), notify (4), chat-history (5), memory (5),
  chat-orchestrator (3), atlas-golden-eval (10).

## Follow-ups / risks

- **User to confirm:** `https://socratictrade.com` still loads the dashboard after the BFF stop
  (Cloudflare Access blocks automated checks). If off, relaunch from `~/.atlas-retired/`. After
  confirmation, `rm -rf ~/Code/trading` for final cleanup.
- **UI wiring deferred (backends ported):** the chat panel, memory panel, notify-prefs settings,
  watchlist/alerts UI, and a draft-card confirm flow are not yet wired into the dashboard — only the
  APIs (`/api/chat`, `/api/memory`, `/api/notifications`, `/api/chat-history`) and libs exist.
- **AnthropicLLM is config-gated:** chat uses the deterministic MockLLM unless `CHAT_LLM=anthropic`
  + an Anthropic key are set. `draft_order` only mints a ticket (no live proposal/execution wiring yet).
- RAG hybrid/RRF rerank from the Atlas store was intentionally NOT ported (Pinecone dense ANN is the
  production path); only chunking + `as_of` were salvaged.
