# Open Questions for Jay

Running list of decisions that need **your** answer. I keep working autonomously and log questions
here instead of blocking; answer any time (in a batch is fine). When you answer one, I'll act on it
and strike it through with the resolution.

Format: `### Qn — <short title>` · **Context** · **Options** · **My default if you don't answer** ·
**Blocks:** what's gated.

---

### Q0 — ✅ RESOLVED (2026-06-21): Worktree collision — work in your own worktree, land via PR
**✅ Resolution — option (a):** One agent per worktree; agents NEVER edit/build/`npm install`/switch-branch
in the `main` integration worktree (`~/Code/Agentic Trading`) — it is review/merge only; land via
`scripts/land.sh` → PR, and the human integrator merges. This is now **enforced**: `scripts/githooks/pre-push`
blocks direct pushes to `main` and pushes from the main worktree; `scripts/land.sh` runs the verify gate
and opens a PR; AGENTS.md has a "Multi-agent landing protocol" section. Honest limits (no server-side branch
protection on this private repo; `--no-verify` bypass; hooks guard pushes not file-writes) are documented in
`docs/reviews/2026-06-21-multi-agent-coordination-review.md`. _(Original question retained below for context.)_
**Context:** This session works in the `main` integration worktree (`~/Code/Agentic Trading`), but a
concurrent agent is actively editing core files here (`strategy.ts`, `db.ts`, `policy.ts`, `types.ts`,
`red-team.ts` + a new `risk-breaker.ts`) — a drawdown/risk-breaker feature, currently in a broken
intermediate state. That blocks my verify gate (`tsc`/`build` fail on their WIP) and the NEXT-tranche
items would touch shared files (`db.ts`, `vector-db.ts`). The repo's own model is one agent per worktree
(Claude → `~/apps/trading-claude`).
**Options:** (a) I move to my own worktree `~/apps/trading-claude` (branch `agent/claude`), sync `main`,
and continue there isolated + verifiable, landing via merge · (b) you enforce one-agent-per-worktree and
I stay here · (c) I pause until their WIP lands.
**My default (chosen):** Paused further file-editing here; the full NOW tranche is committed + pushed and
unaffected. Tell me (a)/(b)/(c) and I'll resume.
**Blocks:** all further autonomous code work.

### 2026-06-21 — Q2/Q3/Q4 answered (full design: `docs/chat-multiuser-learning-design.md`)
- **Q2 → ✅ (b) full-filing ingestion** with a paid Voyage key. Build EDGAR-body fetch → the existing
  `storeDocument`/`chunkDocument` path (currently dead) → `ingested_accessions` de-dup, app-funded
  `scope:'shared'`. Scheduled LATER (after auth + the learning loop). [design §3]
- **Q3 → ✅ GO multi-user; ship-today = auth.** ⚠️ The design found **no auth + a universal IDOR**: `userId`
  is spoofable (`x-user-id`/`?userId`, default `'local'`) so anyone can read/overwrite another user's
  encrypted API keys or place trades as them. Ship-today slice = session auth (`middleware.ts` + signed
  cookie), drop the spoofable fallbacks, remove the `'local'` default (fail closed), route-ownership
  assertions, migrate `'local'` → the first real user. [design §2, §4]
- **Q4 → ✅ shared facts + tiered crossover learning.** Winner = **A3-core + A2/A1 grafts**: a
  `learned_context` store where the `fact` tier passes silently (advisory prompt DATA, *structurally* unable
  to move risk/sizing), `strategy-directive` is an AI-authored diff-able `<!-- AI-LEARNED -->` prompt block
  the user approves, and `risk` is confirmation-gated via the existing `applyStrategyTuning → PUT /api/policy`
  rail. Facts shared cross-user (opt-out) only at the `fact` tier; strategy/memory/transcripts never shared.
  [design §1]
- **Q1 (LLM provider)** — your answer (users choose among multiple frontier LLMs; app-paid-vs-BYOK decided
  later) is recorded; the provider-agnostic `ChatLLM` + model selector stands. Still open: which 2nd provider
  to wire first.

### Q1 — LLM provider provisioning & which to ship first
**Context:** The chat is provider-agnostic (`ChatLLM`); `AnthropicLLM`, `OpenAILLM`, and `MockLLM`
exist (`src/lib/chat/llm.ts`). `getLLM(userId)` resolves the active provider via
`resolveLlmCredential`, trying Anthropic then OpenAI in priority order. OpenAI is the 2nd adapter
and is live; the model-selector UI is the remaining NEXT item.
**Options:** (a) app-provided keys (you pay, simplest UX) · (b) user-provided keys (BYOK, per-user via
`resolveApiKey`) · (c) both. And which providers first (Anthropic / OpenAI / Gemini)?
**My default:** Keep the provider-agnostic interface + a model selector; assume BYOK via the existing
key store unless told otherwise.
**Blocks:** model-selector UI (NEXT/LATER).

### Q2 — RAG corpus depth (cost answered)
**Context:** Only 8-K summaries are indexed; the structure-aware chunker is built but unused. Full
10-K/10-Q ingestion is the highest-leverage RAG move. Cost ≈ $15–55 one-time embeddings + $5–30/mo
Pinecone; the free Voyage **3 RPM** tier is the real throughput gate (a paid key removes it).
**Options:** (a) stay 8-K-only + make the UI honest about the boundary (cheap, no new key) · (b) ingest
full filing bodies (needs a paid Voyage key for practical backfill).
**My default:** Ship the "honest UI about the 8-K boundary" now (cheap); hold full-filing ingestion for
your go-ahead on the paid Voyage key.
**Blocks:** NEXT — full-filing ingestion.

### Q3 — Auth before chat reads portfolio state
**Context:** `userId` comes from an unauthenticated header/query/body (`docs/phase-11-multi-user`). The
NOW read-only state tools (positions/P&L/proposals) widen data exposure **if** this ever runs
multi-user. The app is documented as **local-only / single-user** today.
**Options:** (a) it's effectively single-user local now → proceed, harden auth in parallel · (b)
phase-11 auth must land before chat can read portfolio.
**My default (taking (a)):** Proceeding with the read-only state tools since the app is local
single-user; this question gates the multi-user rollout, not local use.
**Blocks:** multi-user rollout of the chat state tools.

### Q4 — Multi-user feedback / memory isolation
**Context:** When/if multi-user, chat feedback + salience memory scoping.
**Options:** (a) strictly per-`userId` isolation (recommended, default) · (b) some cross-user "what
works" aggregation.
**My default:** Fully per-user isolated.
**Blocks:** the feedback-capture work (NEXT) only matters here once multi-user.
