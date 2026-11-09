# 2026-07-10 — Capability-aware trading roadmap (margin/shorting/options/PDT)

**Summary:** durable roadmap doc (docs/capability-trading-roadmap.md) capturing the verified
regulatory facts (the $25k PDT rule changed — FINRA Notice 26-10, effective 2026-06-04), the
current-state survey of shorting (~92% built), options (0% placement — data only), margin
(unmodeled), and PDT (built-but-unwired), the owner's 4 scope decisions (2026-07-10), and the
phased build plan. Product of two read-only scoping workflows + context from two in-flight build
workflows (Tradier broker, order-status-reconcile).

**Why:** owner requested enabling options + shorting + margin/leverage + day-trading-rule awareness;
these are coupled (shorting needs margin; options need approval level; PDT bites margin day-trading)
so decisions were made once across the cluster. Also verifies the owner's "$25k rule changed" claim
against primary sources (it did) and records the honest broker-phase-in caveat.

**Files:** docs/capability-trading-roadmap.md (new), STATUS.md, docs/EFFORT-LOG.md, this note.

**Verification:** docs-only; land.sh gate before PR.

**Follow-ups:** foundation PRs (Tradier #1380, order-status-reconcile) merge owner-timed (merge=deploy
to live); then Phase 0 BrokerMargin read, then the phased feature builds. NOT started — sequenced to
avoid a money-path merge pileup on the production trading app.
