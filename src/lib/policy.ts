import type {
  AccountCapabilities,
  ApprovedEscalation,
  EquityPosition,
  GateEscalation,
  GateEscalationKind,
  MarketScan,
  PolicyDecision,
  Portfolio,
  TaxationType,
  TradeProposal,
  TradingPolicy,
  IraWashSaleHandling,
  WashSaleGateAudit,
  WashSaleHandling
} from "./types";
import { normalizeSymbol } from "./money";
import { dynamicIndexUniversesForPolicy, symbolsForPolicyUniverse } from "./index-universes";
import { getUserWashSaleLockProvenance, type WashSaleLockMap } from "./tax";
import { DEFAULT_TAX_SETTINGS } from "./defaults";
import { getDb } from "./db";
import { isCrisisOrInvertedMarketRegime, regimeFromLabel } from "./market-regime";

export interface PolicyContext {
  policy: TradingPolicy;
  portfolio: Portfolio;
  positions: EquityPosition[];
  dailyNotionalUsed: number;
  /** Order notional already executed within the trailing 60 minutes (R1 hourly cap). */
  hourlyNotionalUsed?: number;
  /** Opening orders already placed today. Risk-reducing exits must not consume this cap. */
  dailyOrderCount: number;
  estimatedNotional?: number;
  marketScan?: MarketScan;
  /** Symbols closed at a loss within the last 30 days; buying them now would create a wash sale. */
  washSaleLockedSymbols?: Set<string>;
  /**
   * Preferred richer form of washSaleLockedSymbols: the cross-account lock PROVENANCE map
   * (tax.ts WashSaleLockMap — binding account, clear date, and summed disallowed lossUsd).
   * The "ask"/"auto" wash-sale handling modes need lossUsd to price the forfeited deduction;
   * when only the legacy Set is supplied the gate still enforces the lockout but treats the
   * cost as unknown (which fails the "auto" guard — fail-safe).
   */
  washSaleLocks?: WashSaleLockMap;
  /**
   * User identifier. Required for the wash-sale gate to resolve the cross-account locked set
   * when neither washSaleLocks nor washSaleLockedSymbols is pre-populated by the caller.
   */
  userId?: string;
  /**
   * APPROVAL-PATH ONLY. Escalation override handles derived by the server from a STORED
   * escalated proposal row (strategy.ts approvedEscalationsFromDecision) — the tokens were
   * minted server-side when the run loop escalated the card, persisted in the trade_proposals
   * decision JSON, and are read back from that row here. No API accepts these from a client,
   * so this can never act as a client-settable bypass flag. The wash-sale gate honors a
   * matching handle ONLY when taxSettings.washSaleHandling is "ask"/"auto" and the buyer is
   * not an IRA; every other gate ignores it and re-runs at full strength.
   */
  approvedEscalations?: ApprovedEscalation[];
  /**
   * The BUYING ConnectedAccount's taxationType (db row, as configured in Settings → Tax
   * treatment). This is the SOURCE OF TRUTH for the account's tax regime — it wins over
   * policy.taxSettings.taxationType (see dashboard.ts's tax-summary overlay) and must be
   * threaded here because legacy/manually-configured IRA accounts may have capabilities absent
   * (or reporting "brokerage") AND a policy taxSettings without taxationType; without this the
   * IRA-replacement hard block (Rev. Rul. 2008-5) could mis-treat the buyer as taxable.
   */
  accountTaxationType?: TaxationType;
  /** Capabilities of the connected account executing the order. When absent, all capabilities are treated as false (safe default). */
  accountCapabilities?: AccountCapabilities;
  /**
   * True only for real-capital brokerage (LIVE) execution. Test/local simulation and broker-Paper
   * accounts are NOT live and can never violate the Pattern-Day-Trader rule, so the PDT gate below
   * is skipped unless this is explicitly true. Absent/false ⇒ never PDT-gated (safe default).
   */
  isLiveExecution?: boolean;
  /**
   * Day-trades already executed on this account over the rolling 5-business-day PDT window
   * (FINRA Rule 4210). Computed by db.countDayTradesInLastBusinessDays and threaded in like the
   * other precomputed counts (dailyOrderCount/dailyNotionalUsed). Absent ⇒ treated as 0.
   */
  priorDayTradeCount?: number;
  now?: Date;
}

/**
 * Minimum equity a LIVE MARGIN account must hold before this app will submit opening margin trades.
 * FINRA Notice 26-10 replaces the old PDT count/$25k framework with intraday margin standards
 * effective 2026-06-04, but member firms may phase in implementation through 2027-10-20. This app
 * enforces the static margin minimum and defers broker-specific intraday margin restrictions to the
 * broker.
 */
export const MARGIN_MINIMUM_EQUITY = 2_000;
export const OPENING_ORDER_HEADROOM_PCT = 5;

/**
 * RECEIPT-ONLY LABEL (no longer a gate threshold — owner decision 2026-07-03). Historically "auto"
 * wash-sale handling required the expected edge to clear this multiple of the priced tax cost
 * before proceeding; the owner rejected that as pseudo-math (the "expected edge" side of the
 * comparison was itself derived from the LLM's own confidenceScore/bracketTakeProfit outputs, so
 * the gate was re-arithmetizing the model's judgment rather than adding an independent check).
 * "auto" now always proceeds; this constant is retained only to label
 * decision.washSale.edgeMultiple on the receipt so historical records stay self-describing.
 */
export const WASH_SALE_AUTO_EDGE_MULTIPLE = 3;

/**
 * Tolerance for honoring a stored ask/auto wash-sale override token at approval time: the freshly
 * recomputed tax cost may exceed the cost PRICED ON THE APPROVED CARD by at most
 * max($1, 1% of the approved cost). Within that band the difference is rounding/noise; beyond it
 * the user approved a materially different (cheaper) trade-off — e.g. another taxable loss posted
 * between escalation and approval — so the stale token is refused and the card re-escalates at
 * the current price for a fresh decision. A DECREASED cost always honors (strictly better than
 * what the user accepted).
 */
export const WASH_SALE_OVERRIDE_COST_TOLERANCE_MIN_USD = 1;

/**
 * Verbatim owner-approved annotation attached (decision.washSale.note) to every IRA rebuy that
 * proceeds under taxSettings.iraWashSaleHandling = "disregard". Rendered wherever the purchase
 * shows (approvals card, activity) and carried in the wash_sale_ira_disregarded audit event —
 * a disregarded wash sale is never invisible.
 */
export const IRA_WASH_SALE_DISREGARD_NOTE = "Wash Sale (Technically, but IRA purchase unreported to IRS)";
export const WASH_SALE_OVERRIDE_COST_TOLERANCE_PCT = 1;

