# 2026-07-15 — ST-audit execution wave 2 (MONET, owner-directed continuation)

## Summary

Second execution wave of `docs/handoffs/2026-07-15-claude-to-monet-st-audit.md` (§8
medium-effort + autonomy-observability items), implemented by a 7-agent team (+3 adversarial
reviewers +2 fix agents) on branch `monet/st-audit-exec-wave2`, one batched PR.

1. **§4.1 — retrieval-usefulness join (the keystone self-measurement gap).** New
   `src/lib/retrieval-usefulness.ts` + `db-retrieval-usefulness.ts` + migration **v45**
   (`retrieval_usefulness_stats` keyed user/docType/memoryKind/docId/horizon, plus a
   per-decision `retrieval_usefulness_credited` exactly-once ledger — the anti-join IS the
   watermark, so passes are incremental/bounded and re-runs cannot double-credit). Scheduled
   on the existing maintenance cadence; credits each attributed vector id/doc-type/memory
   kind with matured multi-horizon outcomes (hit-rate + mean return). Retrieval ordering in
   `experience-memory.ts` now applies a **bounded, rank-stable, advisory** usefulness weight
   (neutral stats = byte-identical order; env off-switch; fail-open when stats absent).
   Takes over the dormant `w3-retrieval-usefulness` board sub-lane (annotated on both boards).
