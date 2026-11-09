# Financial Expert Panel — Strategy & Architecture Review

**Date:** 2026-06-21 (restored 2026-06-21 after the original was wiped from `main` by a PR merge)
**Method:** Multi-agent panel — 3 ground-truth readers built a code-cited evidence pack, then 8
independent expert agents analyzed the live codebase in their domain, a moderator clustered
contested theses, and adjudicators resolved debates. The automated synthesis/verify phases were
cut by a spend limit; the synthesis, scorecard, roadmap, and verification addendum below were
authored by the convening agent (Claude) from the completed panel output, with a hand
verification pass against real code.

> **Status update (2026-06-21):** Several P0 items below are now IMPLEMENTED on `agent/claude`
> (commits `bddaa35`, `4ea77a8`, `71698a5`) — see `docs/rollouts/2026-06-21-deferred-tasks-p0-backtest.md`.
> Those are marked ✅ in the roadmap.

## 1. Executive summary
Unusually well-engineered for a personal project, but two blunt, unanimous conclusions: (1) **no
demonstrated, cost-aware, out-of-sample edge** — hand-set factor weights never validated against
returns, a learning loop trained on frictionless zero-cost fills, no backtest; (2) a small number
of defects were **disqualifying for real money** — chiefly non-atomic order placement (a crash
orphaned an untracked real position), no account-level drawdown kill-switch, a quantity-less-exit
that could silently no-op a stop, and fail-open LLM critique layers. The per-trade risk gate and
the deterministic-sizing-overrides-the-LLM design are genuinely strong.

## 2. Headline verdicts
- **Edge:** No demonstrated durable edge; expect SPY-minus-costs as-built. Falsification test: a
  cost-and-tax-adjusted walk-forward equity curve that beats SPY out-of-sample. (The IC backtest
  harness — commit `4ea77a8` — is the first plumbing toward this.)
- **Live-readiness:** Not live-ready until two gates clear — (A) atomic, crash-recoverable order
  placement [✅ done], and (B) edge measurability (cost model in P&L + a backtest [backtest ✅;
  cost model pending]).

## 3. Scorecard
| Dimension | Grade | Verdict |
|---|:---:|---|
| Strategy / Edge | D | Disciplined plumbing, unproven alpha: hand-set weights, cost-blind, collinear factors, stale signals, no backtest. |
| Risk Controls | C+ | Excellent side-aware per-trade gates + auto-revert; gross/net exposure IS enforced (default 100% too loose). Now adds a drawdown kill-switch + buying-power gate (✅). |
| Execution Realism | D | Zero slippage/spread/impact modeling; synthetic "stops" book phantom fills; fabricated bid/ask; market-order-only in practice. |
| Learning Loop | C− | Disciplined (shrinkage, 20-lot gate, PIT counterfactuals) but no out-of-sample validation, circular confidence calibration, statistically inert at personal volume. |
| Architecture / Reliability | B− | Clean, fail-safe defaulting, idempotent reconcile, encrypted secrets, busy_timeout set. Was: non-atomic order boundary (✅ fixed), stub health (✅ fixed), single-process SPOF, Litestream not operational. |
| LLM Reliability | B− | Schema-strict, temp-0, deterministic sizing override, redacted telemetry. Was: quantity-less-exit hole (✅), fail-open critiques (✅), no LLM timeout (✅). |
| Compliance / Ops | C | Cross-account wash-sale (§1091) is production-grade. Gaps: no PDT/Reg-T, "not advice" only on the tax tab, scraping ToS/SEC-UA, orphaned-order audit gap (✅ partly). |

## 4. Prioritized roadmap (status as of 2026-06-21)
**P0 — before real money:**
1. ✅ Atomic, crash-recoverable order placement (intent row + sweep). [`bddaa35`]
2. ✅ Account-level drawdown / daily-loss kill-switch. [`bddaa35`]
3. ⬜ Cost model in P&L + sizing (spread/impact at fill) — the biggest edge lever; high fixture churn.
4. ✅ Fix the quantity-less exit hole. [`bddaa35`]
5. ✅ Fail-closed critiques + LLM timeouts. [`bddaa35`]
6. ◑ Buying-power gate ✅ [`71698a5`]; PDT/Reg-T gate ⬜ (needs AccountCapabilities daytrade plumbing).
7. ⬜ Tighten gross/net exposure defaults (enforcement exists; default change).

**P1 — make the edge real:**
1. ◑ Backtest/IC harness ✅ [`4ea77a8`]; re-derive weights from IC, cost+tax-adjusted OOS curve vs SPY ⬜.
2. ⬜ Real macro feed or explicit "Unknown" regime (kill the fabricated 2023 static fallback).
3. ⬜ Orthogonalize factors (collapse collinear momentum/technical/52w).
4. ⬜ Gate congress/insider rank-lift behind measured signalEfficacy; window on disclosedAt.
5. ⬜ Sample-aware learning (n≥~20 before a bucket drives sizing); fix circular confidence calibration.
6. ⬜ Make one critique stage genuinely independent (different model / deterministic veto).
7. ⬜ Turnover/tax discipline in the objective.