export function washSaleOverrideCostTolerance(approvedCostUsd: number): number {
  return Math.max(WASH_SALE_OVERRIDE_COST_TOLERANCE_MIN_USD, approvedCostUsd * (WASH_SALE_OVERRIDE_COST_TOLERANCE_PCT / 100));
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * IRA-buyer determination with the source-of-truth PRECEDENCE used by the wash-sale gate (see the
 * buyerIsIra comment in evaluateTradeProposal): the ConnectedAccount row's taxationType DECIDES
 * when present; only when the row is silent do the weaker signals (policy taxSettings, broker
 * capabilities) speak, as a conservative union. Exported so the strategy prompt builder classifies
 * IRA accounts IDENTICALLY to the gate — the two must not drift, or the model could be told to
 * avoid a rebuy the gate would actually permit (or vice versa).
 */
export function isIraTaxRegime(
  accountTaxationType: TaxationType | undefined,
  policyTaxationType: TaxationType | undefined,
  capabilityAccountType: string | undefined
): boolean {
  const isIraType = (regime: TaxationType | undefined): boolean =>
    regime === "roth_ira" || regime === "traditional_ira";
  return accountTaxationType != null
    ? isIraType(accountTaxationType)
    : isIraType(policyTaxationType) ||
      capabilityAccountType === "roth_ira" ||
      capabilityAccountType === "traditional_ira";
}

/**
 * RECEIPT TELEMETRY, not a gate (owner decision 2026-07-03 — see WASH_SALE_AUTO_EDGE_MULTIPLE).
 * Computes the "expected edge" (dollars) for a wash-sale-locked BUY under "auto" handling, purely
 * to record it on decision.washSale for transparency; it no longer decides whether the buy
 * proceeds ("auto" always proceeds).
 *
 * Signal choice (documented per the original owner spec — "pick the most defensible signal"):
 *
 *   expectedEdge$ = estimatedNotional × (takeProfit% / 100) × (confidenceScore / 100)
 *
 * i.e. the trade's own planned profit target in dollars, discounted by the model's stated
 * conviction. These are the two per-proposal signals the platform already trusts with money:
 * confidenceScore drives the deterministic sizer's conviction multiplier, and
 * riskRules.takeProfitPct is the planned exit that the proactive trim engine executes. A
 * proposal-level bracketTakeProfit (with a known referencePrice) takes precedence over the
 * policy-level percentage because it is the more specific target for THIS trade.
 *
 * Degradation: a missing/invalid conviction, target, or notional yields $0 — an honest "could not
 * price the upside" receipt value, not a failure of anything.
 */
export function washSaleExpectedEdgeUsd(
  proposal: TradeProposal,
  policy: TradingPolicy,
  estimatedNotional: number
): number {
  if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) return 0;
  const rawConfidence = proposal.confidenceScore;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? Math.max(0, Math.min(100, rawConfidence))
      : 0;
  let targetPct = policy.riskRules?.takeProfitPct ?? 0;
  if (
    proposal.bracketTakeProfit != null &&
    proposal.referencePrice != null &&
    proposal.referencePrice > 0 &&
    proposal.bracketTakeProfit > proposal.referencePrice
  ) {
    targetPct = ((proposal.bracketTakeProfit - proposal.referencePrice) / proposal.referencePrice) * 100;
  }
  if (!Number.isFinite(targetPct) || targetPct <= 0) return 0;
  return round2(estimatedNotional * (targetPct / 100) * (confidence / 100));
}

/** Partial lock info — full provenance when a WashSaleLockMap is available, bare when only the legacy Set is. */
interface ResolvedWashSaleLock {
  account?: string;
  clearDate?: Date;
  lossUsd?: number;
}

/**
 * Resolve the wash-sale lock (if any) binding this symbol. Preference order: the provenance map
 * (rich), the legacy Set (bare), then — authoritative fallback so the gate cannot be silently
 * bypassed by a caller that omits the locked set — a direct cross-account provenance read.
 */
function resolveWashSaleLock(context: PolicyContext, symbol: string): ResolvedWashSaleLock | undefined {
  if (context.washSaleLocks) return context.washSaleLocks.get(symbol);
  if (context.washSaleLockedSymbols) return context.washSaleLockedSymbols.has(symbol) ? {} : undefined;
  if (context.userId != null) {
    return getUserWashSaleLockProvenance(context.userId, context.now ?? new Date()).get(symbol);
  }
  return undefined;
}

function describeWashSaleLock(lock: ResolvedWashSaleLock): string {
  const clearsOn = lock.clearDate ? lock.clearDate.toISOString().slice(0, 10) : undefined;
  if (lock.account && clearsOn) return `loss in ${lock.account}, clears ${clearsOn}`;
  if (lock.account) return `loss in ${lock.account}`;
  return "a position was closed at a loss within the last 30 days";
}

export function applyOpeningOrderHeadroom(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value <= 0) return 0;
  return Math.floor(value * (100 - OPENING_ORDER_HEADROOM_PCT)) / 100;
}

/**
 * Owner guardrail philosophy (2026-07-05): the ONLY hard rules are the account boundary and the
 * physical / broker / regulatory / accounting IMPOSSIBILITIES below — orders that literally cannot be
 * placed, or that the broker or IRS would reject regardless of the agent's intent. EVERYTHING else the
 * policy engine blocks is a RISK PREFERENCE the agent may self-override with a logged `autonomyOverride`
 * thesis (see resolveSocraticOverride). This is the single source of truth for that hard/preference
 * split, co-located with the gates that produce the reasons: a reason matching a hard pattern is never
 * overridable; every OTHER block is overridable by DEFAULT, so a new preference gate added later is
 * overridable automatically instead of accidentally hard (the old allowlist had the opposite,
 * fail-restrictive default).
 *
 * Stays HARD (a "can't-do-it" fact, not a guardrail restraining the agent):
 *  - account boundary — no account selected;
 *  - accounting truths — can't sell/cover more than held/short; malformed order missing qty;
 *  - broker rejections — insufficient buying power, symbol not tradable, "broker" errors,
 *    account can't short, fractional/dollar orders outside regular hours;
 *  - regulatory — the live margin-account minimum (FINRA Notice 26-10, the PDT successor);
 *  - IRA wash-sale permanent-harm lockout — it has its OWN owner control
 *    (taxSettings.iraWashSaleHandling), so it is governed there, not double-overridden ad hoc.
 *
 * Deliberately NOT hard (agent-overridable preferences): every exposure / notional / count / ADV /
 * beta / sector cap, the crisis cap, universe & order-type limits, extended-hours, entry-drift /
 * staleness, stop / take-profit rules, short-stop-required, policy-level "short-selling disabled",
 * and systemState (halted / close-only / liquidating).
 */
export const HARD_GATE_REASON_PATTERNS: readonly string[] = [
  "No Robinhood account is selected.", // account boundary — the one absolute rule
  "not tradable", // broker: symbol not tradable
  "buying power", // broker/accounting: can't spend more than available
  "Sell quantity exceeds", // accounting: can't sell more than held
  "Cover quantity exceeds", // accounting: can't cover more than short
  "exit must specify", // malformed order
  "margin_minimum:", // regulatory: live margin minimum (FINRA 26-10 / PDT successor)
  "does not support short selling", // broker capability (NOT the policy toggle "short-selling is disabled in policy")
  "Fractional or dollar-based orders must be regular-hours only.", // broker execution constraint
  "broker", // any broker-originated rejection
  "wash-sale", // IRA wash-sale — governed by taxSettings.iraWashSaleHandling (its own override)
  "wash sale",
  "PERMANENTLY" // IRA wash-sale permanent-harm lockout
];

/**
 * True when a policy block is a HARD, non-overridable gate (account boundary + physical / broker /
 * regulatory / accounting impossibility). Everything else is an overridable risk preference. Used by
 * the Socratic self-override path (socratic-runtime.resolveSocraticOverride) to decide which blocks an
 * `autonomyOverride` thesis may pass. Substring, case-insensitive — the reason strings are produced
 * right here in evaluateTradeProposal.
 */
export function isHardGateReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  // Pre-veto tags (`deterministic_bear_veto:` / `red_team_veto:` from the pre-policy-veto-advisory
  // flow in strategy.ts) are ADVISORY preferences BY CONSTRUCTION, regardless of the free-text reason
  // after the prefix. A Red Team veto's reason is unconstrained LLM natural language and can
  // coincidentally contain a hard-gate substring ("broker", "buying power", "PERMANENTLY", "wash
  // sale"); classifying by the prefix here stops the substring scan from misclassifying a pre-veto
  // tag as hard and silently refusing a valid override. These prefixes are ONLY produced by that
  // tagging, so this can never mask a real hard gate.
  if (lower.startsWith("deterministic_bear_veto:") || lower.startsWith("red_team_veto:")) return false;
  return HARD_GATE_REASON_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

