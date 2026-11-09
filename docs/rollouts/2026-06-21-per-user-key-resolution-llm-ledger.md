# 2026-06-21 - per-user-key-resolution-llm-ledger

## Summary

Made API-key resolution multi-user-aware so env keys belong to the **primary (`local`) user**, not
a silent global fallback for every tenant — with **no special `local` operator branch** — and added
an **operator-funded LLM failover** with **per-user usage tracking**. A per-service tier
(`src/lib/db-api-keys.ts`) gates the env fallback:

- **per-user-only** — **no env fallback for anyone** (not even `local`). At server boot, the
  operator's env values for these are **migrated into the `local` user's per-user store**
  (`migrateLocalEnvCredentials` + `migrateLocalRobinhoodToken`, called from `instrumentation.ts`),
  so every user — `local` included — resolves them from their own stored keys / OAuth. A user with
  no stored key **fails closed**. Reserved for isolation/cost-critical credentials: **broker keys**
  (`alpaca_paper_api_key`, `alpaca_paper_secret_key`) and **LLM keys** (`openai`, `anthropic`). Also
  the **default** for any unlisted service (fail-closed).
- **shared-operator-infra** — env stays a **global** fallback for all users, because the resource is
  operator-funded and non-personal: **all market data** (finnhub, fmp, alphavantage, marketstack,
  tradier, massive REST+S3, fintechstudios — public quotes/bars cached in a shared tier; a user's
  own key still overrides and joins the consent pool), plus FRED macro, Pinecone/Voyage (shared SEC
  RAG corpus), Apify (congress scraper), and the SEC EDGAR UA string.

Why no `local` special-case (owner decision): `local` is the primary user, not a privileged
operator. Communal **data** is already handled by the consent pool (share → contribute + read;
refuse → private + excluded), so env market-data keys serve everyone. The only credentials that
can't be communal are **broker tokens** (they trade under one account) — those are strictly
per-user, and the owner's env values are migrated into their own account so nothing breaks.

**LLM keys** additionally use `resolveLlmCredential(provider, userId)`: a user's own key wins;
otherwise the operator's env key serves **any** user (no `local` carve-out) as a **flag-gated
failover** (`LLM_OPERATOR_FALLBACK`, default `on`) so the app keeps working for users who haven't
added their own key. Because that spends the operator's budget, **every LLM call is recorded** in a
new `llm_usage` ledger (`src/lib/llm-usage.ts`) tagged with `keySource` (`user` | `operator`),
best-effort token counts, and an estimated cost — surfaced at `GET /api/admin/llm-usage`
(admin-gated), which isolates the spend where a tenant used the operator key. Set
`LLM_OPERATOR_FALLBACK=off` to make everyone (incl. `local`, via their migrated key) require their
own key.

### Adversarial-review fixes (folded in)

A multi-agent review of the diff confirmed and this rollout fixes: the **semantic gate**
(`learned-context`) called the LLM with no `userId` → tenant learned-context classification silently
spent the operator key, unattributed; now `ingestLearned` → `classifyWithSemanticGate` →
`getLLM(userId)` threads the user (usage attributed). The **chat orchestrator** resolved its default
LLM with no `userId`; it now resolves per-turn via `getLLM(userId)`. Added an end-to-end test that an
LLM `run()` writes a ledger row with the constructed `userId`/`keySource`.

Also closed direct-`process.env` credential bypasses that skipped the per-user resolver:

