# 2026-08-31 - Qdrant eval + RAG optimization + error/UX audit (owner-directed)

## Context & Objective

Owner-directed: evaluate the new self-hosted Qdrant (post box-doubling) as the Pinecone
replacement and make sure it is optimally set up; find ways to make RAG feed the LLM
proposers more data more efficiently; identify current errors both alerted and silent;
identify app/iOS parity and UI/UX improvements.  Ten-agent audit (7 investigation lanes +
2 adversarial verifiers + completeness critic); every P0/P1 was re-verified against the
live box, live APIs, or code.  Full report (owner):
https://claude.ai/code/artifact/4577e78f-88d8-45c2-a346-40dc43263213 — machine-readable
findings in the session scratchpad (`audit-result.json`).  Board: `601d581c` plus new rows
`8620cad8 9e19673a a9676caf d2ac60c9 ab03d8c9`.

## Changes Made (all infra/monitoring — NO app code changed)

- **Qdrant `socratic-trade` collection: 14 payload indexes created** (now 16 total).
  keyword: symbol, userId, scope, tenant_scope, doc_type, section, source,
  connected_account_id, ledger_authority, provider_authority, ingest_state, memory_scope;
  bool: receipt_required; integer: as_of_epoch_ms.  These are exactly the filter fields
  production queries use (inventoried from `src/lib/vector-db.ts`); previously only `ns` +
  `embed_model` were indexed, so every filtered query would have full-scanned at cutover.
- **qdrant-st Coolify compose (PATCHed via API, base64 `docker_compose_raw`; never
  hand-edit on-disk):** `mem_limit 6g -> 10g` (box is 30 GiB now; quantized working set +
  page cache headroom), added `QDRANT__STORAGE__SNAPSHOTS_PATH=/qdrant/storage/snapshots`
  (snapshots previously landed in the container's EPHEMERAL layer and died with it).
  Service restarted; verified mem_limit=10737418240, env present, healthz green, 801,239
  points intact, collection green.
- **UptimeRobot: the three runbook-mandated keyword monitors created** (ids
  `803872370/803872371/803872372`) per `docs/runbooks/uptime-health-json-monitors.md`:
  `"schedulerStale":true`, `"tradingLivenessDegraded":true`,
  `"litestreamTiersDegraded":true` on `/api/health`, 5-min interval.  The liveness and
  litestream monitors fired immediately — correctly (see findings).  Caveat: the
  UptimeRobot MCP cannot set "treat 4xx/5xx as up", so a deploy 503 will co-fire these;
  one-click per-monitor toggle in the dashboard if noise bothers.
- Touched files (this PR): `docs/rollouts/2026-08-31-qdrant-rag-error-ux-audit.md`,
  `docs/EFFORT-LOG.md`, `STATUS.md`.

## Key findings (full detail in the artifact report)

1. **Pinecone read units are EXHAUSTED month-to-date and the trial has lapsed** —
   strategy decisions silently run without RAG analogs (24x swallowed 429s/48h logs),
   vector reconciliation dead, no alert.  Cutover is now the unblocking move (board
   `9e19673a`).
2. **Qdrant itself is healthy and correctly deployed** (mesh-only, keyed, capped, green,
   int8 quantized ~940MiB resident, v1.19.0 = current latest).  Remaining pre-cutover:
   sentinel backfill for the four `$exists:false` filter clauses during the delta copy
   (`scope:"__absent__"`, `receipt_required:false`, `as_of_epoch_ms:0`), snapshot->off-box
   cron (USE THE EXISTING R2 ACCOUNT — a B2 bucket would mean minting credentials, owner
   only), a mesh-side watchdog (image has no curl/wget/bash; Coolify shows
   running:unknown), and search-time params in the future adapter (`hnsw_ef:128`,
   rescore+oversampling 2.0, payload field whitelist).
3. **RAG's choke is the last mile, not recall**: rerank scores 150 candidates and returns
   `limit` (8 deep / 1 scout) (`vector-db.ts:7799->7351`), then ALL symbols share a 24k-char
   filings prompt budget (`strategy.ts:5322`) — ~95% of ranked evidence discarded.
   Post-cutover feast: budget 24k->80-120k with per-symbol sub-quota, deep limit 8->16-24,
   scout 1->3, flip `RAG_MULTIQUERY` on, mirror transcripts into FTS
   (`corpus-wide-lexical.ts:322` hard-limits to sec-edgar/sec-8k), `HYDRATE_WALL_MS`
   150->500ms, embed-cache TTL 24h.  Silent-drop bug: a transient SQLite fault drops the
   ENTIRE managed corpus from a pass (`vector-db.ts:6631` catch) with no degraded flag.
   Cutover mechanics: Pinecone confined to `vector-db.ts` (real seam, no interface);
   `occ:v3:` ids are invalid Qdrant point ids -> UUIDv5 re-map with original in payload; WU
   breakers/budgets neutralized behind the port.  **Blocker: no frozen golden-case corpus
   is committed** — the harness (`scripts/eval/rag-production-eval.ts`) is ready but has
   nothing to run (board `d2ac60c9`).
4. **Silent errors**: runbook keyword monitors were never created — trading halted 10.4
   days (141 consecutive failed runs) + litestream degraded with ZERO pages (fixed
   tonight).  NEW run-failure modes beyond the gather P0: Aug 27 alpaca.getOrders timeout;
   Aug 28 RTH restart loop (~15 min, journalctl-verified) that destroys its own forensics
   (board `a9676caf`).  Litestream wedge detector provably blind
   (`runtime-health.ts:1428` nullish fallback suppresses L2 failures; counter reads 0) and
   new dominant root cause = B2 GetObject 403 on the same L1 file (commented `1e3df744`).
   CT share lane dead-auth 914x HTTP 401/48h, console.error only (board `8620cad8`).
   Tradier capability-probe 400s silently skip a close_only account; Robinhood
   getTransactions parse failures console-only; soft `[expected-limit]` classification
   never escalates persistent 401s.
5. **Alerted**: correlated multi-app 522/503 blips Aug 24-28 (shared-box contention,
   quiet since the box upgrade); Sentry embed-integrity burst was Aug 18-22 only
   (dormant); SOCRATIC-TRADE-28 (alpaca-account-insights) still firing (board
   `ab03d8c9`); Datadog unqueryable by agents until one interactive OAuth; iOS has zero
   crash observability.
6. **Parity/UX**: Kalshi has ZERO iOS surface post-#3122 (policy fixture already carries
   the flags); Decisions/Lessons/Macro have no iOS surface (AdminPortalView's
   WKWebView-fence pattern closes them cheaply); web: System theme choice doesn't survive
   reload, title=-only tooltips invisible on touch/AT, Results lacks the mobile card
   fallback (7 sideways tables); iOS: EquityChartView bypasses Lato (7 `.caption` sites),
   GuardrailsView reads as a data dump, dead dark-mode branches linger.