export function evaluateTradeProposal(proposal: TradeProposal, context: PolicyContext): PolicyDecision {
  const reasons: string[] = [];
  // Escalatable failures (closed allowlist — see GateEscalationKind). Only the reasons pushed
  // through pushEscalatable can ever be routed to a pending-approval card by the strategy loop;
  // every reason pushed directly onto `reasons` stays a hard block.
  const escalations: GateEscalation[] = [];
  let washSaleAudit: WashSaleGateAudit | undefined;
  const symbol = normalizeSymbol(proposal.symbol);
  const pushEscalatable = (kind: GateEscalationKind, reason: string, washSale?: GateEscalation["washSale"]) => {
    reasons.push(reason);
    escalations.push({ kind, reason, symbol, ...(washSale ? { washSale } : {}) });
  };
  const estimatedNotional = context.estimatedNotional ?? estimateNotional(proposal);

  if (context.policy.systemState === "halted" && proposal.side !== "sell" && proposal.side !== "cover") {
    reasons.push("System is halted.");
  }
  if (context.policy.systemState === "liquidating" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is liquidating. Only close orders allowed.");
  if (context.policy.systemState === "close_only" && proposal.side !== "sell" && proposal.side !== "cover") reasons.push("System is close-only. New entries are disabled.");
  if (!context.policy.accountNumber) reasons.push("No Robinhood account is selected.");
  // Universe/blocklist applies to OPENING trades only. Never block a risk-reducing exit
  // (sell/cover) because the symbol was removed from the universe or blocklisted — that
  // would trap a position in a name you flagged precisely to get out of.
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  if (isOpening) {
    const allowedSymbols = allowedSymbolsForPolicy(context.policy);
    const hasDynamicUniverse = dynamicIndexUniversesForPolicy(context.policy).length > 0;
    if (allowedSymbols.length === 0 && !hasDynamicUniverse) reasons.push("Allowed universe is required.");
    if (!allowedSymbols.includes(symbol) && !isDynamicScanSymbol(symbol, context)) reasons.push(`${symbol} is not in the allowed universe.`);
  }
  if (proposal.side !== "sell" && proposal.side !== "cover" && !context.policy.permittedOrderTypes.includes(proposal.type)) {
    reasons.push(`${proposal.type} orders are not permitted.`);
  }
  // Bracket orders: allow when "bracket" is in permittedOrderTypes OR when stop-loss rules are
  // configured (treating stop-loss rules as an implicit green-light for bracket risk management).
  // Permissive default — brackets should be encouraged when stop rules are active.
  if (proposal.bracketTakeProfit != null || proposal.bracketStopLoss != null) {
    const bracketPermitted =
      context.policy.permittedOrderTypes.includes("bracket" as any) ||
      (context.policy.riskRules?.stopLossPct != null && context.policy.riskRules.stopLossPct > 0);
    if (!bracketPermitted) {
      reasons.push('Bracket orders require "bracket" in permittedOrderTypes or a stopLossPct risk rule.');
    }
  }
  if (proposal.side !== "sell" && proposal.side !== "cover" && !context.policy.permitExtendedHours && proposal.marketHours !== "regular_hours") {
    reasons.push("Extended-hours orders are disabled.");
  }
  if ((proposal.dollarAmount || hasFractionalQuantity(proposal)) && proposal.marketHours !== "regular_hours") {
    reasons.push("Fractional or dollar-based orders must be regular-hours only.");
  }
  const robinhoodFractionalLimitEntry =
    proposal.type === "limit" && hasFractionalQuantity(proposal) && context.policy.activeBroker === "robinhood";

  // Entry-drift guard: reject a stale OPENING market/dollar order whose price has moved
  // away from the proposed entry anchor (referencePrice) by more than maxEntryDriftPct. Whole-share
  // limit orders are excluded because the broker's limit caps the fill. Robinhood fractional limits
  // are included because that adapter routes fractional entries as market orders; otherwise a stale
  // fractional limit could pass policy and then execute uncapped after broker normalization.
  if (
    isOpening &&
    context.policy.maxEntryDriftPct != null &&
    context.policy.maxEntryDriftPct > 0 &&
    proposal.referencePrice != null &&
    proposal.referencePrice > 0 &&
    (proposal.type === "market" || proposal.dollarAmount != null || robinhoodFractionalLimitEntry || proposal.limitPrice == null)
  ) {
    const currentPrice = context.marketScan?.quotesBySymbol[symbol]?.price;
    if (currentPrice != null && currentPrice > 0) {
      const driftPct = (Math.abs(currentPrice - proposal.referencePrice) / proposal.referencePrice) * 100;
      if (driftPct > context.policy.maxEntryDriftPct) {
        reasons.push(
          `entry_drift: ${symbol} moved ${driftPct.toFixed(1)}% from the proposed entry $${proposal.referencePrice.toFixed(2)} ` +
            `(now $${currentPrice.toFixed(2)}), exceeding the ${context.policy.maxEntryDriftPct}% max entry drift.`
        );
      }
    }
  }
  // STALENESS GATE: block an OPENING proposal built on stale market data (fail-safe, DEFAULT OFF).
  // Enabled per-class only when the threshold is set (> 0). Fail-safe direction only: data older than
  // the threshold → block; a MISSING timestamp is treated as stale (block) ONLY because the gate is on.
  // Exits (sell/cover) are never gated. Timestamps are read from the run's MarketScan — never fabricated.
  if (isOpening) {
    const now = (context.now ?? new Date()).getTime();
    const maxQuoteAgeSec = context.policy.maxQuoteAgeSec;
    if (maxQuoteAgeSec != null && maxQuoteAgeSec > 0) {
      const quoteAsOf =
        context.marketScan?.quotesBySymbol[symbol]?.asOf ??
        context.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol)?.asOf;
      const asOfMs = quoteAsOf ? new Date(quoteAsOf).getTime() : NaN;
      // Staleness failures are TIME-CONTEXT gates: they are escalatable (Decide mode) because a
      // later human approval re-runs this gate against a FRESH scan, so the condition self-heals.
      if (!quoteAsOf || Number.isNaN(asOfMs)) {
        pushEscalatable(
          "quote_staleness",
          `staleness_gate: ${symbol} quote timestamp is missing/unparseable; treating as stale ` +
            `(maxQuoteAgeSec=${maxQuoteAgeSec}).`
        );
      } else {
        const ageSec = Math.round((now - asOfMs) / 1000);
        if (ageSec > maxQuoteAgeSec) {
          pushEscalatable("quote_staleness", `staleness_gate: ${symbol} quote is ${ageSec}s old (max ${maxQuoteAgeSec}s).`);
        }
      }
    }
    const maxFundamentalsAgeSec = context.policy.maxFundamentalsAgeSec;
    if (maxFundamentalsAgeSec != null && maxFundamentalsAgeSec > 0) {
      const scanGeneratedAt = context.marketScan?.generatedAt;
      const genMs = scanGeneratedAt ? new Date(scanGeneratedAt).getTime() : NaN;
      if (!scanGeneratedAt || Number.isNaN(genMs)) {
        pushEscalatable(
          "quote_staleness",
          `staleness_gate: market-scan timestamp is missing/unparseable; treating fundamentals as stale ` +
            `(maxFundamentalsAgeSec=${maxFundamentalsAgeSec}).`
        );
      } else {
        const ageSec = Math.round((now - genMs) / 1000);
        if (ageSec > maxFundamentalsAgeSec) {
          pushEscalatable("quote_staleness", `staleness_gate: market scan is ${ageSec}s old (max ${maxFundamentalsAgeSec}s).`);
        }
      }
    }
  }
  // SHORT_SELLING: opening shorts require both the policy flag and account capability.
  // Risk-reducing covers are allowed based on the existing short position even if shorting is now
  // disabled or capabilities are unavailable; blocking a cover would trap exposure.
  if (proposal.side === "short") {
    const brokerSupportsShort = context.accountCapabilities?.shortSelling === true;
    if (!context.policy.shortSellingEnabled || !brokerSupportsShort) {
      const why = !context.policy.shortSellingEnabled
        ? `short-selling is disabled in policy`
        : `the connected account does not support short selling`;
      reasons.push(`Order side "${proposal.side}" rejected: ${why}.`);
    } else {
      if (!context.policy.riskRules?.shortStopLossPct || context.policy.riskRules.shortStopLossPct <= 0) {
        reasons.push(`Short proposals must carry a mandatory stop-loss (policy.riskRules.shortStopLossPct).`);
      }
      if (context.policy.maxShortOrderNotional && estimatedNotional > context.policy.maxShortOrderNotional) {
        reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the max short order limit of $${context.policy.maxShortOrderNotional}`);
      }
    }
  }
  if (proposal.side === "cover" && coverQuantityExceedsShorts(proposal, context.positions)) {
    reasons.push(`Cover quantity exceeds current ${symbol} short holdings.`);
  }
  
  // MARGIN-ACCOUNT MINIMUM. FINRA Notice 26-10 replaces the old PDT count/$25k framework with
  // intraday margin standards effective 2026-06-04, with broker phase-in permitted through
  // 2027-10-20. We do not try to model broker-specific intraday margin; we enforce the static
  // $2,000 margin minimum on a LIVE/real-capital MARGIN account and defer the rest to the broker.
  // Scope: LIVE execution only (Test/local sim and broker-Paper are never gated); opening legs only;
  // cash (non-margin) accounts are never gated here (they aren't subject to the margin minimum).
  if (
    isOpening &&
    context.isLiveExecution === true &&
    context.accountCapabilities?.marginEnabled === true &&
    context.portfolio.totalMarketValue < MARGIN_MINIMUM_EQUITY
  ) {
    reasons.push(
      `margin_minimum: this LIVE margin account's equity $${context.portfolio.totalMarketValue.toFixed(2)} is below the ` +
        `$${MARGIN_MINIMUM_EQUITY.toLocaleString("en-US")} margin minimum. FINRA Notice 26-10 replaces the old PDT count/$25k framework, but broker phase-in and broker-specific intraday margin restrictions can still apply.`
    );
  }

  const effectiveMaxOrderNotional = Math.min(
    context.policy.maxOrderNotional ?? Infinity,
    context.policy.maxOrderPctOfNav ? (context.policy.maxOrderPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  if (isOpening && estimatedNotional > effectiveMaxOrderNotional) {
    reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds the maximum order limit of $${effectiveMaxOrderNotional.toFixed(2)}`);
  }
  // Headroom (execution-buffer) gate. For shorts, fold in the short-specific cap so a short sized at
  // the full maxShortOrderNotional still leaves the buffer even when the generic/NAV cap is unset or
  // higher (the hard short-cap check above only rejects at 100% of the short cap). (Review: PR #278.)
  const isShortWithShortCap =
    proposal.side === "short" && context.policy.maxShortOrderNotional != null && context.policy.maxShortOrderNotional > 0;
  const headroomBaseCap = isShortWithShortCap
    ? Math.min(effectiveMaxOrderNotional, context.policy.maxShortOrderNotional as number)
    : effectiveMaxOrderNotional;
  const headroomMaxOrderNotional = applyOpeningOrderHeadroom(headroomBaseCap);
  if (
    isOpening &&
    Number.isFinite(headroomBaseCap) &&
    Number.isFinite(headroomMaxOrderNotional) &&
    estimatedNotional > headroomMaxOrderNotional
  ) {
    const capLabel = isShortWithShortCap && headroomBaseCap === context.policy.maxShortOrderNotional ? "max short order" : "maximum order";
    reasons.push(
      `Order of ${dollars(estimatedNotional)} leaves less than ${OPENING_ORDER_HEADROOM_PCT}% buffer below the ${dollars(headroomBaseCap)} ${capLabel} limit; reduce to ${dollars(headroomMaxOrderNotional)} or raise the policy cap.`
    );
  }
  // Market-impact (ADV) ceiling: reject an opening order whose notional exceeds maxOrderPctOfAdv % of
  // the name's recent daily $-volume (price × volume from the scan; the app ingests no historical
  // bars). Defense-in-depth alongside deterministic sizing — also catches manual/non-sized proposals.
  // Skipped when the gauge is unavailable so it can never false-reject.
  if (isOpening && context.policy.maxOrderPctOfAdv != null && context.policy.maxOrderPctOfAdv > 0) {
    const full = context.marketScan?.topCandidates.find((c) => normalizeSymbol(c.symbol) === symbol);
    const dollarVol = full && full.price > 0 && full.volume > 0 ? full.price * full.volume : undefined;
    if (dollarVol != null) {
      const advCap = (context.policy.maxOrderPctOfAdv / 100) * dollarVol;
      if (estimatedNotional > advCap) {
        reasons.push(
          `Order of $${estimatedNotional.toFixed(2)} exceeds ${context.policy.maxOrderPctOfAdv}% of ${symbol}'s ~$${Math.round(dollarVol).toLocaleString("en-US")} daily $-volume (ADV cap $${advCap.toFixed(2)}) — would risk outsized market impact.`
        );
      }
    }
  }
  const effectiveMaxDailyNotional = Math.min(
    context.policy.maxDailyNotional ?? Infinity,
    context.policy.maxDailyPctOfNav ? (context.policy.maxDailyPctOfNav / 100) * context.portfolio.totalMarketValue : Infinity
  );
  // Daily/hourly notional + daily order-count failures are TIME-CONTEXT gates: the budget they
  // guard replenishes on its own (midnight / rolling hour), so they are escalatable — a pending
  // card approved later re-runs this gate against the then-current consumption and only places
  // if the cap genuinely has room. The PER-ORDER caps above are NOT time-context (the order is
  // simply too big) and stay hard blocks.
  if (isOpening && context.dailyNotionalUsed + estimatedNotional > effectiveMaxDailyNotional) {
    pushEscalatable("daily_notional_cap", "Daily notional limit would be exceeded.");
  }
  if (
    isOpening &&
    context.policy.maxHourlyNotional != null &&
    (context.hourlyNotionalUsed ?? 0) + estimatedNotional > context.policy.maxHourlyNotional
  ) {
    pushEscalatable("hourly_notional_cap", "Hourly notional limit would be exceeded.");
  }
  if (isOpening && context.dailyOrderCount + 1 > context.policy.maxDailyOrders) {
    pushEscalatable("daily_order_cap", "Daily opening-order count limit would be exceeded.");
  }
  // Affordability: block an opening order the account can't fund rather than outsourcing the
  // check to the broker's margin rejection. buyingPower is broker-accurate for live/paper
  // (margin-aware) and cash for Test; a non-positive/non-finite value (a gateway that doesn't
  // report it) is treated as "unknown" and never blocks, so this can't false-positive.
  if (
    isOpening &&
    Number.isFinite(context.portfolio.buyingPower) &&
    context.portfolio.buyingPower > 0 &&
    estimatedNotional > context.portfolio.buyingPower
  ) {
    reasons.push(`Order of $${estimatedNotional.toFixed(2)} exceeds available buying power $${context.portfolio.buyingPower.toFixed(2)}.`);
  }
  if (proposal.side === "sell" && sellQuantityExceedsHoldings(proposal, context.positions)) {
    reasons.push(`Sell quantity exceeds current ${symbol} holdings.`);
  }

  // An exit (sell/cover) must carry a resolvable size. A size-less exit (neither quantity nor
  // dollarAmount) slips past the holdings/notional checks above (they no-op on an undefined
  // quantity) and books a ZERO-quantity phantom fill the dashboard reports as a successful close
  // while the position stays fully open and exposed. Deterministic sizing resolves LLM-emitted
  // exits to the full position before they reach here, so a size-less exit at the gate is a real
  // defect — reject it rather than silently no-op the stop.
  if (
    (proposal.side === "sell" || proposal.side === "cover") &&
    proposal.quantity == null &&
    proposal.dollarAmount == null
  ) {
    reasons.push(`${symbol} exit must specify a quantity or dollar amount.`);
  }

  const crisisOpeningExposureReason = deRiskInCrisisReason(proposal, context, estimatedNotional);
  if (crisisOpeningExposureReason) reasons.push(crisisOpeningExposureReason);

  // Wash-sale guardrail (IRC §1091 + Rev. Rul. 2008-5): don't rebuy a symbol closed at a loss
  // within the last 30 days, which would disallow the loss. Wash sales are only relevant for BUY
  // orders (re-establishing a long position). Covers are buy-to-close on a short and do NOT
  // re-establish the sold long position, so they are intentionally excluded here.
  //
  // Authoritative cross-account enforcement (architecture-blueprint §3.3): if the caller did not
  // pre-populate washSaleLocks/washSaleLockedSymbols, resolve the cross-account provenance map
  // now (resolveWashSaleLock) so the gate cannot be silently bypassed by a caller that omits the
  // locked set. This gate is server-side only and stays the single point of truth.
  //
  // taxSettings.washSaleHandling decides what a lockout MEANS for a TAXABLE buyer:
  //   "block"           — refuse the buy outright (the original hard-stop behavior). Available as
  //                       a stricter opt-in; no longer the default (owner decision 2026-07-03).
  //   "ask"             — refuse here, but mark the failure ESCALATABLE with the priced cost
  //                       (disallowed loss × shortTermRatePct). The strategy loop turns it into
  //                       a pending-approval card (both propose and decide authority). Approving
  //                       that card re-runs THIS gate with a server-stored override token
  //                       (context.approvedEscalations, read from the proposal row the server
  //                       itself wrote) — the ONLY way a locked buy passes in "ask" mode.
  //   "auto" (DEFAULT)  — ALWAYS proceeds (owner decision 2026-07-03: a deterministic edge-vs-cost
  //                       veto here would just re-arithmetize the LLM's own outputs — confidence,
  //                       bracket target — against an arbitrary multiple, not add independent
  //                       judgment). The priced tax cost (washSaleExpectedEdgeUsd,
  //                       estimatedTaxCostUsd) still rides decision.washSale as RECEIPT telemetry
  //                       and is threaded into the strategist prompt (taxContext.washSaleRebuyCosts)
  //                       so the model weighs it against conviction itself — never silent, never a
  //                       hard block, unless an operator explicitly opts into "block" or "ask".
  //
  // IRA-REPLACEMENT RULE (Rev. Rul. 2008-5): when the BUYING account is a roth/traditional
  // IRA and the symbol is locked, the binding loss is by construction from a TAXABLE account
  // (IRA losses never contribute locks — see tax.ts), and buying the replacement inside the IRA
  // PERMANENTLY destroys the disallowed loss. Governed by taxSettings.iraWashSaleHandling:
  //   "block" — hard block in EVERY washSaleHandling mode, ignoring override tokens, and —
  //     unlike the taxable-buyer lockout — even when the per-account washSaleGuard flag is off:
  //     resolveTaxSettings deliberately force-disables that flag for IRAs (a wash sale has no
  //     benefit INSIDE the account), so it cannot switch off the cross-account permanent-harm
  //     rule. Available as a stricter per-account opt-in; no longer the default.
  //   "disregard" (DEFAULT) — the buy PROCEEDS through the normal authority flow (all other
  //     gates unchanged). Rationale (owner decision 2026-07-03): brokers do not report
  //     cross-account IRA wash sales to the IRS — the rule only bites under audit — so
  //     respecting it is the account owner's call, not a hard system stop. NEVER silent:
  //     decision.washSale records outcome "ira_disregarded" with the verbatim
  //     IRA_WASH_SALE_DISREGARD_NOTE plus the priced provenance, the run loop / approval path
  //     audit it (wash_sale_ira_disregarded), and the note renders wherever the purchase shows.
  //     Override tokens stay irrelevant to IRA outcomes in both settings.
  if (proposal.side === "buy") {
    const taxSettings = context.policy.taxSettings;
    const guardOn = taxSettings?.washSaleGuard ?? true;
    const handling: WashSaleHandling = taxSettings?.washSaleHandling ?? DEFAULT_TAX_SETTINGS.washSaleHandling ?? "auto";
    // IRA detection. The ConnectedAccount row (context.accountTaxationType) is the SOURCE OF
    // TRUTH: when the row states a regime it DECIDES — a stale IRA value left behind in policy
    // taxSettings must not reclassify a now-taxable account (that would apply the Rev. Rul.
    // 2008-5 hard block to a taxable rebuy the ask/auto/guard-off paths should govern). Only
    // when the row is silent do the weaker signals speak, and then as a union, because falsely
    // treating an IRA as taxable permanently destroys the disallowed basis: capabilities can
    // misreport "brokerage" on legacy/manual IRA rows, and a legacy policy may carry the only
    // record of the regime for accounts that predate the row-level field.
    const buyerIsIra = isIraTaxRegime(
      context.accountTaxationType,
      taxSettings?.taxationType,
      context.accountCapabilities?.accountType
    );
    if (guardOn || buyerIsIra) {
      const lock = resolveWashSaleLock(context, symbol);
      if (lock) {
        const shortTermRatePct = taxSettings?.shortTermRatePct ?? DEFAULT_TAX_SETTINGS.shortTermRatePct;
        const estimatedTaxCostUsd = lock.lossUsd != null ? round2((lock.lossUsd * shortTermRatePct) / 100) : undefined;
        const clearsOn = lock.clearDate ? lock.clearDate.toISOString().slice(0, 10) : undefined;
        const lockNote = describeWashSaleLock(lock);
        const auditBase: Omit<WashSaleGateAudit, "outcome"> = {
          handling,
          symbol,
          ...(lock.account ? { account: lock.account } : {}),
          ...(lock.clearDate ? { clearDate: lock.clearDate.toISOString() } : {}),
          ...(lock.lossUsd != null ? { disallowedLossUsd: round2(lock.lossUsd) } : {}),
          ...(estimatedTaxCostUsd != null ? { estimatedTaxCostUsd } : {})
        };
        const override = (context.approvedEscalations ?? []).find(
          (entry) =>
            entry.kind === "wash_sale_ask" &&
            normalizeSymbol(entry.symbol) === symbol &&
            typeof entry.token === "string" &&
            entry.token.length > 0
        );
        if (buyerIsIra) {
          const iraHandling: IraWashSaleHandling = taxSettings?.iraWashSaleHandling ?? DEFAULT_TAX_SETTINGS.iraWashSaleHandling ?? "disregard";
          if (iraHandling === "disregard") {
            // Owner-approved opt-in: proceed, annotated + audited (see the gate comment above).
            // No reason is pushed, so the buy flows through the normal authority path; every
            // other gate still applies at full strength. Override tokens are irrelevant here.
            washSaleAudit = { ...auditBase, outcome: "ira_disregarded", note: IRA_WASH_SALE_DISREGARD_NOTE };
          } else {
            reasons.push(
              `${symbol} is in a 30-day wash-sale lockout (${lockNote}). Rebuying it inside this IRA would PERMANENTLY ` +
                `destroy the disallowed loss` +
                (estimatedTaxCostUsd != null ? ` (~${dollars(estimatedTaxCostUsd)} of tax deduction forfeited forever)` : "") +
                ` — a replacement purchase in an IRA can never recover the basis (Rev. Rul. 2008-5). ` +
                `This is blocked in every wash-sale handling mode (change "IRA wash-sale rebuys" in Tax rules to override).`
            );
            washSaleAudit = { ...auditBase, outcome: "blocked_ira" };
          }
        } else if (override && (handling === "ask" || handling === "auto")) {
          // "Locked but user-approved via the ask/auto path": the server-stored token is honored
          // WITHOUT weakening the default block — if handling was tightened back to "block" since
          // the card was escalated, this branch is unreachable and the buy blocks again below.
          //
          // STALE-PRICE GUARD: the user approved a card priced at approvedCostUsd. Honor the token
          // only while the freshly recomputed cost stays within washSaleOverrideCostTolerance of
          // that figure (decreases always honor). If new losses posted since escalation and the
          // real cost is materially higher — or the pricing situation changed shape (an unpriced
          // card is now priceable, or vice versa) — refuse the stale approval and RE-ESCALATE at
          // the current price so a fresh card asks again. Never execute at a cost the user
          // didn't see.
          const approvedCostUsd = override.approvedCostUsd;
          const costStillHonorable =
            (approvedCostUsd == null && estimatedTaxCostUsd == null) ||
            (approvedCostUsd != null &&
              estimatedTaxCostUsd != null &&
              estimatedTaxCostUsd <= approvedCostUsd + washSaleOverrideCostTolerance(approvedCostUsd));
          if (costStillHonorable) {
            washSaleAudit = { ...auditBase, outcome: "approved_via_override", overrideToken: override.token };
          } else {
            const fmtCost = (v: number | undefined) => (v != null ? `~${dollars(v)}` : "unpriced");
            const reason =
              `Rebuying ${symbol}: the forfeited tax deduction changed since you approved ` +
              `(${fmtCost(approvedCostUsd)} -> ${fmtCost(estimatedTaxCostUsd)}; wash sale — ${lockNote}). ` +
              `Approve again at the current cost. Your call.`;
            pushEscalatable("wash_sale_ask", reason, {
              ...(lock.account ? { account: lock.account } : {}),
              ...(lock.clearDate ? { clearDate: lock.clearDate.toISOString() } : {}),
              ...(lock.lossUsd != null ? { disallowedLossUsd: round2(lock.lossUsd) } : {}),
              ...(estimatedTaxCostUsd != null ? { estimatedTaxCostUsd } : {})
            });
            washSaleAudit = { ...auditBase, outcome: "reescalated_cost_changed", overrideToken: override.token };
          }
        } else if (handling === "ask") {
          const reason =
            `Rebuying ${symbol} now forfeits ` +
            (estimatedTaxCostUsd != null ? `~${dollars(estimatedTaxCostUsd)}` : "an unpriced amount") +
            ` of tax deduction (wash sale — ${lockNote}). Your call.`;
          pushEscalatable("wash_sale_ask", reason, {
            ...(lock.account ? { account: lock.account } : {}),
            ...(lock.clearDate ? { clearDate: lock.clearDate.toISOString() } : {}),
            ...(lock.lossUsd != null ? { disallowedLossUsd: round2(lock.lossUsd) } : {}),
            ...(estimatedTaxCostUsd != null ? { estimatedTaxCostUsd } : {})
          });
          washSaleAudit = { ...auditBase, outcome: "ask_escalated" };
        } else if (handling === "auto") {
          // Owner decision (2026-07-03): "auto" ALWAYS proceeds — no deterministic threshold veto.
          // The removed edge-vs-cost gate re-arithmetized the LLM's OWN outputs (confidenceScore,
          // bracketTakeProfit) against an arbitrary WASH_SALE_AUTO_EDGE_MULTIPLE constant, so it
          // wasn't an independent check — it was second-guessing the model with its own numbers.
          // The priced tax cost is real deterministic information, so it stays: it rides the
          // decision as RECEIPT telemetry (never a veto) and is threaded into the strategist
          // prompt (taxContext.washSaleRebuyCosts) so the model can weigh it against conviction
          // itself, explaining that tradeoff in the rationale.
          const expectedEdgeUsd = washSaleExpectedEdgeUsd(proposal, context.policy, estimatedNotional);
          washSaleAudit = {
            ...auditBase,
            outcome: "auto_proceeded",
            expectedEdgeUsd,
            edgeMultiple: WASH_SALE_AUTO_EDGE_MULTIPLE
          };
        } else {
          reasons.push(
            `${symbol} is in a 30-day wash-sale lockout (${lockNote}); rebuying now would disallow that loss` +
              (estimatedTaxCostUsd != null
                ? ` (~${dollars(estimatedTaxCostUsd)} of tax deduction forfeited${clearsOn ? `; clears ${clearsOn}` : ""})`
                : "") +
              `.`
          );
          washSaleAudit = { ...auditBase, outcome: "blocked" };
        }
      }
    }
  }

  if (isOpening && proposal.side === "short" && context.policy.maxShortExposurePct) {
    const totalShortExposure = context.positions.reduce((sum, pos) => pos.quantity < 0 ? sum + Math.abs(pos.marketValue) : sum, 0);
    const projectedShortExposure = totalShortExposure + estimatedNotional;
    const projectedShortExposurePct = context.portfolio.totalMarketValue > 0 ? (projectedShortExposure / context.portfolio.totalMarketValue) * 100 : 0;
    if (projectedShortExposurePct > context.policy.maxShortExposurePct) {
      reasons.push(`Projected total short exposure ${projectedShortExposurePct.toFixed(2)}% exceeds maxShortExposurePct limit of ${context.policy.maxShortExposurePct}%.`);
    }
  }

  // Per-symbol exposure % cap — OPENING orders only. A close (sell/cover) can only reduce a symbol's
  // exposure, so it must never be blocked here (otherwise the very risk-exit triggered by an over-cap
  // position — see strategy.ts "SELL/TRIM any position exceeding maxSymbolExposurePct%" — would be
  // blocked by the same cap that demanded it). Mirrors the isOpening gate on maxSymbolExposureNotional
  // below. This cap is ON by default (unlike the 100% gross/net defaults).
  const projectedSymbolExposurePct = projectedExposurePct(proposal, context.positions, context.portfolio, estimatedNotional);
  if (isOpening && context.policy.maxSymbolExposurePct && projectedSymbolExposurePct > context.policy.maxSymbolExposurePct) {
    reasons.push(`Projected ${symbol} exposure ${projectedSymbolExposurePct.toFixed(2)}% exceeds ${context.policy.maxSymbolExposurePct}%.`);
  }
  if (context.policy.maxSymbolExposureNotional && isOpening) {
    const existingPosition = context.positions.find((p) => normalizeSymbol(p.symbol) === normalizeSymbol(proposal.symbol));
    const existingValue = existingPosition ? Math.abs(existingPosition.marketValue) : 0;
    // Opening orders (buy/short) ADD exposure. Closing orders (sell/cover) always
    // reduce symbol exposure and must never be blocked — guard on isOpening above.
    const projectedNotional = existingValue + estimatedNotional;
    if (projectedNotional > context.policy.maxSymbolExposureNotional) {
      reasons.push(`Projected ${symbol} notional exposure $${projectedNotional.toFixed(2)} exceeds cap $${context.policy.maxSymbolExposureNotional.toFixed(2)}.`);
    }
  }

  // Whole-portfolio gross/net exposure caps. Gross = Σ|marketValue| (total market
  // involvement / leverage); net = Σ marketValue (directional bias). These apply to OPENING
  // orders only — a risk-reducing close (sell/cover) is ALWAYS allowed, since it can only move
  // gross/net toward zero. We gate on `isOpening` rather than relying solely on the
  // "further-from-cap" guards because a corrupt/oversized notional on a close (e.g. an exit with
  // no live quote) can overshoot through zero and look like a huge opposite-side position, which
  // previously blocked the exit. These mainly bite once short selling is enabled (default 100%).
  if ((context.policy.maxGrossExposurePct || context.policy.maxNetExposurePct) && isOpening) {
    const totalValue = context.portfolio.totalMarketValue;
    if (totalValue > 0) {
      const grossNow = context.positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
      const netNow = context.positions.reduce((sum, p) => sum + p.marketValue, 0);
      const grossProjected = grossNow + estimatedNotional;
      const netDelta = proposal.side === "buy" ? estimatedNotional : -estimatedNotional; // opening: buy=long, short=short
      const netProjected = netNow + netDelta;
      if (context.policy.maxGrossExposurePct) {
        const grossCap = (context.policy.maxGrossExposurePct / 100) * totalValue;
        if (grossProjected > grossCap && grossProjected > grossNow) {
          reasons.push(`Projected gross exposure $${grossProjected.toFixed(2)} exceeds gross cap $${grossCap.toFixed(2)} (${context.policy.maxGrossExposurePct}%).`);
        }
      }
      if (context.policy.maxNetExposurePct) {
        const netCap = (context.policy.maxNetExposurePct / 100) * totalValue;
        if (Math.abs(netProjected) > netCap && Math.abs(netProjected) > Math.abs(netNow)) {
          reasons.push(`Projected net exposure $${netProjected.toFixed(2)} exceeds net cap $${netCap.toFixed(2)} (${context.policy.maxNetExposurePct}%).`);
        }
      }
    }
  }

  // Sector exposure % cap — OPENING orders only, same reasoning as the per-symbol cap: a close can only
  // reduce sector exposure, so it must never be blocked (a stale/zero notional on an exit would otherwise
  // make projected == current and re-block a name in an already-over-cap sector).
  const sectorDecision = isOpening ? projectedSectorExposurePct(proposal, context, estimatedNotional) : null;
  if (sectorDecision && sectorDecision.cap > 0 && sectorDecision.projectedPct > sectorDecision.cap) {
    reasons.push(`Projected ${sectorDecision.sector} sector exposure ${sectorDecision.projectedPct.toFixed(2)}% exceeds sector cap ${sectorDecision.cap}%.`);
  }

  // Portfolio beta cap. Bounds aggregate market-directional exposure: Σ(signedMarketValue·beta) ÷
  // totalEquity, including the candidate. The per-symbol/sector caps don't see correlation, so a
  // cluster of individually-approved high-beta names can still build a large correlated drawdown;
  // this catches that. A long buy adds +beta exposure, a short adds -beta. Per-name beta comes from
  // the scan (names without a beta count as 1.0). Only an OPENING order that pushes |projected beta|
  // BOTH past the cap AND further from the current level is blocked — a beta-reducing trade always
  // passes. Defaults off (undefined); especially relevant once shorting is enabled.
  if (isOpening && context.policy.maxPortfolioBeta != null && context.policy.maxPortfolioBeta > 0) {
    const totalEquity = context.portfolio.totalMarketValue;
    if (totalEquity > 0) {
      const betaFor = (sym: string): number => {
        const b = context.marketScan?.quotesBySymbol[normalizeSymbol(sym)]?.beta;
        return b != null && Number.isFinite(b) ? b : 1;
      };
      const netBetaNow = context.positions.reduce((sum, p) => sum + p.marketValue * betaFor(p.symbol), 0);
      const signedDelta = proposal.side === "short" ? -estimatedNotional : estimatedNotional;
      const netBetaProjected = netBetaNow + signedDelta * betaFor(proposal.symbol);
      const projectedPortfolioBeta = netBetaProjected / totalEquity;
      const currentPortfolioBeta = netBetaNow / totalEquity;
      if (
        Math.abs(projectedPortfolioBeta) > context.policy.maxPortfolioBeta &&
        Math.abs(projectedPortfolioBeta) > Math.abs(currentPortfolioBeta)
      ) {
        reasons.push(
          `Projected portfolio beta ${projectedPortfolioBeta.toFixed(2)} exceeds the maxPortfolioBeta cap ` +
            `of ${context.policy.maxPortfolioBeta} (current ${currentPortfolioBeta.toFixed(2)}).`
        );
      }
    }
  }

  const riskReason = riskRuleReason(proposal, context);
  if (riskReason) reasons.push(riskReason);

  return {
    approved: reasons.length === 0,
    reasons,
    ...(reasons.length > 0 && escalations.length > 0 ? { escalations } : {}),
    ...(washSaleAudit ? { washSale: washSaleAudit } : {}),
    projectedSymbolExposurePct,
    // Opening sides accumulate daily notional; closing sides (sell/cover) do not (matches the
    // daily/hourly cap checks above, which are gated on isOpening). (T14)
    dailyNotionalUsed: context.dailyNotionalUsed + (isOpening ? estimatedNotional : 0)
  };
}