- `src/lib/alpaca.ts` — the broker constructor read `process.env.ALPACA_PAPER_API_KEY/_SECRET_KEY`
  directly (any user could borrow the operator's Alpaca account). Now routes through
  `resolveApiKey` (per-user-only tier) → a non-`local` user with no key gets `""` and broker
  construction fails loudly instead of trading on the operator's account. (Same class as the
  per-user Robinhood-token fix, PR #54.)
- `src/lib/mcp-oauth.ts` — `getMcpAccessToken` returned the `ROBINHOOD_MCP_AUTH_TOKEN` override to
  ANY user; now serves it to `local` only.
- `src/lib/market-signals/massive-s3.ts` — dropped the S3-secret → REST-key fallback (SigV4 needs
  the dedicated secret; missing → fail cleanly, don't borrow another key).
- `src/lib/web-sources/congress.ts` — dropped the redundant `|| process.env.APIFY_API_TOKEN`
  (Apify is shared-tier, so the resolver already returns the env token); threaded an optional
  `userId` for forward-compat.
- Alpaca stream workers (`src/lib/streams/alpaca-*-stream.ts`) — pass `"local"` explicitly to make
  the operator-only intent visible (per-user fill streaming is a deferred refactor).

## Why

The owner directed the app to behave multi-user with the `local` operator existing, and to stop
defaulting to `.env.local` for API keys **unless** a key benefits from staying in env. The justified
"keep in env" set is the **operator-funded shared infrastructure** (market data, RAG, macro,
scraper) — public, non-personal resources where per-user keys add onboarding friction for no
isolation benefit. The isolation/cost-critical credentials (broker + LLM) become per-user-only.

For the LLM specifically the owner chose: per-user primary, with the operator key as a failover
**contingent on per-user usage/cost tracking** (removable later) — implemented as the `llm_usage`
ledger + the `LLM_OPERATOR_FALLBACK` flag.

Design note (corrected mid-implementation): market-data keys were initially classified per-user-only
but that broke the existing shared-history-cache design (`test/history.test.ts` "shares env-keyed
history cache entries across users"). Market data is operator-funded public infra → shared tier.
Only broker + LLM are per-user-only.

## Files

- `src/lib/db-api-keys.ts` — `CredTier`, `API_KEY_TIER`, `credTierForService`, tier-aware `resolveApiKeyWithSource` (per-user-only has NO env branch), `resolveLlmCredential` + `llmOperatorFallbackEnabled`, `LlmKeySource`, `LOCAL_USER`, `migrateLocalEnvCredentials`.
- `src/lib/mcp-oauth.ts` — `getMcpAccessToken` no longer reads the env override; `migrateLocalRobinhoodToken` seeds it into local's stored token at boot.
- `instrumentation.ts` — boot hook runs `migrateLocalEnvCredentials()` + `migrateLocalRobinhoodToken()`.
- `src/lib/learned-context/semantic-gate.ts` + `store.ts` — thread `userId` into the gate's `getLLM` (review fix).
- `src/lib/chat/orchestrator.ts` — per-turn `getLLM(userId)` instead of a userId-less default (review fix).
- `src/lib/llm-usage.ts` — NEW. `recordLlmUsage`, `extractLlmUsage`, `estimateLlmCostUsd`, `getLlmUsageSummary`.
- `src/lib/db.ts` — `llm_usage` table + indexes.
- `app/api/admin/llm-usage/route.ts` — NEW. Admin-gated per-user usage/cost summary.
- LLM sites routed to `resolveLlmCredential` + usage recording: `src/lib/strategy.ts`, `red-team.ts`, `post-mortem.ts`, `strategy-tuning.ts`, `proposal-revalidation.ts`, `chat/llm.ts` (AnthropicLLM/OpenAILLM `usage` param + per-user `getLLM(userId)`), `app/api/chat/route.ts` (per-user orchestrator, dropped the operator-pinning singleton).
- Bypass fixes: `src/lib/alpaca.ts`, `mcp-oauth.ts`, `market-signals/massive-s3.ts`, `web-sources/congress.ts`, `streams/alpaca-news-stream.ts`, `streams/alpaca-trade-updates-stream.ts`.
- Tests: `test/key-resolution-tiering.test.ts` (NEW, 10), updated `test/mcp-oauth.test.ts` + `test/robinhood-mcp.test.ts` to the override-is-local-only semantics.
- `.env.example` — documented `LLM_OPERATOR_FALLBACK` + the tiering model.

## Verification

In the isolated worktree `~/apps/trading-keys` (branch `feat/per-user-key-resolution`, base `origin/main`):

- `npx tsc --noEmit` — clean (exit 0).
- `npm test` (vitest) — **763 passed** across 84 files (+11 new tiering/ledger tests; updated the
  Robinhood-override + Alpaca-enrichment tests to the migrate-then-per-user model).
- `npm run build` — clean (exit 0).
- Adversarial review workflow over the diff (isolation / LLM-wiring / money-path / completeness):
  9 confirmed findings (deduped to 2 real defects + test-coverage gaps), all fixed (see above).

## Follow-ups

- **Per-user Alpaca fill/news streams** are still operator-`local`-only (background workers have no
  per-request user; they read `local`'s migrated key) — a deferred refactor; documented inline.
- **Alpaca enrichment for no-userId background scans**: the Alpaca key is per-user-only (trade-safe),
  so a scan with no userId no longer seats the Alpaca real-time provider (degrades to delayed/public
  providers). In practice scans pass a userId; `local` works via its migrated key.
- **Migration is boot-time + idempotent**; a deployment that pins `ROBINHOOD_MCP_AUTH_TOKEN` as a
  rotating token would need re-seeding (the env override is migrated once into `local`'s store).
- **`semantic-gate.ts`** calls `getLLM()` with no userId → resolves the `local` operator key (it's a
  background gate; acceptable, but note for full multi-user).
- **Notification keys** (Pushover/Resend/Twilio in `notify.ts`) and observability (Langfuse/Sentry)
  read env directly — operator-level by design (single-account); per-user notification *targets*
  already live in `notification_prefs`. No change.
- **Cost table** in `llm-usage.ts` is a best-effort static price map; unknown models record null cost.

## Blockers

- None.