## Decisions & Trade-offs

- Applied only additive/reversible infra changes to a store serving zero production
  traffic (Pinecone still serves); no app code touched — code fixes belong to their
  claimed lanes (gather P0 is claimed by another CLAUDE session; RAG doc-type P1 is
  CURSOR's).
- Monitors were created knowing two would fire immediately — that is the point (the app
  was degraded with no pages).
- Owner question answered en route: the box is cx53 (320 GB plan disk) but
  `primary_disk_size` is 160 GB — the resize was done "without disk", so 160 GB already
  paid for is unclaimed.  Recommendation: same-type rescale WITH disk in an off-hours
  window (power-off, minutes, irreversible, no availability constraint); volume optional
  and not required.

## Verification State

- Qdrant after changes: healthz green; collection green; 801,239 points; 16 payload
  indexes in `payload_schema`; mem_limit 10 GiB; snapshots env present (verified via SSH
  + live API).
- Monitors: created via UptimeRobot API, 5-min interval, keyword-exists.
- No app build required (docs-only PR); `scripts/land.sh` runs the standard gate anyway.

## Next Steps & Blockers

1. Gather time-budget P0 first (claimed) — nothing downstream is visible while runs die.
2. Author the frozen golden set + Pinecone baseline (`d2ac60c9`), then the
   `VectorIndexPort` adapter + shadow-read + delta copy w/ sentinel backfill + cutover
   (`9e19673a`).
3. Litestream: level-scoped recovery fix + B2 403 investigation (`1e3df744`).
4. Qdrant snapshot->R2 cron + mesh watchdog (follow-ups from the 08-28 rollout, still open).
5. Post-cutover RAG quick wins (budget/depth/multiquery/transcript-FTS).
6. Kalshi iOS surface + WebView-fence Decisions/Lessons/Macro; UX polish passes.

## Zero-Code Findings

This PR is docs-only; the infra changes above were applied live and verified.  The full
64-finding inventory with evidence and verdicts lives in the artifact report and the
session `audit-result.json`.

## Replaced Docs

None.