export function allowedSymbolsForPolicy(policy: TradingPolicy): string[] {
  return symbolsForPolicyUniverse(policy);
}

function isDynamicScanSymbol(symbol: string, context: PolicyContext): boolean {
  if (dynamicIndexUniversesForPolicy(context.policy).length === 0) return false;
  const quote = context.marketScan?.quotesBySymbol[symbol];
  return typeof quote?.score === "number" && quote.score > 0;
}

export function estimateNotional(proposal: TradeProposal): number {
  if (proposal.dollarAmount) return proposal.dollarAmount;
  const price = proposal.limitPrice ?? proposal.stopPrice ?? 0;
  return (proposal.quantity ?? 0) * price;
}

function hasFractionalQuantity(proposal: TradeProposal): boolean {
  return proposal.quantity !== undefined && !Number.isInteger(proposal.quantity);
}

function sellQuantityExceedsHoldings(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "sell" || proposal.quantity === undefined) return false;
  const position = positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  const currentQty = position?.quantity ?? 0;
  if (currentQty <= 0) return true; // Cannot sell if flat or short
  return currentQty < proposal.quantity;
}

function coverQuantityExceedsShorts(proposal: TradeProposal, positions: EquityPosition[]): boolean {
  if (proposal.side !== "cover" || proposal.quantity === undefined) return false;
  const position = positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  const currentQty = position?.quantity ?? 0;
  if (currentQty >= 0) return true; // Cannot cover if flat or long
  return Math.abs(currentQty) < proposal.quantity;
}

