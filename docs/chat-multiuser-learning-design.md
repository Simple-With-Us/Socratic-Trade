# Chat: Multi-User + Crossover-Learning + Full-Filing RAG — Design

> Produced by the `multiuser-learning-design` workflow (13 agents: 5 understand readers, 4 candidate
> designs, 3 independent judges, 1 synthesis) on 2026-06-21, resolving open questions Q2/Q3/Q4.
> This is the source of record for the multi-user + learning-crossover build.

# Agentic Trading — Final Design: Crossover Learning, Multi-User, and Full-Filing RAG

## Decision summary

**Winner: a synthesized hybrid, "A3-core + A1/A2 grafts."** Adopt **A3 (Structured silent-passthrough `learned_context` store)** as the spine because it is the only design that makes the silent path *structurally incapable* of moving risk/sizing (Safety judge 9, Efficacy judge 9), and graft on two runner-up strengths:

- From **A2**: render the highest-friction artifact — strategy-directive prompt edits — as a **bounded, diff-able, rule-id-stable `<!-- AI-LEARNED -->` block** inside the existing user-editable strategy textarea, merged **server-side** (UX judge 8; this is A3's weakest UX point — an "invisible second store").
- From **A1**: route any **risk-tier** signal through a real **confirmation queue that reuses the existing `applyStrategyTuning → PUT /api/policy` rail** rather than a brand-new parallel proposal lifecycle (A1's conservatism without A1's confirmation-fatigue tax).

**Why this hybrid and not pure A3:** A3 scored 9/9/6. Its only losing lens was UX/tractability, where the judge docked it for turning learning into "an invisible second channel … harder to explain than A2's 'it's just text in your box.'" Grafting A2's visible prompt-block for the *one* tier the user most needs to see (strategy-directives) closes that gap without sacrificing A3's structural guarantee for the fact tier. The result dominates: it keeps A3's "facts can't move risk by construction," gains A2's legibility where it matters, and reuses A1's proven confirmation rail for risk.

**Judge tally (decision-relevant):**

| Design | Safety | Efficacy | UX | Notes |
|---|---|---|---|---|
| A3 | **9** | **9** | 6 | wins 2 of 3; only loses on "invisible store" UX |
| A1 | 8 | 3 | 5 | safest-feeling but confirmation-fatigue kills learning; *starves brain mid-rollout* |
| A2 | 6 | 5 | **8** | most legible; but leaves reflection auto-injecting, facts-as-prose steer silently |
| A4 | 4 | 7 | 4 | disqualifying: "soft" tier auto-applies to the run-every-time prompt with no confirm |

---

## 1. Recommended crossover-learning + strategy-update design (Q4)

### 1.1 The three-tier contract (the tier *is* the gate)

Every learned signal — from chat or from the autonomous post-mortem — is run through one classifier, `classifyRiskTier(candidate)` in a **new** `src/lib/learned-context/classify.ts`. The returned tier deterministically selects the write path. There is no other gate.

| Tier | Trigger | Gate | Write path | Reaches brain how |
|---|---|---|---|---|
| **`fact`** | `kind ∈ {pattern, decision, fact}`, `subject ∉ RISK_SUBJECTS`, value has no size/limit/weight/authority vocabulary, passes PII + abuse gates | **SILENT PASSTHROUGH** (no row in UI queue, no confirm) | `ingestLearned` writes a `learned_context` row directly (`scope=private`; `scope=shared` only if `contributeShared` on + non-personal + source-attributed) | **Advisory only** — injected as a labeled `<learned_context>` DATA section in the bull-agent prompt at the existing `strategy.ts:138-151` ragContext seam. **Never** an input to `applyDeterministicSizing` (`strategy.ts:439-480`) or `scoringWeights`. |
| **`strategy-directive`** | Intent is to change *how* the strategy behaves (selection/sizing heuristic), not a hard numeric limit | **EXPLICIT AI PROMPT-WRITE + visible diff + human click** | AI authors a bounded `<!-- AI-LEARNED:<rule-id> YYYY-MM-DD -->` block, **appended not wholesale-replaced**, persisted via the unchanged `setStrategyPrompt` (`db.ts:665`); before/after diff in `TuningCard` (`settings.tsx:801`) | The block is part of the per-user `strategyPrompt`, read unchanged at `strategy.ts:156/820` |
| **`risk`** | `subject ∈ RISK_SUBJECTS` (`max_position_pct`, `risk_tolerance`, `no_leverage/margin`, sector cap, `stop_loss`, `take_profit`, `strategyAuthority`, any `scoringWeight` key) **OR** value matches a numeric size/limit/percent-allocation phrase | **CONFIRMATION REQUIRED** (never silent, never auto-applied) | Row in `learned_context_pending`; on approval flows through the **existing** `applyStrategyTuning → PUT /api/policy` write surface (`policy/route.ts:19,68`), which re-runs `validatePolicy` (`route.ts:72-116`) and the 20-closed-lot weight gate (`strategy-tuning.ts:191-194`) | Only after human approve; a **risk-limit increase or `strategyAuthority='decide'` additionally requires a typed second gate**, mirroring the from-draft `BROKERAGE·LIVE` pattern |

**Hard invariants (enforced by tests):**
- Chat-origin candidates reach **at most** tier `fact` silently; any chat signal classified `risk` or `strategy-directive` is **downgraded to the pending queue** — chat can never silently move risk/size/weights.
- The bull-agent reads `learned_context` only via read-only `retrieveLearnedContext`; there is **no write path** from the agent into the store.
- **Fail-closed:** `classifyRiskTier` defaults `UNKNOWN → risk → pending`. Conservative `RISK_SUBJECTS` + intent keywords (e.g. "lean much harder into", "more aggressive") force risk-adjacent prose without a numeric trigger into the queue.

### 1.2 Two crossover producers (the actual "get smarter" loop)

1. **Chat → autonomous (lights up dormant code).** `salience.ts` already declares the `pattern`/`decision` `MemoryKinds` with durability 0.5/0.9 (`salience.ts:14-15`) but `extractCandidates` (`salience.ts:24-76`) never emits them — verified dead scaffolding. Extend `extractCandidates` to emit `pattern`/`decision` learned-**facts** and route them via `orchestrator.ts` into `ingestLearned(userId, candidate, origin='chat')` — **not** into `memory/store.ts insertMemory`. `constraint/preference/goal/correction` continue to `user_memory` unchanged. `chat/tools.ts` gains **no** new tool, so the type-level chat-isolation guarantee (tools.ts imports no brain-write fn) holds.

2. **Autonomous → own learning (de-opaques the one ungated path).** Today `post-mortem.ts:151` writes only the free-text `reflection_summary` user-setting, which **auto-injects unreviewed** into the live bull-agent prompt at `strategy.ts:823`. Add a structured sink: post-mortem emits `learned_context` rows (`origin='autonomous'`) for non-risk facts/patterns it finds. Risk/sizing inferences stay advisory or, if promoted, go through the same pending queue. This converts the opaque blob into per-row, attributable, supersedable, **erasable** records.

> **Reflection_summary disposition (resolving A1's mid-rollout-starvation risk):** We do **not** gate reflection injection on day one. The structured `learned_context` rows run **in parallel** with the existing `reflection_summary` injection. Only once the structured path is verified do we surface reflection with an acknowledge step. This avoids A1's self-admitted "brain is starved mid-rollout" failure (Efficacy judge penalized A1 for exactly this).

### 1.3 Data model — shared-facts vs per-user split (explicit, not magic-string)

**New tables (`src/lib/db.ts`, near `user_memory` at db.ts:307, using the legacy backfill/index migration pattern at db.ts:322-336):**

```
learned_context(
  id PK, user_id NOT NULL, scope CHECK(scope IN ('private','shared')),
  kind (pattern|decision|fact), subject, symbol, value, source,
  origin (chat|autonomous|ingest), risk_tier (fact|risk|strategy-directive),
  confidence, contributor_user_id, asserted_at, superseded_by, expires_at
)  -- indexes (user_id,scope,superseded_by) and (symbol,scope,superseded_by)

learned_context_pending(
  id, user_id, candidate JSON, proposed_diff JSON, origin, created_at,
  status (pending|approved|rejected)
)
```

**Sharing rule (Q4):** a row may be `scope='shared'` **only when** `risk_tier='fact'` AND `kind ∈ {pattern,fact}` AND it passed PII/abuse gates. `risk` and `strategy-directive` rows are **always** `scope='private'` and non-shareable — enforced by both the `CHECK` constraint and a write guard in `ingestLearned`. **Private strategy, prompt, policy, and `user_memory`/`chat_turns` are never shared.**

**No new shared *strategy* table.** The only cross-user store remains the Pinecone DATA-FACTS layer plus this fact-tier of `learned_context`. Per-user opt-outs reuse `user_settings` via `getUserSetting/setUserSetting` (db.ts:474-486) — **no new table**: `learnedContext.contributeShared` (default true) and `learnedContext.includeShared` (default true).

### 1.4 File-level change plan

- `src/lib/learned-context/classify.ts` **(NEW)** — `classifyRiskTier()` with `RISK_SUBJECTS` set + numeric size/limit/percent matchers; unit-tested, fail-closed.
- `src/lib/learned-context/store.ts` **(NEW)** — `ingestLearned(userId, candidate, origin)` (runs classifier, PII/abuse gate, routes fact→direct write, risk→pending, strategy-directive→prompt-block proposal); `retrieveLearnedContext(userId, symbols, regime)` (merges private + opted-in shared fact rows, **per-contributor cap** to stop one noisy contributor dominating).
- `src/lib/learned-context/prompt-block.ts` **(NEW, A2 graft)** — `upsertAiLearnedBlock(prompt, ruleId, text)`: forgiving never-throw parser; insert/replace a delimited `<!-- AI-LEARNED:id ... -->` span; **server-side merge only** (client-side merge would race the ~800ms autosave at `dashboard-client.tsx:319` — this is the UX judge's flagged failure mode).
- `src/lib/db.ts` — add the two tables + `user_id`-scoped CRUD (`insertLearnedContext`, `listLearnedContextForDecision(userId,symbols,includeShared)`, `supersedeLearnedContext`, `insertPendingLearnedChange`, `listPendingLearnedChanges`, `resolvePendingLearnedChange`).
- `src/lib/types.ts` (~611) — `LearnedContextRow`, `RISK_FIELDS` set; reuse `StrategyTuningPatch` for the risk-tier patch.
- `src/lib/memory/salience.ts` — emit the dormant `pattern`/`decision` kinds; keep existing routing for the other four kinds.
- `src/lib/chat/orchestrator.ts` — after a chat turn, call `ingestLearned` for `pattern`/`decision` candidates. `chat/tools.ts` **unchanged** (no brain-write tool).
- `src/lib/strategy.ts` — at the ragContext block (`138-151`), add a parallel `retrieveLearnedContext` call; inject a labeled `<learned_context>` DATA section beside `retrievedFinancialContext` (`857`). **No change** to `applyDeterministicSizing`/`scoringWeights`.
- `src/lib/post-mortem.ts` — alongside `reflection_summary` (`:151`), emit structured `learned_context` rows (`origin='autonomous'`).
- `src/lib/strategy-tuning.ts:468` (`toPatch`) — stop wholesale-replacing `proposedPrompt`; emit classified `learnedRules`; keep the 20-lot weight-strip at `:191`.
- `app/api/learned-context/route.ts` **(NEW)** — GET pending + rows; POST approve/reject (risk→`applyStrategyTuning`/PUT `/api/policy`; strategy-directive→prompt-block write); opt-out toggles.
- `app/ui/dashboard/settings.tsx:801` (`TuningCard`) / `:871` (`StrategyStudio`) — pending-learned-changes queue, opt-out toggles, **before/after prompt diff** for strategy-directive approvals; per-field accept/reject for risk patches.
- `app/dashboard-client.tsx:431` — split one-click `applyStrategyTuning` into `applyLearnedRule` (learned-rules route) and `applyRiskPatch` (PUT `/api/policy` with typed confirm).
- `src/lib/events.ts` — add a `pending_learned_change` `DashboardEvent` type.
- `test/learned-context.test.ts` **(NEW)** — assert `fact⇒silent write`, `risk⇒pending` (never auto-applied, never in prompt), `strategy-directive⇒diff+confirm`; chat-origin risk downgraded; shared rows are fact-only and respect `includeShared`/`contributeShared`; **regression test that `learned_context` is consumed only as advisory prompt text, never as a numeric input to `applyDeterministicSizing`/`scoringWeights`** (this test pins the entire safety guarantee — Safety judge called it the single most important property).

### 1.5 THE DISSENT (state it plainly)

**The UX judge ranked this approach *third* (A3=6), behind A2 and A1, and would have shipped A2.** Its argument is real and decision-relevant: A3 "introduces a `learned_context` store the user can't directly see/edit the way they can edit prompt text — learning becomes an invisible second channel … three tiers plus `contributeShared`/`includeShared` toggles plus a pending-changes queue is more concepts to absorb than A2," and it is "the most moving parts of any 'real' design, which cuts against 'possibly today.'" A2 by contrast reuses the existing TuningCard button and autosaving textarea so "the visible UI barely changes."

**Why we overrode it (and what we conceded to it):** Two of three judges (Safety, Efficacy) ranked A3 first, and both turned on the same load-bearing property — that the silent fact tier is *structurally* unable to move risk because it only adds advisory prompt DATA, never numeric sizing/weight inputs. A2 cannot make that guarantee: the Safety judge found A2 "lets facts-as-prose steer behavior without tripping a risk limit" and **leaves `reflection_summary` auto-reaching the brain outside its mechanism** — a self-admitted silent autonomous→brain channel. For a system that places trades, the structural safety property outweighs the UX simplicity delta. **We conceded the UX judge's strongest point by grafting A2's visible, diff-able prompt block onto the `strategy-directive` tier** — so the learning the user most needs to see *is* "just text in your box," while the high-volume fact tier stays structured and silent. A second, secondary dissent (shared by every judge and both A3 risk notes): the classifier is a single security-critical chokepoint; a risk-adjacent phrase mis-tiered as `fact` would pass silently. Mitigation is the fail-closed default, conservative `RISK_SUBJECTS`, the chat-origin cap at tier `fact`, and the no-numeric-input regression test above.

---

## 2. Multi-user architecture (Q3)

### 2.1 Auth/session approach

There is **no auth today** — `userId` is an unauthenticated client hint (`x-user-id` header → `?userId=` → body, default `'local'`) at `src/lib/request-user.ts:9-16`, and the frontend hardcodes `?userId=local` (`dashboard-client.tsx:2781,2820`; `settings.tsx:404,443`). This is a universal IDOR: anyone can read/overwrite another user's encrypted API keys or place trades as them.

**Minimal viable identity (ship-this-milestone):** add **signed cookie session auth** (iron-session or Auth.js) plus a Next.js **`middleware.ts`** (currently absent) that authenticates every `/api/*` request, returns 401 on failure, and attaches a **trusted** `userId` to request context. Then:
- Rewrite `resolveRequestUserId` (`request-user.ts`) to derive `userId` from the verified session **first**; **drop the `x-user-id` header and `?userId`/body fallbacks for browser traffic**. Keep a header-token path only for explicitly issued per-user API tokens validated against `user_api_keys`-style storage.
- **Remove the silent `'local'` default** in favor of a 401 — so a missed plumbing site fails **closed** instead of landing in the shared tenant.

### 2.2 Per-user-isolation enforcement points currently MISSING (cite file:line)

The persistence layer is **already correctly scoped** (`WHERE user_id = ?` on watchlist, alerts, keys, accounts, proposals, fills, snapshots, memory, chat, policy, audit). The gaps are at the edge and a few cross-tenant choices:

1. **No auth/middleware** — no `middleware.ts` anywhere; identity originates spoofably at `request-user.ts:9-16`. *Fix: middleware + session-derived userId.*
2. **Route-layer ownership not asserted** — `[id]` routes (`proposals/[id]`, `connected-accounts/[id]`, `profiles/[id]`) rely solely on the DB `WHERE user_id=?`. *Fix: after auth, assert `resource.user_id === session.userId` so a future query that forgets the predicate can't leak.*
3. **SSE stream is a global broadcast** — ✅ **Fixed**: `app/api/events/stream/route.ts`
   now reads the subscriber's `userId` and drops events tagged for a different tenant;
   untagged events are global. Audit of `emitDashboardEvent` call sites to set `userId`
   is the remaining follow-up.
4. **Robinhood broker token is process-global** — ✅ **Fixed**: `src/lib/mcp-oauth.ts`
   now keys the token (`robinhood_mcp_oauth_token:<userId>`), state
   (`robinhood_mcp_oauth_state:<userId>:<random>`), and all OAuth helpers by `userId`,
   enabling per-user broker linking via `auth/robinhood/start+callback`.
5. **Admin routes** gated only by `NODE_ENV!=='production' || x-admin-token===ADMIN_REINDEX_TOKEN` (shared ops secret), not per-user (`app/api/admin/*`). *Fix: require an authenticated admin role.*
6. **`'local'` defaults everywhere in db.ts** (`633,655,661,670,676`, etc.) fail **open** into the shared tenant. *Fix: drop defaults (or throw on missing userId) once auth lands.*
7. **No CSRF / same-site / rate-limiting** on mutating routes. *Fix once identity exists.*

### 2.3 Shared-facts vs private boundary

- **PRIVATE forever (never shared):** everything in `user_memory` (preferences/constraints/goals — `salience.ts` only ever emits these; PII-adjacent) and `chat_turns` (transcript/PII, redact-on-write). Plus all `learned_context` rows with `risk_tier ∈ {risk, strategy-directive}`, all strategy/prompt/policy.
- **SHAREABLE (DATA-FACTS only):** non-personal, source-attributed, dated facts — SEC/8-K/news/macro catalysts in Pinecone, and the `fact` tier of `learned_context`. Both governed by per-user opt-outs.

### 2.4 Per-user opt-out toggle

Reuse `user_settings` (`getUserSetting/setUserSetting`, db.ts:474-486) — **no new table**:
- `rag.includeShared` / `learnedContext.includeShared` (default true): when false, `retrieveContextDetailed` (`vector-db.ts:480-499`) and `retrieveLearnedContext` **skip the shared/public union** and read only the user's own rows.
- `rag.contributeShared` / `learnedContext.contributeShared` (default true): write-time opt-out of donating facts to the shared tier.

### 2.5 Shared-data-cache + shared-embeddings model

**Embeddings:** keep the single Pinecone index `robinhood-agentic` (`vector-db.ts:31`) with `userId` metadata tenancy, but **replace the `'local'` magic string with a first-class `scope:'shared'|'private'` metadata field** in `cleanMetadata` (`vector-db.ts:150-158`) and a `SHARED_SCOPE` constant. `retrieveContextDetailed` filters on `scope`, not on `userId=='local'` (`vector-db.ts:468-517`). Migrate existing `'local'` vectors to `scope:'shared'`. **Blocklist `userId=='local'/shared` as user-claimable** (`sanitizeUserId` vector-db.ts:88-93; `resolveRequestUserId`). Carry `scope`+`contributor` through `matchToChunk` (`vector-db.ts:423-436`) into `RetrievedChunk`/`Citation` so the model and citations distinguish shared filings from the asking user's private notes. **Sanitize the userId used for Pinecone/Voyage *key* lookup in `getClients`** (`vector-db.ts:100-101`) to match the already-sanitized metadata/query path (documented inconsistency).

**Data caches:** today the enrichment Map (`data-providers.ts:125`), Nasdaq screener (`market.ts:39`), and macro caches (`macro.ts:49`, `macro-history.ts:26`) are process-global, keyed `provider:symbol` **not** by userId — so they silently share one user's keyed/licensed data with all users with **no opt-out and no provenance**. The OHLC history cache (`history.ts:20-109`) is the **canonical correct pattern**: `shared:${symbol}` for free/env-keyed bars, `user:${userId}:${symbol}` for user-keyed bars unless `MARKET_DATA_SHARE_USER_KEYED_HISTORY=on`, with a `market_data_demands` table fulfilling earlier requesters. **Extend that pattern** to the other caches: tag each cached value with the `ApiKeySource` (`resolveApiKeyWithSource` already returns `'user'|'env'|'none'`, db.ts:2123); only cache-and-share **env/app-key or free-source** values; route **user-key** results to a private cache unless that user opts in. Critically, fix the macro caches, which currently redistribute the **first caller's FRED-keyed** result to everyone for 24h/12h. Before enabling any cross-user provider-data sharing, do a **per-provider ToS review** and gate sharing per-provider (allowlist), since redistribution/per-seat terms differ.

---

## 3. Full-filing RAG ingestion (Q2 / I5)

### 3.1 What exists vs what to build

**Today:** the only live write path is `refreshEightK` (`sec8k.ts`) → `storeContexts` (`vector-db.ts:249-336`), embedding a hand-built ~6-line `buildEightKContext` summary (`sec8k.ts:214-223`) — ticker, filed date, accession, item codes, URL. **No filing bodies, no 10-K/10-Q.** Crucially, the structure-aware chunker `chunkDocument` (`rag/chunk.ts:158-236`) and its consumer `storeDocument` (`vector-db.ts:343-365`) are **fully built and unit-tested but have ZERO production callers** — heading/table-aware chunking with `acceptance_datetime` + `context_header` per chunk, sitting unused.

**Build:**
1. **Filing-body fetcher** — from EDGAR submissions API (`data.sec.gov/submissions/CIK##########.json`) get recent 10-K/10-Q (and 8-K exhibit) accessions; fetch the primary `.htm`; strip HTML to text (reuse `decodeXmlEntities`/tag-strip already in `sec8k.ts`).
2. **Route bodies through the existing dead path** — call `storeDocument({text, ticker, doc_type:'10-K'|'10-Q', published_at, acceptance_datetime, source:'sec-edgar', url})`. This wires up the built-but-tested chunker with near-zero new code and immediately gives the corpus substance (risk factors, MD&A, financials) instead of catalyst flags.
3. **Persist `acceptance_datetime`/`doc_type`/`section` on EVERY record** (the live 8-K path omits them, so the as_of look-ahead guard and doc_type filters have nothing to filter on). Preserves backtest point-in-time integrity once bodies land.
4. **Ingest once, under the shared scope, app-funded.** Force all corpus writes to `scope:'shared'` under the app's env Voyage/Pinecone keys (the scheduler already has no user context). Gate on a **SQLite `ingested_accessions` table keyed by `accession+doc_type`** so the same filing is never re-embedded. Optionally cache embeddings at chunk level by `content_hash+model` so a filing is embedded **exactly once globally** regardless of how many users query it. Keep per-user keys only for private/user-uploaded docs.
5. **(Later) Port Atlas hybrid retrieval** (dense + BM25-lite + RRF + metadata pre-filter, `reference/atlas-public-src/bff/rag/store.mjs`) + Voyage `rerank-2` + a score floor + explicit insufficient-evidence path. Exact-match queries ("Item 5.02", dollar figures, CUSIPs) need the lexical leg the current dense-only path lacks.

### 3.2 Paid-Voyage-key readiness

The code is **already paid-ready**: `DEFAULT_EMBED_BATCH_DELAY_MS=21000` is documented as the free 3-RPM gate and "paid accounts can set this to 0" (`vector-db.ts:32-33`). All knobs are env-overridable: `VECTOR_EMBED_BATCH_SIZE`, `VECTOR_EMBED_BATCH_DELAY_MS`, `VECTOR_CONTEXT_MAX_CHARS`, `VECTOR_EMBED_RETRY_ATTEMPTS`. 429s are detected (`isRateLimitError`, `vector-db.ts:179-184`) and retried with retry-after-aware backoff + jitter; outcomes persist to an audit setting so a billing 429 isn't silent (the prior empty-index incident the reindex route recovers).

### 3.3 Throughput / cost plan (the 3-RPM free gate)

- **Free tier (3 RPM):** at `batch=8`, `21s/batch`, a single 10-K (hundreds of chunks) takes **many minutes**; market-wide backfill is impractical. Keep the live 8-K summary path on free keys; **do not** attempt body backfill on free.
- **Paid tier:** set `VECTOR_EMBED_BATCH_DELAY_MS=0` and raise `VECTOR_EMBED_BATCH_SIZE` toward Voyage's 128-input cap (`voyage-finance-2` allows ~120K tokens/request — batch large). This turns a multi-minute-per-10-K job into seconds.
- **Cost control via de-dup:** the `ingested_accessions` + chunk-level `content_hash` cache means each filing is embedded once globally and read by all users from the shared scope — the cheapest way to give user B user A's coverage without B's key. Raise/remove the 16-filing `eightKRagLimit` cap (`sec8k.ts:314`) and make the 8-K body ingest first-class (today it's fire-and-forget at `sec8k.ts:315`, errors swallowed to console).
- **Provenance UI (later):** surface corpus depth ("8-K through DATE; 10-K on file as of …") so users see freshness.

---

## 4. Sequenced roadmap

### SMALLEST SAFE SLICE — ship TODAY (multi-user)

**Goal:** make `userId` trustworthy and stop the universal IDOR, without touching the learning loop or RAG.

- **Files:** add `middleware.ts` (NEW, authenticates `/api/*`, 401 on fail, attaches trusted userId); rewrite `src/lib/request-user.ts:9-16` to derive userId from a signed session cookie and drop `x-user-id`/`?userId`/body for browser traffic; remove the `'local'` default → 401; add session-issuing `app/api/auth/login` (or iron-session config). Update the frontend fetch sites that hardcode `?userId=local` (`dashboard-client.tsx:2781,2820`; `settings.tsx:404,443`) to rely on the cookie. Add route-layer ownership assertions on `[id]` routes (`proposals/[id]`, `connected-accounts/[id]`, `profiles/[id]`). Data migration mapping the existing `'local'` dataset to the first real authenticated user (anticipated in `docs/phase-11-multi-user.md:112-122`).
- **Risks:** (a) the SSE stream and Robinhood global token are **out of scope for today** — note explicitly that cross-user *activity signals* (run/proposal/order events) still broadcast and the broker session is still process-global; these are deferred. (b) Existing `'local'` data must be migrated, not orphaned. (c) `'local'` must be blocklisted as a claimable userId before any sharing semantics are trusted.
- **Verify:** `npx tsc --noEmit` → `npm test` → `npm run build` (the mandated trio); add a test asserting an unauthenticated `/api/keys` request returns 401 and that a session for user A cannot read user B's keys/accounts.

### NEXT (after auth lands and is trusted)

- **Q4 learning loop, fact tier first:** new `learned_context` table + `classify.ts` + `store.ts`; light up the dormant `salience.ts` `pattern`/`decision` kinds; wire `retrieveLearnedContext` into `strategy.ts:138-151` as advisory DATA only. Ship the **regression test pinning "no numeric input to sizing/weights"** before anything else in this slice. **Files:** as in §1.4. **Risk:** classifier mis-tier — mitigated fail-closed + chat-origin capped at `fact`. **Verify:** trio + `test/learned-context.test.ts` (fact⇒silent, risk⇒pending, chat-risk⇒downgraded).
- **Scope metadata replacing `'local'` magic string** in `vector-db.ts:150/468` + opt-out flags (`includeShared`/`contributeShared`); migrate existing vectors to `scope:'shared'`; sanitize the key-lookup userId at `vector-db.ts:100-101`. **Verify:** trio + a test that a non-`'local'` user can never retrieve another non-shared user's vectors.
- **Risk tier + strategy-directive tier:** `learned_context_pending`, the A1-style confirmation queue reusing `applyStrategyTuning → PUT /api/policy`, and the A2-graft `prompt-block.ts` with **server-side merge** + before/after diff in `TuningCard`. Replace one-click `applyStrategyTuning` (`dashboard-client.tsx:431`) with per-field accept/reject. **Risk:** prompt-block parser racing the ~800ms autosave (`dashboard-client.tsx:319`) — mitigated by server-side-only merge + forgiving never-throw parser. **Verify:** trio + prompt-block append-not-replace test + autosave-race test.
- **Per-user SSE filtering** (`events/stream/route.ts`, audit all `emitDashboardEvent` call sites).

### LATER

- **Full-filing RAG bodies (Q2):** EDGAR submissions fetcher + route through `storeDocument`; `ingested_accessions` de-dup table; chunk-level embedding cache; persist `acceptance_datetime`/`doc_type`/`section`. Gate body backfill behind a paid Voyage key (`VECTOR_EMBED_BATCH_DELAY_MS=0`). **Verify:** trio + a point-in-time test that as_of drops look-ahead chunks once bodies carry `acceptance_datetime`.
- **Hybrid retrieval** (Atlas dense+BM25+RRF + Voyage rerank + score floor + insufficient-evidence path).
- **Per-user broker linking** — key `mcp-oauth.ts` `TOKEN_SETTING/STATE_PREFIX/CLIENT_SETTING` by userId; thread authenticated userId through `auth/robinhood/start+callback`.
- **Cache provenance/opt-out** — extend the `history.ts` shared/private pattern to the enrichment Map, screener, and macro caches (tag by `ApiKeySource`); fix FRED redistribution; per-provider ToS allowlist.
- **Hardening** — CSRF/same-site on mutating routes; per-user rate limiting; admin role auth replacing the shared `ADMIN_REINDEX_TOKEN`; right-to-erasure path that deletes a user's `userId`-tagged Pinecone vectors and `contributor_user_id`-keyed shared `learned_context` rows; extend the I8 "retrieved content is DATA not commands" fencing (`prompt.ts:22`) to the **strategy/decision LLM path**, since a poisoned shared chunk has an all-user blast radius.

---

**Net:** A3 spine for the structural safety guarantee (silent facts can't move risk), A2 graft for legible diff-able prompt edits where the user must see them, A1 graft for the proven confirmation rail on risk — with auth as the ship-today prerequisite that makes every per-user isolation guarantee real. Dissent recorded: the UX judge would have shipped A2 for simplicity; we overrode on the two-judge safety/efficacy majority and the trade-placing stakes, while conceding A2's strongest point via the visible prompt block.

---

## Appendix A — Candidate designs (debate)

### A1 — Confirmation-gated strategy-change proposals (second approve-rail mirroring the trade-proposal rail) (effort L)
- **Mechanism:** Add a SECOND proposal rail for STRATEGY changes, cloned from the trade rail (insertProposal -> status 'proposed' -> POST /api/proposals/[id]/approve -> executeProposal). It mutates the strategy box/policy/weights via the EXISTING sole write surface setStrategyPrompt+setPolicy (db.ts:655-667), today reachable only through PUT /api/policy and applyStrategyTuning (dashboard-client.tsx:431). TWO crossover producers feed the SAME rail, never the brain directly. (1) CHAT->AUTONOMOUS: new chat tool propose_strategy_change in buildTools() (tools.ts:49). Like draft_order (tools.ts:60, readOnly:false but 'creates a DRAFT only - still never executes') it RETURNS A TICKET, never writes policy; tools.ts imports NO brain-write fn, only enqueueStrategyChangeProposal() in new src/lib/strategy-change/queue.ts (INSERT only). (2) AUTONOMOUS->surfaced: re-point proposeStrategyTuning (strategy-tuning.ts:122) AND the reflection_summary (post-mortem.ts:151, which today auto-injects at strategy.ts:823 with NO gate) into the same queue as 'proposed' rows instead of applyStrategyTuning/silent injection. APPROVE writes the change EXPLICITLY: applyStrategyChangeProposal() stops wholesale-replacing the prompt (fixes toPatch strategy-tuning.ts:468-475) and instead appends/updates a bounded delimited '<!-- AI-LEARNED:id ... -->' block inside the user's prompt via setStrategyPrompt, with per-field accept/reject and a before/after diff in the UI. Trade rail is untouched.
- **Gating:** CONFIRMATION REQUIRED (queued 'proposed' row + explicit approve click) for: any strategyAuthority change, any policy risk-limit / riskRules / sectorCap change, any scoringWeights change (still behind the 20-closed-lot gate strategy-tuning.ts:191-194), and any edit to the user-editable strategy-prompt box. EXPLICIT-WRITE-ON-APPROVE: prompt changes are written as a delimited AI-LEARNED block via setStrategyPrompt, never silently injected. A risk-limit INCREASE or strategyAuthority='decide' additionally requires a typed second gate (mirroring the from-draft typed BROKERAGE-LIVE confirm). SILENT PASSTHROUGH (no row, no confirm) is allowed ONLY for NON-RISK DATA-FACTS: source-attributed, dated facts written to the shared RAG corpus (scope:'shared'), which reach the brain only as ragContext (strategy.ts:140) treated as DATA not commands, and never touch prompt/policy/weights. The risk-vs-data-fact classifier defaults UNKNOWN -> risk -> queue (fail-closed). Free-text user preferences continue flowing to per-user user_memory unchanged (already a non-risk, non-shared path).
- **Data model:** New table strategy_change_proposals (clone of trade_proposals db.ts:79): id, user_id NOT NULL, created_at, status('proposed'|'approved'|'rejected'|'expired'|'superseded'), source('chat'|'autotuner'|'reflection'), patch JSON (reuse StrategyTuningPatch types.ts:611), prompt_block_id, risk_class('risk'|'non_risk'), rationale, diff_preview, approved_at, applied_at; index (user_id,status,created_at). PER-USER, mirroring every other per-user table (WHERE user_id=?). Q3 isolation: this table and all its reads/writes are per-user; private strategy/prompt/policy is NEVER shared. Q4 shared facts: the ONLY cross-user store stays the Pinecone DATA-FACTS layer; formalize it by adding a first-class scope:'shared'|'private' metadata field in cleanMetadata (vector-db.ts:150) replacing the 'local' magic string, plus user_settings flags rag.contributeShared (write opt-out) and rag.includeShared (read opt-out) consulted in retrieveContextDetailed (vector-db.ts:480) / storeContexts. user_memory (db.ts:307) and chat_turns (db.ts:295) remain 100% per-user (preferences/PII, never shareable). No new SHARED strategy table is created.
- **Honors constraints:** Crossover ALLOWED: chat suggestions and autotuner/reflection both reach the brain, just via the queue. Risk updates CONFIRMED: every risk/limit/authority/weight/prompt change is a 'proposed' row needing an explicit approve click (typed second gate for limit increases or 'decide'). EXPLICITLY WRITTEN: approved prompt changes are inserted as an attributable AI-LEARNED block by setStrategyPrompt — never silently handed to the agent (this replaces the wholesale prompt overwrite in toPatch). SILENT PASSTHROUGH ALLOWED for NON-RISK DATA-FACTS only: shared-corpus ingest needs no row. Q3: the proposal table and all helpers are per-user (WHERE user_id=?). Q4: only DATA-FACTS are shared (Pinecone scope:'shared', with opt-out); private strategy, prompt, policy, and memory are never shared.

### A2 — Explicit AI-authored prompt text (versioned, diff-able strategy appendix) (effort L)
- **Mechanism:** The brain reads ONE artifact per user: the strategy prompt. A2 splits it into userFreeText plus a delimited MANAGED_BLOCK where the AI writes each learned heuristic/fact as a discrete diff-able line tagged kind+date+rule-id+source. Brain consumes it unchanged at strategy.ts:156/820; tuner reads it at strategy-tuning.ts:126. Autonomous-to-prompt: toPatch (strategy-tuning.ts:468) stops emitting a wholesale proposedPrompt and instead emits learnedRules; a new pure fn applyLearnedRules in src/lib/strategy-prompt-block.ts upserts/deletes by rule-id and persists via unchanged setStrategyPrompt (db.ts:665). Chat-to-prompt: new tool propose_strategy_note in chat/tools.ts only inserts a pending_strategy_notes row, never writes the prompt, so tools.ts keeps zero setStrategyPrompt/setPolicy import. Sole write surface stays /api/policy PUT (route.ts:19); new /api/strategy/learned-rules route does parse+merge server-side to avoid the wholesale-replace at dashboard-client.tsx:438.
- **Gating:** kind fact (non-risk data): SILENT PASSTHROUGH allowed but still written explicitly. Lands in the shared local corpus (the permitted non-risk passthrough that does NOT touch the user box) and is mirrored into the MANAGED_BLOCK with no confirm. kind heuristic (selection/sizing, not a hard limit): EXPLICIT-WRITE plus REVIEW; queued in pending_strategy_notes, dashboard shows a before/after block diff, user Accepts to apply. kind risk (maxOrderNotional, maxDailyNotional, riskRules, sectorCaps, strategyAuthority decide): CONFIRMATION REQUIRED; routed through the existing StrategyTuningPatch.policy path so it still passes validatePolicy (route.ts:72-116) and the human Apply button; risk increases need a typed confirm. Risk may also appear as a MANAGED_BLOCK prose line but the numeric limit takes effect only via confirmed setPolicy. Crossover both ways; risk never auto-applies regardless of source; editing/deleting any block line is always allowed.
- **Data model:** Per-user STRATEGY stays private; FACTS shared. The MANAGED_BLOCK lives inside the existing per-user strategyPrompt (db.ts:661-667), already userId-scoped, so no new block storage. NEW table pending_strategy_notes (mirrors chat_turns near db.ts:300): id, user_id NOT NULL DEFAULT local, rule_id, kind fact/heuristic/risk, text, source chat/autotuner, evidence, status pending/applied/rejected, created_at; all ops WHERE user_id=?. Audit reuses audit_events via audit(learned_rule_applied, before/after, userId) (db.ts:670). Q4 shared facts: a kind-fact rule is ALSO written via storeContexts to the shared local tenant (vector-db.ts:249) with metadata scope shared+source; every user already reads local via retrieveContextDetailed dual-query (vector-db.ts:480-499). Opt-out via new user_settings flags facts.shareContribute (write) and facts.includeShared (read, default true, skips the local union at 490-499). Promotion to local is server-only; user-claimed userId local is blocklisted. chat_turns and user_memory stay fully per-user, never shared.
- **Honors constraints:** Crossover both ways: chat facts reach the brain via the shared local corpus that strategy.ts:140 already reads; autotuner heuristics surface for editing. Risk is confirmed and/or explicitly written: risk rules go through StrategyTuningPatch.policy to validatePolicy to the human Apply (typed confirm for increases), never auto-applied, and can also be an explicit attributable block line. Explicit-write-by-AI is core: every heuristic is a diff-able rule-id-tagged line in the user-editable box, editable/deletable as plain text via per-user setStrategyPrompt. Silent passthrough for non-risk is honored: kind fact may flow to the shared corpus without writing the user box. Q3: MANAGED_BLOCK sits in each user's userId-scoped strategyPrompt and pending_strategy_notes is WHERE user_id=?, so no cross-user strategy bleed. Q4: only fact data shares, via the Pinecone shared tier with shareContribute/includeShared opt-outs; private strategy prose never leaves the per-user prompt.

### A3 — Structured silent passthrough layer (learned-context store) (effort L)
- **Mechanism:** A new first-class, per-user learned_context SQLite store sits BETWEEN the chat/manual side and the autonomous brain, consulted read-only at decision time. It is distinct from BOTH the user-editable strategy prompt (db.ts getStrategyPrompt/setStrategyPrompt) AND from user_memory (which stays preferences/PII-only). A riskTier classifier sorts every learned signal into exactly one tier, and the tier picks the write path. A3 contract: non-risk facts pass SILENTLY into learned_context; risk-touching signals require confirmation and/or an explicit AI-written prompt block.

CROSSOVER chat -> autonomous (new producer): chat is hard-isolated today (chat/tools.ts has NO setPolicy/setStrategyPrompt/storeContexts; orchestrator.ts only READS RAG). I add ONE chat-side producer that writes ONLY to learned_context, never to policy. salience.ts already declares pattern/decision MemoryKinds with durability 0.5/0.9 (salience.ts:14-15) but never emits them (verified: only constraint/preference/goal/correction are produced). I make extractCandidates emit pattern/decision learned-FACTS and route them into src/lib/learned-context/store.ts ingestLearned(userId, candidate, origin=chat) instead of memory/store.ts insertMemory. A fact a user surfaces in chat (e.g. ASML is the sole EUV supplier; this name post-earnings drift fades by day 3) becomes a structured, attributable row the engine consults. The classifier forces any RISK-touching candidate (max_position_pct/risk_tolerance/leverage subject, cap tech at 15 pct, I am more aggressive now) OUT of the silent path into a confirmation queue, so chat can never silently move risk/size/weights.

CROSSOVER autonomous -> own learning (second producer): post-mortem.ts and the counterfactual loop compute durable lessons but only write the free-text reflection_summary user-setting (which auto-reaches the bull-agent prompt unreviewed at strategy.ts:823). I add a structured sink: post-mortem emits learned_context rows (origin=autonomous) for non-risk facts/patterns it finds, so autonomous learning becomes queryable rows instead of one opaque blob. Anything it infers about risk/sizing stays advisory or, if promoted, goes through the SAME confirmation gate.

CONSUMPTION (decision-time consult): At strategy.ts:138-151, the exact block that builds ragContext via retrieveContext for the top-3 scan candidates, I add a parallel retrieveLearnedContext(userId, symbols, regime) pulling the user own rows PLUS opted-in shared FACT rows. The merged text is injected into the bull-agent system prompt beside the existing retrievedFinancialContext guidance (strategy.ts:857) under a labeled learnedContext section the prompt already treats as DATA, not commands. Purely advisory: it informs the LLM confidenceScore/thesis but does NOT change scoringWeights, policy limits, or applyDeterministicSizing inputs, so silent passthrough of facts cannot move risk by construction.
- **Gating:** Three tiers, decided ONLY by classifyRiskTier (src/lib/learned-context/classify.ts); the tier IS the gate.

TIER fact = SILENT PASSTHROUGH (no confirm, no prompt write). Conditions: kind in (pattern,decision,fact), subject NOT in RISK_SUBJECTS, value has no size/limit/weight/authority vocabulary, passes PII (reuse salience.ts PII_PATTERNS) and shared-abuse gates. Action: ingestLearned writes the row directly (scope=private; scope=shared only if contributeShared on AND non-personal AND source-attributed). Consumed at strategy.ts:138-151 as advisory learnedContext. ONLY silent path, and it cannot alter risk because it never writes policy/weights/prompt.

TIER risk = CONFIRMATION REQUIRED (never silent, never auto-applied). Triggers when subject in RISK_SUBJECTS (max_position_pct, risk_tolerance, no_leverage/margin, sector cap, stop_loss, take_profit, strategyAuthority, any scoringWeight key) OR value matches a numeric size/limit/percent-allocation phrase. Action: write learned_context_pending + emit a pending_learned_change event; nothing enters learned_context or the prompt until the user approves. On approval it flows through the EXISTING applyStrategyTuning -> PUT /api/policy gate (policy/route.ts, the sole setPolicy/setStrategyPrompt write surface). Satisfies: autonomous-side strategy updates require confirmation.

TIER strategy-directive = EXPLICIT AI PROMPT-WRITE (confirm + visible diff). When the intent is to change HOW the strategy behaves (not just a fact), the AI writes a BOUNDED delimited attributable block into the user prompt (an AI-LEARNED yyyy-mm-dd block APPENDED, not a wholesale replace), shown as a before/after diff in TuningCard (settings.tsx:801), applied only on human click. Satisfies: written EXPLICITLY into the strategy prompt by the AI, not silently handed to it.

Hard invariants: chat-origin candidates reach AT MOST tier fact silently; any chat risk/strategy-directive is downgraded to the pending queue. The brain reads learned_context only via read-only retrieveLearnedContext; there is no write path from the bull-agent into learned_context.
- **Data model:** Shared-vs-per-user split is EXPLICIT, not the local magic string.

1) New table learned_context (schema near user_memory db.ts:307, with the migration/index pattern at db.ts:322-336): id PK, user_id NOT NULL, scope CHECK(scope IN (private,shared)), kind (pattern|decision|fact), subject, symbol, value, source, origin (chat|autonomous|ingest), risk_tier (fact|risk|strategy-directive), confidence, contributor_user_id, asserted_at, superseded_by, expires_at. Indexes (user_id,scope,superseded_by) and (symbol,scope,superseded_by). Private rows read with WHERE user_id=? (same isolation as user_memory). 

2) Q4 shared facts only: a row may be scope=shared ONLY when risk_tier=fact AND kind in (pattern,fact) AND it passed PII/abuse gates. risk and strategy-directive rows are ALWAYS scope=private and non-shareable (CHECK + write guard in ingestLearned) - enforces only data/facts shared, not private strategy.

3) New table learned_context_pending (confirmation queue for risk_tier=risk): id, user_id, candidate JSON, proposed_diff JSON, origin, created_at, status (pending|approved|rejected). Nothing here reaches the brain until approved.

4) Per-user opt-outs reuse user_settings via getUserSetting/setUserSetting (db.ts:474-486), NO new table: learnedContext.contributeShared (default true, opt-out of donating facts) and learnedContext.includeShared (default true, opt-out of reading others facts). The RAG/Pinecone corpus (vector-db.ts) is untouched and stays the SEC/8-K substrate; learned_context is the NEW chat/autonomous-derived fact channel.
- **Honors constraints:** Crossover allowed: chat-origin pattern/decision facts now flow into learned_context (new salience.ts emission + ingestLearned), and autonomous post-mortem facts flow into the same store - real bidirectional crossover that did not exist before, while keeping chat zero-write-to-brain (tools.ts gains no policy tool).

Risk updates confirmed AND/OR explicitly written: any risk_tier=risk signal is parked in learned_context_pending and applied ONLY through the existing applyStrategyTuning -> PUT /api/policy gate (policy/route.ts:19,68); any strategy-directive is written into the prompt as an explicit, diffable AI block on human approval. Neither can be silent.

Silent passthrough OK for non-risk: risk_tier=fact rows are written and consulted with NO confirmation and WITHOUT touching the user-editable strategy box - exactly the okay-if-it-just-passes-it-along option. The fact tier is structurally unable to move risk because it only adds advisory DATA to the prompt, never policy/weights/sizing inputs.

Q3 multi-user isolation: learned_context is user_id-scoped (WHERE user_id=? for private), same pattern as user_memory; private strategy/risk never leaves the owner.

Q4 shared facts (opt-out): only risk_tier=fact, non-personal, source-attributed rows may be scope=shared (CHECK + write guard); reading and contributing are each governed by a per-user opt-out (includeShared/contributeShared). Private strategy and any risk row are non-shareable by schema.

### A4 — Tiered by blast-radius: facts shared, soft prompt block, hard confirm (effort L)
- **Mechanism:** A router classifies each LearnedUpdate fact, soft, or hard. Chat adds a propose_learning ticket tool. Autonomous decomposes the StrategyTuningPatch and the reflection. Fact goes to shared vectors, soft to a prompt block, hard to a confirm-gated row.
- **Gating:** Fact silent with opt-out after a quality gate. Soft auto-applied as an editable prompt block only. Hard never auto: weights, limits, risk rules, authority need confirm plus typed confirm for decide or increases. Unknown defaults to hard.
- **Data model:** Scope shared or private on vectors, local migrated to shared. Soft block in the per-user prompt. New per-user pending updates table. Flags contributeShared and includeShared. Only facts shared.
- **Honors constraints:** Crossover via shared vectors both read and the per-user prompt the loop reads. Risk gated, never auto. Soft written explicitly into the editable prompt. Silent only for facts. Per-user prompt and memory; only facts shared with opt-outs.

## Appendix B — Judge verdicts

### Judge: Safety & auditability: can the user always see/override what the autonomous engine learned, is a learned signal prevented from silently changing risk/sizing, and is every autonomous-affecting change traceable?
- Scores: A3=9, A1=8, A2=6, A4=4
- Ranking: A3 > A1 > A2 > A4 | Winner: A3
- Biggest risk: The classifyRiskTier function is a single security-critical chokepoint: the entire 'cannot silently move risk' guarantee depends on it never mis-tiering a risk-adjacent signal (e.g. 'lean much harder into tech', which has no numeric trigger) as a silent fact. If it under-classifies, a chat- or autonomous-derived signal enters learned_context silently and reaches the bull-agent prompt for the owner (and, if also mis-shared, for all users) with no confirmation and no diff. Mitigation must be conservative RISK_SUBJECTS + intent keywords, hard default-to-pending on ambiguity, a cap that chat-origin rows never exceed tier 'fact' silently, and a regression test asserting learned_context is consumed only as advisory prompt text — never as a numeric input to applyDeterministicSizing/scoringWeights — so even a misclassification cannot move sizing. Secondary: the shared tier still rests on spoofable x-user-id (request-user.ts) until M6 auth, so shared rows must be treated as low-trust DATA under the existing data-not-commands fencing.
- Through the safety/auditability lens the ranking turns on one question: can a learned signal silently change risk/sizing? I verified the four claims the designs hinge on — tools.ts imports no brain-write fn (chat is isolated today), toPatch wholesale-overwrites the prompt and applyStrategyTuning is a coarse one-click batched updatePolicy (dashboard-client.tsx:431), reflection_summary auto-injects unreviewed (strategy.ts:823), and userId comes from a spoofable x-user-id header (shared weakness, not a differentiator). A3 wins because it makes the silent path STRUCTURALLY unable to move risk (facts are advisory prompt DATA only, never numeric sizing/weight inputs) AND converts the opaque autonomous reflection blob into per-row, attributable, supersededable, erasable records — the best traceability and per-signal override of the four, with a test that pins the no-numeric-input invariant. A1 is a very close second and is actually the most conservative on the 'never auto-apply' axis (everything is a confirmed row, both ungated paths closed, prompt edits become an attributable diffable block), but its non-risk facts still flow silently into shared ragContext and its silent path isn't as explicitly fenced from sizing, so A3's by-construction guarantee edges it. A2 is highly legible and trivially overridable (rules live in the editable box) but explicitly leaves reflection auto-reaching the brain — a self-admitted silent autonomous->brain channel — and lets facts-as-prose steer behavior silently. A4 ranks last and is disqualifyingly weak for this lens: its 'soft' tier auto-applies to the run-every-time prompt with no confirmation and no mitigation for misroute, so it is the only design that lets a learned signal reach the autonomous engine with zero human touch outside the fact tier; it is also only a sketch with no isolation test, no fail-closed proof, and no per-field override detail. No tie: clear ordering A3 > A1 > A2 > A4.

### Judge: Learning efficacy — does the design actually let the system get smarter over time across BOTH the chat and autonomous paths, and share useful facts across users, without a bottleneck (confirmation fatigue, prompt bloat, mis-classification starvation) that kills the learning loop?
- Scores: A3=9, A4=7, A2=5, A1=3
- Ranking: A3 > A4 > A2 > A1 | Winner: A3
- Biggest risk: The single classifyRiskTier chokepoint is also the single point of failure for learning efficacy: tuned conservative (as its own safety story demands — default-to-pending on ambiguity, RISK_SUBJECTS + intent keywords), it will over-route legitimately-non-risk behavioral signal into the confirmation queue, quietly recreating the A1 confirmation-fatigue bottleneck it claims to avoid. The fact tier stays fast, but if the classifier is timid the heuristic/strategy-directive learning that actually changes how the engine behaves degrades to click-gated throughput, and the system's apparent 'silent learning' becomes mostly low-stakes facts while the high-value behavioral lessons pile up unapproved.
- Against the learning-efficacy lens specifically, friction is the enemy and silent-but-structured is the win. A3 is the only design that (1) makes the highest-volume signal — non-risk facts — flow with zero clicks via a tier that is structurally unable to move risk (advisory prompt DATA only, verified injection seam at strategy.ts:138-151, never touching scoringWeights/applyDeterministicSizing), (2) lights up a genuinely dormant crossover path (the unused pattern/decision salience kinds) rather than building new channels, and (3) converts the opaque auto-injected reflection_summary blob into queryable, supersedable, per-fact rows so the learned corpus improves in signal density over time instead of bloating — the failure mode that drags A2 down. A4 shares the philosophy and even auto-applies soft heuristics (a velocity edge), but is specified too thinly to trust as an engine. A2 keeps fact-learning but throttles behavioral learning behind clicks and unbounded prompt growth. A1 is the explicit anti-pattern for this lens: it confirms everything, caps learning at click-rate, and even starves an existing working path mid-rollout. Ranking is decisive, not a tie: A3 >> A4 > A2 >> A1.

### Judge: User experience and simplicity: comprehensibility to a non-expert, friction at the moment of learning, and tractability as a multi-user launch build (possibly today).
- Scores: A1=5, A2=8, A3=6, A4=4
- Ranking: A2 > A3 > A1 > A4 | Winner: A2
- Biggest risk: A2's plain-English MANAGED_BLOCK lives inside the same user-editable textarea that already autosaves ~1s after typing (settings.tsx:871, dashboard-client.tsx autosave). The brittle text contract collides with that autosave: if applyLearnedRules merges client-side or races the debounced save, a user mid-edit can silently clobber AI-written lines (or vice versa), and a non-expert hand-editing inside the delimiters can corrupt the parser. The whole UX win ('rules are just editable text') is also the failure mode. It MUST merge server-side via the /api/strategy/learned-rules route with a forgiving never-throw parser, and the prompt needs a visible rule cap/aging or the box bloats every run with no user-facing management -- the one piece of A2 that is genuinely invisible to the user.
- Through the UX/simplicity/tractability lens, A2 wins because its mental model is the one a non-expert already has -- 'the AI wrote some notes in my strategy box; I can read them, and delete any I don't like' -- and it reuses the existing TuningCard apply button and autosaving textarea, so the visible surface barely grows and it is the most plausible to ship for a multi-user launch today. A3 has the most elegant internal contract and best auditability but turns learning into an invisible second store plus more tables, a queue, and opt-out toggles -- more concepts and more build for a marginal user-facing gain. A1 has the most FAMILIAR pattern (a clone of the trade rail) but is the highest-friction and, worse, makes the agent visibly regress at launch by gating today's auto-injected reflection behind clicks, while carrying a full second proposal lifecycle to build. A4 would likely produce an A2/A3-class experience but is specified too thinly to trust as a today build -- the confirm/diff/opt-out UI is hand-waved, hiding its real effort. I did not default to a tie: A2 and A3 are genuinely close on rigor, but A2 is meaningfully simpler to explain and cheaper to ship, so it leads by two points.
