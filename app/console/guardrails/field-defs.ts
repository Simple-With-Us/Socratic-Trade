/** Guardrails field metadata (labels + honest one-liners + loosening
 *  direction). Pure data, split out of the page component so the
 *  LOOSER/TIGHTER classification over these defs is unit-testable.
 *
 *  looserWhen semantics (drives the typed-CONFIRM friction on LIVE):
 *  - "up"/"down": which numeric direction loosens the cage.
 *  - "on": ENABLING the toggle loosens (e.g. short selling, extended hours).
 *  - "off": DISABLING the toggle loosens — used for protective switches
 *    (panic brake, broker-held brackets), where turning protection off is
 *    the risk-increasing move. */

import type { IndexUniverse, OrderType } from "@/lib/types";
import type { FieldDef } from "../lib/policy-diff";

export const ESSENTIALS: FieldDef[] = [
  { path: "maxOrderNotional", label: "Max per order", kind: "money", optional: true, looserWhen: "up", hint: "Hard dollar cap on any single order. Blank = no per-order dollar cap (the % of portfolio cap below still applies)." },
  { path: "maxOrderPctOfNav", label: "Max per order (% of portfolio)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxDailyNotional", label: "Max spend per day", kind: "money", optional: true, looserWhen: "up", hint: "Opening orders only — protective exits never consume this cap." },
  { path: "maxDailyOrders", label: "Max opening orders per day", kind: "int", looserWhen: "up" },
  { path: "riskRules.stopLossPct", label: "Stop-loss", kind: "pct", optional: true, looserWhen: "up", hint: "Sell automatically if a position drops this far. Wider = looser protection." },
  { path: "riskRules.takeProfitPct", label: "Take profit at", kind: "pct", optional: true },
  { path: "riskRules.takeProfitTrimPct", label: "Take-profit trim", kind: "pct", optional: true, hint: "How much of the position to sell when take-profit triggers (100 = full exit)." },
  { path: "riskRules.maxDailyLossNotional", label: "Daily loss stop", kind: "money", optional: true, looserWhen: "up", hint: "Advisory circuit breaker: if the account loses this much in a day, it logs a receipt and tells the agent — which decides how to react (default: advisory, no auto-halt). Set drawdownBreakerAction to close_only/halt for hard enforcement. Blank = off." },
  { path: "riskRules.maxDrawdownPct", label: "Max drawdown stop", kind: "pct", optional: true, looserWhen: "up", hint: "Advisory circuit breaker on the fall from the account's high-water mark. On breach it logs a receipt and surfaces the drawdown to the agent, which decides (default: advisory, no auto-halt)." },
  { path: "runCadenceMinutes", label: "Run every", kind: "minutes" },
  { path: "runDuringExtendedHours", label: "Run during extended hours", kind: "bool", looserWhen: "on" },
  { path: "permitExtendedHours", label: "Allow extended-hours orders", kind: "bool", looserWhen: "on" }
];

export const SOCRATIC_OVERRIDE: FieldDef[] = [
  {
    path: "socraticOverrideMode",
    label: "Socratic override",
    kind: "select",
    options: [
      { value: "off", label: "Off" },
      { value: "propose", label: "Propose only" },
      { value: "execute", label: "Execute in Decide mode" }
    ],
    looseRank: { off: 0, propose: 1, execute: 2 },
    hint:
      "Lets Socratic Trade challenge owner-preference gates with a structured thesis. Broker, account, tax-hard, and integrity refusals still block."
  },
  {
    path: "socraticOverrideMaxPctOfNav",
    label: "Override cap (% of portfolio)",
    kind: "pct",
    optional: true,
    looserWhen: "up",
    hint: "Maximum notional for a single Socratic override. 100% allows an all-available-cash thesis when buying power permits."
  }
];

export const EXPOSURE: FieldDef[] = [
  { path: "maxSymbolExposurePct", label: "Max in one stock (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxSymbolExposureNotional", label: "Max in one stock ($)", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxGrossExposurePct", label: "Max gross exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxNetExposurePct", label: "Max net exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "maxPortfolioBeta", label: "Max portfolio beta", kind: "int", optional: true, looserWhen: "up", hint: "Risk-reducing trades always pass." },
  { path: "maxAvgCorrelation", label: "Max avg correlation (0–1)", kind: "int", optional: true, looserWhen: "up", hint: "Skips opening a name too correlated with current holdings. Never blocks exits." },
  { path: "maxOrderPctOfAdv", label: "Max order vs daily volume (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Market-impact cap: an opening order may not exceed this share of the name's recent daily dollar volume." }
];