function deRiskInCrisisReason(
  proposal: TradeProposal,
  context: PolicyContext,
  estimatedNotional: number
): string | undefined {
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  if (!isOpening) return undefined;

  const cap = context.policy.tuning?.crisisMaxOpeningExposurePct;
  if (cap === undefined || cap <= 0 || !Number.isFinite(cap)) return undefined;
  if (!isCrisisOrInvertedRegime(proposal.entryMarketRegime)) return undefined;
  if (context.portfolio.totalMarketValue <= 0) return undefined;

  const openingExposurePct = (estimatedNotional / context.portfolio.totalMarketValue) * 100;
  if (openingExposurePct <= cap) return undefined;

  return `Opening ${normalizeSymbol(proposal.symbol)} exposure ${openingExposurePct.toFixed(2)}% exceeds crisis/inverted-regime cap ${cap}%.`;
}

// Typed-enum adoption (risk lane): classify the persisted regime label once via the shared source
// of truth in ./market-regime instead of an ad-hoc substring match, so a regime relabel can't
// silently desync this crisis/inverted opening-exposure cap from the bear filter and escalation
// gates. Canonical-label behavior is unchanged (pinned by test/market-regime.test.ts and the
// crisis-cap cases in test/policy.test.ts): "Crisis (Extreme Volatility)" and "Cautious (Inverted
// Curve)" trip the cap, "Risk-Off (High Volatility)"/"Neutral"/"Risk-On" do not. A non-canonical
// free-text label now reads non-crisis/inverted rather than accidentally matching a substring.
function isCrisisOrInvertedRegime(regime?: string): boolean {
  return isCrisisOrInvertedMarketRegime(regimeFromLabel(regime));
}