**P2 — architecture hardening:**
1. ✅ Real /api/health probe + scheduler heartbeat. [`bddaa35`]
2. ⬜ Watchdog + decouple protective exits from systemState==='active'.
3. ⬜ Operationalize Litestream (tested restore).
4. ✅ SSE server-side tenant filter. [`bddaa35`]
5. ⬜ Native Alpaca brackets; book synthetic-stop exits at real fill price, session-gated.
6. ⬜ Robinhood pending-fill reconciler on the scheduler tick.
7. ⬜ Versioned schema migration ledger; split the 2330-line db.ts.
8. ⬜ Run-lock the approval path (cap double-spend TOCTOU).

**P3 — polish:** deterministic not-advice stamping; real SEC EDGAR UA; `deterministicTemperature`
rename + seed; prompt-caching implement-or-delete; remove dead `stopLossAtrMultiple`; map
fallback/manual proposals to real playbook buckets.

## 5. The panel — verdicts & key findings
- **Dr. Elena Vasquez (Quant PM):** "A competently-engineered narrative-generation machine with no
  demonstrated edge." Findings: no backtest (critical), learning loop frictionless (critical),
  congress/insider too lagged & thin (high), momentum saturates & double-counts technical (high),
  static-macro regime lock (high), factor attribution dominated by liquidity (med), LLM debate
  rationalizes the deterministic rank (med).
- **Marcus Bellweather (CRO):** "Solid side-aware per-trade gates, but NO portfolio circuit
  breaker." Findings: gross/net exposure declared-not-enforced (REFUTED on verification — it IS
  enforced; default 100% too loose), no buying-power check (critical→✅), no drawdown kill-switch
  (critical→✅), crisis cap off-by-default + string-keyed (high), stop exits require the run-loop
  (high), stop fill-price fidelity (med), daily-count bypass on direct fills (med).
- **Priya Nair (Execution):** "Real fills will systematically lag the model." Findings:
  zero-slippage paper fills (critical), fabricated bid/ask fed to the LLM (high), no bracket/OCO on
  live orders (critical), synthetic stop books phantom fills off-session (high), notional+limit
  conflict degrades to market-only (high).
- **Jim Castellano (Skeptic):** "No identified, cost-aware, out-of-sample edge anywhere." Findings:
  zero cost model (critical), Bull/Bear/RedTeam is one model arguing with itself (high), congress
  windowed by trade-date not disclosure-date (high), turnover churn in a taxable cost-blind system
  (high), silent static macro (med).
- **Dr. Sofia Lindqvist (Learning loop):** "A carefully-built in-sample noise-fitter." Findings:
  zero OOS validation / data-snooping (critical), sample sizes 1-2 orders below the scorecard
  claims (high), circular confidence calibration (high), zero-evidence theses sized ~28% (high),
  recency/regime overfit (med), RAG asOf-guard dormant in the live path (med).
- **Daniel Okonkwo (Architect):** "Clean, but one disqualifying flaw: a non-atomic, non-recoverable
  order boundary." Findings: order placement not atomic (critical→✅), refId not persisted defeats
  idempotency (critical→✅ partial), no busy_timeout (REFUTED — it IS set), single-process SPOF
  (high), health endpoint stub (high→✅), Litestream not operational (high), SSE cross-tenant leak
  (med→✅), approval path skips run-lock (med), migration drift (med), db.ts monolith (low).
- **Aisha Rahman (LLM infra):** "Disciplined, but a quantity-less SELL bypasses sizing, both
  critique layers fail open, no LLM timeout." Findings: quantity-less-sell phantom fill (high→✅),
  both critique layers fail-open (high→✅), no LLM timeout / run-lock starvation (med→✅),
  determinism claim overstated (low), prompt-caching aspirational (low).
- **Robert Tanaka (Compliance):** "Wash-sale is real & well-built, but an orphaned-order hole on
  outages, no PDT/Reg-T, thin 'not advice' framing." Findings: orphaned order on outage
  (critical→✅), no PDT/Reg-T/buying-power (high→◑), not-advice framing thin (high), caps on
  intended not realized (med), scraping ToS / placeholder SEC UA (med).

## 6. Debate transcript (2 of 5 completed before the spend limit)
- **"The cost-blind learning loop is actively dangerous, not merely inert."** Resolution: fix
  before live (not inert), but the scary "test fills size up real capital" leak doesn't literally
  exist (source-segregated paper vs live) — yet broker/paper→live pooling and ~28%-at-zero-lots
  survive. Action: sample floor + slippage haircut + close the paper→live pooling.
- **"Live-readiness is gated SOLELY on order-placement durability."** Resolution: right on the
  defect, wrong on "solely." Durability sequences first (you can't measure edge through a boundary
  that orphans the fill record), but cost-aware P&L + a backtest is an equal, non-deferrable gate.

## 7. Verification addendum (hand check)
Confirmed real: order-placement non-atomicity, no drawdown kill-switch, no cost model,
quantity-less-exit, health stub, static-macro lock. **Refuted (false positives):** gross/net
exposure "never enforced" (it IS, `policy.ts`), and "no busy_timeout" (it IS set, `db.ts`). These
corrections show why the raw findings are inputs, not verdicts.

## 8. Cross-cutting consensus
Independent experts converged on the same few defects: non-atomic placement (Architect ×2 +
Compliance), cost-blindness (Quant PM + Execution + Skeptic + Researcher), no OOS validation, and
"exits are second-class." The reassuring signal: the deterministic risk gate, the wash-sale §1091
work, and the fail-safe defaulting are genuinely strong. The work is concentrated, not pervasive.

*Not investment advice. Engineering and strategy opinions only.*