export const ENTRY_QUALITY: FieldDef[] = [
  { path: "maxEntryDriftPct", label: "Max entry drift (%)", kind: "pct", optional: true, looserWhen: "up", hint: "Rejects a stale opening order whose price moved this far from where the idea was priced." },
  { path: "maxQuoteAgeSec", label: "Max quote age", kind: "seconds", optional: true, looserWhen: "up", hint: "Opening orders blocked on stale quotes. Blank = gate off. Missing timestamps count as stale when on." },
  { path: "maxFundamentalsAgeSec", label: "Max fundamentals age", kind: "seconds", optional: true, looserWhen: "up" },
  { path: "marketableLimitEntries", label: "Marketable-limit entries", kind: "bool", hint: "Converts opening market orders to tightly-priced limits so a fast tape can't fill arbitrarily far past the quote." }
];

export const STOPS_PLUMBING: FieldDef[] = [
  { path: "riskRules.trailingStopPct", label: "Trailing stop", kind: "pct", optional: true },
  { path: "brokerBracketsEnabled", label: "Broker-held brackets", kind: "bool", hint: "Stop/take-profit legs rest at the broker (where supported) so protection survives app downtime. Turning this OFF is looser.", looserWhen: "off" },
  { path: "robinhoodBrokerStops", label: "Robinhood resting stops", kind: "bool", hint: "Opt-in true broker-side stop for live Robinhood positions." },
  { path: "betaScaledStops", label: "Beta-scaled stops", kind: "bool", hint: "Stop distance scaled by the name's beta (clamped 0.5–2.0×)." },
  { path: "atrStops", label: "ATR-based stops", kind: "bool", hint: "Stop distance from the name's own realized daily range instead of a flat %." },
  { path: "riskRules.atrStopPeriod", label: "ATR period", kind: "int", optional: true },
  { path: "riskRules.atrStopMultiple", label: "ATR multiple", kind: "int", optional: true },
  { path: "allowExtendedHoursSyntheticStops", label: "App stops in extended hours", kind: "bool", looserWhen: "on" }
];

export const PANIC_BRAKE: FieldDef[] = [
  { path: "volPanicBrakeEnabled", label: "Volatility panic brake", kind: "bool", looserWhen: "off", hint: "A rare tail-extreme reading on VIX/VVIX/SKEW flips the system to Exit-only automatically. Turning OFF is looser." },
  { path: "volPanicVixThreshold", label: "VIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicVvixThreshold", label: "VVIX threshold", kind: "int", optional: true, looserWhen: "up" },
  { path: "volPanicSkewThreshold", label: "SKEW threshold", kind: "int", optional: true, looserWhen: "up" }
];

export const SHORTS: FieldDef[] = [
  { path: "shortSellingEnabled", label: "Short selling", kind: "bool", looserWhen: "on", hint: "Also requires the broker to allow shorting on this account. Every short must carry a short stop-loss." },
  { path: "maxShortOrderNotional", label: "Max short order", kind: "money", optional: true, looserWhen: "up" },
  { path: "maxShortExposurePct", label: "Max short exposure (%)", kind: "pct", optional: true, looserWhen: "up" },
  { path: "riskRules.shortStopLossPct", label: "Short stop-loss", kind: "pct", optional: true, looserWhen: "up", hint: "Mandatory for any short — a short without one is rejected." }
];

export const HYGIENE: FieldDef[] = [
  { path: "maxProposalsPerRun", label: "Max ideas per run", kind: "int", looserWhen: "up" },
  { path: "maxHourlyNotional", label: "Max spend per hour", kind: "money", optional: true, looserWhen: "up", hint: "Rolling 60-minute ceiling. Breaching it auto-demotes the account back to Ask-first." },
  { path: "proposalExpiryMinutes", label: "Proposal expiry", kind: "minutes", optional: true, hint: "Pending proposals older than this auto-expire. 0/blank = no hard expiry." },
  { path: "proposalRevalidateCadenceHours", label: "Re-validate pending ideas every (hours)", kind: "int", optional: true, hint: "0 = every run." },
  { path: "staleLimitOrderMinutes", label: "Stale limit-order alert (minutes)", kind: "int", optional: true }
];