function projectedExposurePct(
  proposal: TradeProposal,
  positions: EquityPosition[],
  portfolio: Portfolio,
  notional: number
): number {
  const symbol = normalizeSymbol(proposal.symbol);
  const position = positions.find((item) => normalizeSymbol(item.symbol) === symbol);
  const current = Math.abs(position?.marketValue ?? 0);
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const projected = isOpening ? current + notional : Math.max(0, current - notional);
  if (portfolio.totalMarketValue <= 0) return Infinity;
  return (projected / portfolio.totalMarketValue) * 100;
}

function projectedSectorExposurePct(
  proposal: TradeProposal,
  context: PolicyContext,
  notional: number
): { sector: string; projectedPct: number; cap: number } | undefined {
  const symbol = normalizeSymbol(proposal.symbol);
  const sector = sectorForSymbol(symbol, context.positions, context.marketScan);
  if (!sector) return undefined;
  const cap = sectorCapFor(context.policy, sector);
  if (cap === undefined) return undefined;

  const currentValue = context.positions
    .filter((position) => sectorForSymbol(normalizeSymbol(position.symbol), context.positions, context.marketScan) === sector)
    .reduce((sum, position) => sum + Math.abs(position.marketValue), 0);
  
  const isOpening = proposal.side === "buy" || proposal.side === "short";
  const isClosing = proposal.side === "sell" || proposal.side === "cover";
  const projectedValue = isOpening ? currentValue + notional : (isClosing ? Math.max(0, currentValue - notional) : currentValue);
  const projectedPct = context.portfolio.totalMarketValue > 0 ? (projectedValue / context.portfolio.totalMarketValue) * 100 : 0;
  return { sector, projectedPct, cap };
}

