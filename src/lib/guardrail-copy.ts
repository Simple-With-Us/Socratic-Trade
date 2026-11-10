/**
 * Canonical guardrail-semantics and account-environment copy.
 *
 * Import these strings anywhere user-facing copy describes how guardrails behave
 * or how paper vs brokerage accounts are labeled.  iOS mirrors the same sentences
 * in `DeskCopy` (`ios/SocraticTrade/DeskModels.swift`) — keep them in sync.
 *
 * Engine truth: preference gates are advisory tag-not-drop unless you turn
 * overrides off; broker, integrity, and accounting impossibilities still block.
 */

/** Appended to many Guardrails field hints — one sentence, same everywhere. */
export const ADVISORY_NOTE =
  "Advisory: the agent decides and logs everything — adjust or override this at any time.";

/** Guardrails page subtitle after the account label. */
export const GUARDRAILS_HEADER_SUFFIX = "authority, caps, and adjustable preferences";

/** Crisis regime meaning — below-median buys are tagged, not dropped. */
export const REGIME_BELOW_MEDIAN_CRISIS =
  "VIX above 30 — panic-level volatility.  Buy ideas scoring below the scan median are tagged as advisory pre-vetoes (they stay in the run for override with a thesis unless you turn overrides off), and the optional crisis exposure cap can shrink every newly opened position.";

/** Risk-off regime meaning — same advisory semantics as crisis. */
export const REGIME_BELOW_MEDIAN_RISK_OFF =
  "VIX above 20 (or above 17 with an inverted yield curve) — stressed markets.  Buy ideas scoring below the scan median are tagged as advisory pre-vetoes (they stay in the run for override with a thesis unless you turn overrides off), and a flip into this regime can trigger an immediate strategy run.";

/** Macro regime card — how entries are gated. */
export const REGIME_GATES_ENTRIES =
  "In Risk-Off or Crisis, buys scoring below the scan median are tagged as advisory pre-vetoes (not dropped outright), and an optional cap limits how large any new position may open in Crisis/Inverted regimes.";

/** Chrome kill-switch / breaker error note. */
export const BREAKER_FIRED_NOTE =
  "A breaker fired on this account.  What tripped it, and its current response, is on Guardrails.";

/** Settings glossary — Guardrails entry. */
export const GUARDRAILS_GLOSSARY_DEFINITION =
  "The per-account caps the policy gate applies: per-order and daily notional, symbol/sector exposure, order counts, drift, and the rest.  Editable on Guardrails; typed confirmation for loosening is optional (Settings → Advanced action confirmation).";

/** FLEET-UI-COPY: paper accounts read `Alpaca (paper)` — no ceremony. */
export const ALPACA_PAPER_LABEL = "Alpaca (paper)";
export const ALPACA_BROKERAGE_LABEL = "Alpaca";
export const TRADIER_SANDBOX_LABEL = "Tradier (paper)";
export const TRADIER_PRODUCTION_LABEL = "Tradier";

export const PAPER_ACCOUNT_GLOSSARY_TERM = "Alpaca (paper)";
export const PAPER_ACCOUNT_GLOSSARY_ALIASES = "paper trading practice account";
export const PAPER_ACCOUNT_GLOSSARY_DEFINITION =
  "Paper account — the broker's practice endpoints; orders route the same way, dollars are the broker's practice balance.";
export const BROKERAGE_ACCOUNT_GLOSSARY_DEFINITION =
  "A connected brokerage account.  The app treats every account the same way; paper is distinguished only by the broker's environment label.";

export const ALPACA_CONNECTED_TOAST_PAPER = `Connected as ${ALPACA_PAPER_LABEL}.`;
export const ALPACA_CONNECTED_TOAST_BROKERAGE = "Connected as a brokerage account.";

/** Reality banner / chip word for broker-paper mode (lowercase per FLEET-UI-COPY). */
export const REALITY_PAPER_WORD = "PAPER TRADING" as const;

/** Public /framework invariant — sizing default + optional Socratic override. */
export const FRAMEWORK_SIZING_INVARIANT =
  "Sizing is deterministic and code-side by default; a logged Socratic override may request a larger deployment, bounded by your override cap and the policy gate.";

/** Public /framework invariant — dissent is down-only except logged overrides. */
export const FRAMEWORK_VERDICT_INVARIANT =
  "Verdicts and calibration are down-only by default: dissent and learning can shrink risk, not enlarge it — except where you enable and log a Socratic override on an opening.";

/** Public /how-it-works — authority bullets that match shipped controls. */
export const HOW_IT_WORKS_AUTHORITY_ITEMS = [
  "Authority mode: Ask-First (every trade waits for your approval) or Autopilot (the strategy may place orders inside your guardrails).",
  "System state: Running, Exit-only, Winding down, or Stopped — each account's scheduler obeys the state you set.",
  "Caps: max per order, max daily spend, max concurrent positions, symbol/sector concentration, and order-count limits.",
  "Protective preferences: daily loss stop, max drawdown, consecutive-loss breaker, and volatility panic brake — advisory by default, with optional hard enforcement per account.",
  "Socratic override: an optional mode where the agent may argue past a preference gate with a logged thesis; bounded by your override cap and never bypassing broker or integrity blocks.",
  "Notifications: configurable channels for fills, breaker trips, and material events."
] as const;

/** iOS proposal typed-confirm sheet — no Live ceremony. */
export const PROPOSAL_CONFIRM_ORDER_TITLE = "Confirm Order";
export const PROPOSAL_APPROVE_ORDER_BUTTON = "Approve Order";
export const PROPOSAL_TYPED_CONFIRM_HINT = "Typed confirmation required for this order";