2. **§6b.4 — LLM provider cooldown.** New `src/lib/llm-provider-cooldown.ts`: per-credential-
   lane cooldowns (provider + keySource, user-scoped for personal keys) persisted via
   `durable-state.ts` (PR #1634 — survives auto-deploy restarts; no new table). Tiered
   env-overridable TTLs (transient 429 ≈ 5 min; billing/insufficient_quota ≈ 60 min —
   classified on the RAW provider body, since the humanized string would misclassify). Green
   (bull chain, `strategy.ts`) and Red (`red-team.ts`) failover planning skips cooling lanes
   (each skip audited with remaining TTL); when ALL lanes cool it attempts the full chain
   least-recently-failed-first — never strictly worse than pre-change behavior — and emits ONE
   throttled `llm_provider_cooldown_exhausted` audit + `provider_degraded` notification per
   window. Red Team fail-closed semantics unchanged (chains filtered/reordered, never emptied).
   Kill switch `LLM_PROVIDER_COOLDOWN_DISABLED=1` restores exact prior behavior. Also fixes
   served-by-fallback attribution to compare against the configured primary rather than index 0.
3. **§6b.7 — trading-liveness health dimension.** New `src/lib/trading-liveness.ts` +
   migration **v44** (strategy_runs liveness index): per active-autonomy account, age of last
   COMPLETED strategy run + consecutive-failed streak. Surfaced as a *degraded indicator*
   (never 503 — a 503 would restart the container and re-halt autonomy, the loop wave 1
   fixed): PUBLIC `/api/health` carries only an anonymous aggregate (counts/oldest age — no
   ids/labels after review); full per-account detail lives in the authed ops snapshot.
   Market-session-aware: a stale run while the market is closed does NOT flag degraded
   (scheduler deliberately skips closed-market runs).
4. **§6b.2 — scheduler dead-man's-switch: VERIFIED, enable steps documented (no config flip).**
   Code path confirmed working at `scheduler.ts:213-245` (fully try/catch-wrapped check-ins).
   To enable: add `SENTRY_DSN=<project DSN>` and `SENTRY_CRONS_ENABLED=1` to the Infisical
   project/environment `socratic-trade-prod` boots from, then redeploy. **Caveat:** setting
   `SENTRY_DSN` enables the full Sentry SDK (error capture + 0.1 perf tracing + PII
   redaction), not just Crons.
5. **§3.3 — QuiverQuant producer (dormant).** New `src/lib/quiver-provider.ts` fills the five
   until-now producer-less carrier fields (`congressTradesQuiver`, `insiderTradesQuiver`,
   `govContractsQuiver`, `lobbyingQuiver`, `patentsQuiver`); gated solely on `QUIVER_API_KEY`
   (absent = never registered = zero calls); ≥24h per-symbol cache + negative TTLs, fail-open,
   seated last/supplemental (only contributes fields no other provider produces; wave-1 AV
   gate untouched). Field-shape parsing grounded against live QuiverQuant MCP responses
   (schema-tolerant to casing). **Owner action to activate: set `QUIVER_API_KEY` in Infisical.**
   The false "Quiver Quant API Integration" completed-work claim in STATUS.md /
   docs/EFFORT-LOG.md corrected in place (it was false when written; a dormant producer now
   exists as of this wave).
6. **§3.5 — forward economic-event awareness.** New `src/lib/economic-calendar.ts` +
   `db-economic-events.ts` + migration **v43** (`economic_events`): daily (UTC-watermarked,
   quota-friendly, fail-open) ingest of FMP `/economic-calendar` US high-impact events via the
   existing quota-reserved FMP lane (`fmp-gamma` — its first production consumer). Compact
   `upcomingEconomicEvents` block (≤6 events) injected next to the regime label; omitted
   entirely when no data; same-day already-printed events are not presented as upcoming.
7. **§3.6 — raw headlines reach the model.** New `src/lib/prompt-headlines.ts`: up to a
   bounded, deduped set of raw headline titles per candidate enters the prompt; numeric
   `newsSent` demoted to tie-breaker in the prompt framing. NOTE: the upstream pipeline
   stores bare titles (`string[]`) — per-headline source/age needs a structured-headlines
   refactor (filed as follow-up; the handoff's "source+age" is not fully satisfiable today).
8. **§1a — a11y toggles.** `Toggle` `label` prop wired at the unlabeled call sites in
   `app/console/settings/page.tsx`; per-event notification toggles use the human-readable
   `NOTIFICATION_EVENT_TYPE_LABELS` map (the new wave-1 `autonomy_halted_on_boot` type
   appears automatically — the UI iterates the type list generically). NOTE: the handoff's
   branch pointer `ag/codex-autofix-1476` was WRONG (that branch contains unrelated
   learning-loop work); fixes were re-derived by intent, and the un-locatable "layout fix"
   hunk is a follow-up pending the correct source.
9. **§1b — `delegation-standard-docs`:** the "Delegation & model economics" AGENTS.md section
   landed verbatim in this wave (applied directly from the branch diff); the branch itself is
   now RETIRE/deletable.
10. **§7.2 — REFUTED, no change.** The claimed FMP request double-emission does not exist in
    current code: both FMP call sites pass `durableAttempt`, and `fetchWithRetry` gates
    `recordProviderCall` on `!durableAttempt` (since PR #1586) — FMP emits exactly one
    request-count lane. The handoff finding was stale.

## §4.2/§1b branch dispositions (read-only audit — decisions recorded, ports NOT in this PR)

- **`claude/w2-coaching-durable` → PARTIAL (rebase cost M).** The gap is real and GROWING
  (main still silently truncates coach notes at `db-socratic.ts:311`, and a SECOND
  uncovered truncation site appeared post-fork at `:334`; the OWNER COACHING retrieval block
  still waits for the `coach-note` producer). But a mechanical rebase is disqualified: its
  `widenOriginCheck` table-rebuild predates the account-scoped schema (data-loss hazard) and
  half the branch is already on main. Port plan: cherry-pick `4ca13f3d` as starting material,
  rewrite the schema change as a fresh versioned migration preserving all current columns +
  write-fence triggers, port `archiveCoachNotes`/vector writer, drop the redundant commit.
- **`claude/w2-reflection-decompose` → PARTIAL (rebase cost L).** `doc_type="lesson"` is
  retrieved every run and never written (real live cost), and `retrieveLearnedContext`'s
  regime arg sits documented as waiting for exactly this. But it writes into the decision
  prompt path and its persistence predates account-scoped learning (wrong account stamp =
  cross-account lesson leakage — the exact bug class the per-account keying killed). Port
  plan: reuse the pure bucketing/decomposition logic + the 283-line test as spec; reimplement
  persistence against the current account-scoped schema with a fresh migration.
- **`claude/delegation-standard-docs` → RETIRE** (content landed in this wave; branch is a
  pure duplicate now).
- No retrieval-scaffolding strip is needed (both producers arrive via the PARTIAL ports; the
  audit recorded the exact strip recipe if either port is ever abandoned).

## Post-review catches (after the 3-lens pass)

- **Account-deletion coverage:** the full-suite gate caught the new `retrieval_usefulness_*`
  tables missing from `DELETE_TABLES_BY_USER_ID` (`test/account-deletion-coverage.test.ts`) —
  added; the account boundary is the one hard rule and this sweep is its enforcement.
- **Cross-branch migration-version race:** while this wave was in flight, main merged #1661
  whose migration also took v42 and auto-deployed. Resolved at merge time by renumbering this
  wave's migrations to v43/v44/v45 (main's deployed v42 keeps its number — otherwise prod,
  already at schema 42, would have silently skipped creating `economic_events`).

## Branch-provenance addendum (owner question: "whose Settings/Mandates rework was lost?")

Answered by blob-level forensics (every file hashed against main's full history):
- The Settings + Guardrails revision the owner saw in progress is **CLAUDE's PR #1651**
  ("Settings uses con-card like every other page + Guardrails collapsible sections") — it
  **merged 2026-07-15 20:45Z and is live in production**. Nothing from it was lost.
- `agent/antigravity-fmp-macro` (the only branch with a large unmerged Settings/Guardrails
  diff) is **not lost work**: all 13 changed files are byte-identical to historical main
  versions from 2026-07-02→05 — the branch is AG's stale local worktree (frozen ~07-05/06)
  accidentally wholesale-committed on 07-12 under a one-line commit message; repo-wide it
  silently reverts 374 files. Its "new" `settings/models.tsx` is a resurrection of a file the
  #1340 IA restructure deleted. **Nothing to salvage; superseded by #1340/#1651/#1631; the
  branch should be deleted, not mined.**
- `cursor/session-2026-07-05` and `monet/gemini-red-rec-restore`: parallel work that lost
  landing races to main by minutes (#849 / #1082+#1084); byte-identical or trivially-different
  to what landed. Nothing to salvage.

## Why

Owner-directed continuation of the handoff execution ("continue all work"). Same method as
wave 1: refute-first verification per item (one finding refuted and correctly NOT
implemented), file-group ownership across parallel agents, db-migration agents chained to
prevent version races, 3-lens adversarial review before land. The review caught 5 must-fixes
pre-land — the three parallel migrations racing one test pin (42/43/44 vs expected 43),
per-account liveness detail exposed on the public health route, this rollout note missing
while cited, plus market-hours-blind liveness noise, global (non-user-scoped) cooldown lanes
for personal keys, same-day-past calendar events presented as upcoming, RRF-order-destroying
usefulness re-sort, missing .env.example entries, and raw-enum aria-labels — all fixed
before land.

## Files

New: `src/lib/retrieval-usefulness.ts`, `src/lib/db-retrieval-usefulness.ts`,
`src/lib/llm-provider-cooldown.ts`, `src/lib/trading-liveness.ts`,
`src/lib/economic-calendar.ts`, `src/lib/db-economic-events.ts`,
`src/lib/prompt-headlines.ts`, `src/lib/quiver-provider.ts`, plus test files
(`retrieval-usefulness`, `llm-provider-cooldown`, `trading-liveness`, `economic-calendar`,
`economic-calendar-prompt-wiring`, `strategy-headlines-prompt`, `quiver-provider`).
Modified: `src/lib/db.ts` (migrations v43/v44/v45 — renumbered at merge time: main's #1661 `bracket_sibling_leg_teardown` took v42 and was already applied in production, so shipping the original numbers would have made prod silently skip creating `economic_events`), `src/lib/experience-memory.ts`,
`src/lib/scheduler.ts` (maintenance hook), `src/lib/strategy.ts` (bull-chain cooldown +
prompt blocks — prompt/LLM-chain regions only), `src/lib/red-team.ts`,
`src/lib/strategy-prompts.ts`, `src/lib/ops-snapshot.ts`, `app/api/health/route.ts`,
`app/console/settings/page.tsx`, `src/lib/data-providers.ts` (Quiver registration),
`AGENTS.md` (delegation section), `.env.example`, `STATUS.md`, `docs/EFFORT-LOG.md`,
`test/persistence-hardening.test.ts` (v44 pin), `test/strategy-prompt-safety.test.ts`.

## Verification

Full gate on the final merged tree (wave commits `b5043ade` + `9864a4d6` account-deletion fix
+ merge `d219189e` of `origin/main` @ `4877689b`, absorbing everything merged since the fork —
#1656 AV cap, #1660 OpenRouter, #1661 brackets, #1662, #1665 SEC/RAG backfill P2; conflicts
resolved by hand in `db.ts` (migration renumbering),
`account-deletion.ts` (both sides kept), `persistence-hardening.test.ts` (pin → 45)), under
node@24 (v24.18.0):

```
npm run lint       # 0 errors (506 grandfathered warnings)
npx tsc --noEmit   # clean
npm test           # 400 files, 4596 tests — all passed
npm run build      # clean
```

An earlier full-suite run also caught `account-deletion-coverage` failing (new user-scoped
tables missing from the deletion sweep) — fixed in `9864a4d6` before this gate. Per-item
targeted suites were run by each implementing/fix agent (llm-provider-cooldown 8/8,
trading-liveness + siblings 46, economic-calendar 7/7 + wiring 2/2, retrieval-usefulness 8/8,
quiver-provider 15/15, headlines 13, persistence-hardening 20/20).

## Follow-ups / owner decisions surfaced

- **Owner activations:** `QUIVER_API_KEY` (Quiver producer), `SENTRY_DSN` +
  `SENTRY_CRONS_ENABLED=1` (dead-man's-switch; full-SDK caveat above) — both Infisical +
  next deploy. Standing from wave 1: `autoResumeOnBoot`, `FMP_PRICE_TARGETS_ENABLED`.
- **Wave-3 candidates:** the two PARTIAL ports above (coaching-durable M, reflection-decompose
  L); structured headlines (source+age); per-doc usefulness multipliers once samples justify;
  ops-snapshot usefulness summary seam; medium-impact/non-US calendar as a policy setting.
- Locate the true source of the a11y "layout fix" hunk (handoff's branch pointer was wrong).
- Branch cleanup: `claude/delegation-standard-docs` deletable; keep the two PARTIAL-port
  branches until their ports land.