// Add-to-position risk rules (stop-loss / take-profit) apply only to OPENING sides:
// buy (add to a long) and short (add to a short). Exit sides (sell/cover) intentionally
// fall through to `return undefined` — they carry no add-to-position risk to gate here.
function riskRuleReason(proposal: TradeProposal, context: PolicyContext): string | undefined {
  const position = context.positions.find((item) => normalizeSymbol(item.symbol) === normalizeSymbol(proposal.symbol));
  if (!position || position.averageCost <= 0) return undefined;

  // Optional volatility-aware stop scaling: widen the stop for high-beta names, tighten for low-beta.
  const beta = context.marketScan?.quotesBySymbol[normalizeSymbol(proposal.symbol)]?.beta;
  const betaStops = context.policy.betaScaledStops === true;

  if (proposal.side === "buy") {
    if (position.quantity > 0) {
      const avgCost = position.averageCost;
      const currentPrice = proposal.limitPrice ?? proposal.stopPrice ?? avgCost;
      const drawdownPct = ((avgCost - currentPrice) / avgCost) * 100;
      const returnPct = ((currentPrice - avgCost) / avgCost) * 100;

      const effStopLossPct = betaScaledStopPct(context.policy.riskRules?.stopLossPct ?? 0, beta, betaStops);
      if (effStopLossPct > 0 && drawdownPct > effStopLossPct) {
        return `Stop-loss rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is down ${drawdownPct.toFixed(2)}%.`;
      }
      if (context.policy.riskRules?.stopLossNotional) {
        const totalDrawdownNotional = (avgCost - currentPrice) * position.quantity;
        if (totalDrawdownNotional > context.policy.riskRules.stopLossNotional) {
          return `Stop-loss rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is down $${totalDrawdownNotional.toFixed(2)}.`;
        }
      }
      if (context.policy.riskRules?.takeProfitPct && returnPct >= context.policy.riskRules.takeProfitPct) {
        return `Take-profit rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is up ${returnPct.toFixed(2)}%.`;
      }
      if (context.policy.riskRules?.takeProfitNotional) {
        const totalReturnNotional = (currentPrice - avgCost) * position.quantity;
        if (totalReturnNotional >= context.policy.riskRules.takeProfitNotional) {
          return `Take-profit rule blocks adding to ${normalizeSymbol(proposal.symbol)} while it is up $${totalReturnNotional.toFixed(2)}.`;
        }
      }
    }
  } else if (proposal.side === "short") {
    if (position.quantity < 0) {
      const avgCost = position.averageCost;
      const currentPrice = proposal.limitPrice ?? proposal.stopPrice ?? avgCost;
      const drawdownPct = ((currentPrice - avgCost) / avgCost) * 100; // Inverse math for short: price up means loss

      const effShortStopPct = betaScaledStopPct(context.policy.riskRules?.shortStopLossPct ?? 0, beta, betaStops);
      if (effShortStopPct > 0 && drawdownPct > effShortStopPct) {
        return `Cannot average up on short: Position is down ${drawdownPct.toFixed(2)}%, exceeding short stop-loss limit of ${context.policy.riskRules.shortStopLossPct}%.`;
      }
    }
  }
  return undefined;
}