export const TAX_RULES: FieldDef[] = [
  {
    path: "taxSettings.washSaleHandling",
    label: "Taxable-account wash-sale rebuys",
    kind: "select",
    options: [
      { value: "block", label: "Block (strict)" },
      { value: "ask", label: "Ask me (priced approval)" },
      { value: "auto", label: "Auto (proceeds, priced) — default" }
    ],
    // block -> ask -> auto is strictly looser: each step lets a tax-costly rebuy get closer to
    // executing. Moving down this ladder on a brokerage account costs the typed word.
    looseRank: { block: 0, ask: 1, auto: 2 },
    hint:
      "What happens when the strategy wants to rebuy a stock sold at a loss in the last 30 days (wash sale). " +
      "Auto (default): the rebuy proceeds — the forfeited tax deduction (loss × your short-term rate) is priced and shown in the rationale/receipt, but it's the strategy's own call, not a hard block. " +
      "Ask: it becomes a pending approval showing the tax deduction you'd forfeit — your call. Block: refused outright (a stricter opt-in). " +
      "Rebuying inside an IRA while a taxable-account loss is locked is governed by the separate IRA setting below."
  },
  {
    path: "taxSettings.iraWashSaleHandling",
    label: "IRA taxable-loss rebuys",
    kind: "select",
    options: [
      { value: "block", label: "Block (strict)" },
      { value: "disregard", label: "Disregard (accept audit risk) — default" }
    ],
    // block -> disregard is strictly looser: it lets a rebuy execute that tax law says destroys
    // the loss deduction. Changing it on a brokerage account costs the typed word.
    looseRank: { block: 0, disregard: 1 },
    hint:
      "What happens when this IRA wants to rebuy a stock a TAXABLE account of yours sold at a loss in the last 30 days. " +
      "Under Rev. Rul. 2008-5 that replacement purchase permanently destroys the loss deduction — the IRA never gets a basis adjustment. " +
      "Disregard (default) lets the buy proceed anyway: brokers do not report cross-account IRA wash sales to the IRS, so in practice the rule only bites under audit — this setting is YOUR explicit acceptance of that audit risk, made on your behalf by default. " +
      "Block refuses the rebuy in every wash-sale handling mode instead (a stricter opt-in). " +
      "Disregarded purchases are never silent: each one is annotated \"Wash Sale (Technically, but IRA purchase unreported to IRS)\" on the card and in Activity."
  },
  {
    path: "taxSettings.washSaleMinLossUsd",
    label: "Wash-sale lockout: minimum loss",
    kind: "money",
    optional: true,
    looserWhen: "up",
    hint:
      "Only losses at least this large trigger the 30-day rebuy lockout; a trivial loss no longer freezes a symbol for a month. Blank (default) = every loss locks. This loosens only THIS APP's guardrail — the IRS applies the wash-sale rule to losses of any size, and the tax report still counts them."
  }
];

export const UNIVERSE_FLOOR: FieldDef[] = [
  { path: "universeFloor.minPrice", label: "Min share price", kind: "money", optional: true, looserWhen: "down", hint: "The penny-stock gate. Held positions and your explicit symbols are always exempt; exits never affected." },
  { path: "universeFloor.minMarketCapUsd", label: "Min market cap", kind: "money", optional: true, looserWhen: "down" },
  { path: "universeFloor.minDollarVolume", label: "Min daily dollar volume", kind: "money", optional: true, looserWhen: "down" }
];

export const ALL_DEFS: FieldDef[] = [
  ...ESSENTIALS,
  ...SOCRATIC_OVERRIDE,
  ...EXPOSURE,
  ...ENTRY_QUALITY,
  ...STOPS_PLUMBING,
  ...PANIC_BRAKE,
  ...SHORTS,
  ...HYGIENE,
  ...TAX_RULES,
  ...UNIVERSE_FLOOR
];

export const INDICES: Array<{ id: IndexUniverse; label: string }> = [
  { id: "sp100", label: "S&P 100" },
  { id: "sp500", label: "S&P 500" },
  { id: "nasdaq100", label: "Nasdaq 100" },
  { id: "nasdaqComposite", label: "Nasdaq Composite" },
  { id: "dow30", label: "Dow 30" },
  { id: "russell2000", label: "Russell 2000" },
  { id: "nyseComposite", label: "NYSE Composite" },
  { id: "ftWilshire5000", label: "FT Wilshire 5000" }
];

export const ORDER_TYPES: OrderType[] = ["market", "limit", "stop_market", "stop_limit"];