function sectorForSymbol(symbol: string, positions: EquityPosition[], marketScan?: MarketScan): string | undefined {
  const positionSector = positions.find((position) => normalizeSymbol(position.symbol) === symbol)?.sector;
  if (positionSector) return positionSector;

  if (marketScan) {
    const scanSector = marketScan.sectorBySymbol[symbol] ?? marketScan.quotesBySymbol[symbol]?.sector;
    if (scanSector) return scanSector;
  }

  // Fallback: query the local SQLite imported_securities_ref table
  try {
    const row = getDb()
      .prepare("SELECT sector FROM imported_securities_ref WHERE ticker = ?")
      .get(symbol) as { sector: string | null } | undefined;
    if (row?.sector) return row.sector;
  } catch {
    // DB query error or database not initialized (e.g. during tests)
  }

  return undefined;
}

function sectorCapFor(policy: TradingPolicy, sector: string): number | undefined {
  const exact = policy.sectorCaps[sector];
  if (exact !== undefined) return exact;
  const match = Object.entries(policy.sectorCaps).find(([key]) => key.toLowerCase() === sector.toLowerCase());
  return match?.[1];
}

/**
 * Volatility-aware stop scaling. Widens the stop distance for high-beta names (fewer noise
 * stop-outs) and tightens it for low-beta names (cut losers sooner), instead of one flat % for
 * every ticker. Beta is clamped to [0.5×, 2.0×] so a missing/extreme value can't produce an absurd
 * stop. Returns the base unchanged when scaling is disabled or beta is unavailable/invalid — so this
 * is always safe to call. Shared by the gate (riskRuleReason), the proactive risk-exit generator,
 * and the synthetic trailing stop so all three stay consistent.
 */
export function betaScaledStopPct(baseStopPct: number, beta: number | undefined, enabled: boolean): number {
  if (!enabled || baseStopPct <= 0 || beta == null || !Number.isFinite(beta) || beta <= 0) return baseStopPct;
  const clamped = Math.max(0.5, Math.min(2.0, beta));
  return baseStopPct * clamped;
}
