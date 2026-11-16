// Typed market-regime enum + numeric severity — the discriminated-union replacement for the
// old bare-string regime label that several modules used to substring-match independently
// (`isCrisisOrInvertedRegime` in policy.ts checked "crisis"/"inverted", `deterministicBearFilter`
// in strategy.ts checked `startsWith("Crisis")/startsWith("Risk-Off")`, `isEscalationRegime` in
// regime-watch.ts checked yet another set). A relabel could silently desync one gate from another
// with no type error. This module is the single typed source of truth; every consumer above now
// derives its boolean from `MarketRegime` + these helpers instead of re-deriving its own substring
// rule.
//
// Deliberately dependency-free (no imports from ./db, ./macro, or anything else) so it can be
// imported by VALUE from client-bundled code (e.g. app/console/macro/indicators.ts) without
// pulling in server-only modules like better-sqlite3. src/lib/macro.ts re-exports everything here
// so existing `import { X } from "./macro"` call sites are unaffected.

/** MacroData fields this module's classifier reads — kept minimal and dependency-free. */
export interface MarketRegimeInputs {
  asOf: string;
  vix: string;
  fedFundsRate: string;
  dgs10Treasury: string;
}

export type MarketRegime =
  | "crisis"
  | "risk-off"
  | "cautious-inverted"
  | "neutral"
  | "risk-on"
  | "unknown";

/**
 * Enum -> persisted label string. Kept in lockstep with the literal strings
 * `determineMarketRegime` has always returned — changing a value here changes what gets
 * persisted as `entryMarketRegime` and would desync every historical row's label from new
 * rows, so treat this map as append-only / immutable for existing keys.
 */
export const MARKET_REGIME_LABELS: Record<MarketRegime, string> = {
  crisis: "Crisis (Extreme Volatility)",
  "risk-off": "Risk-Off (High Volatility)",
  "cautious-inverted": "Cautious (Inverted Curve)",
  neutral: "Neutral (Normal Volatility)",
  "risk-on": "Risk-On (Low Volatility)",
  unknown: "Unknown (no macro feed)"
};

/**
 * Numeric risk-off severity in [0, 1] for each enum bucket — monotone with how much the
 * deterministic gates (crisis cap, bear filter, escalation) should tighten. "unknown" gets
 * 0 (neutral/non-escalating): a missing feed must never itself read as elevated risk.
 */
export const MARKET_REGIME_SEVERITY: Record<MarketRegime, number> = {
  crisis: 1,
  "risk-off": 0.66,
  "cautious-inverted": 0.33,
  neutral: 0,
  "risk-on": 0,
  unknown: 0
};

/** Regimes that should trip the crisis/inverted opening-exposure cap (policy.ts). */
export function isCrisisOrInvertedMarketRegime(regime: MarketRegime): boolean {
  return regime === "crisis" || regime === "cautious-inverted";
}

/** Regimes the expert panel flagged for escalation (wider dissent/retrieval, flip alerts). */
export function isEscalationMarketRegime(regime: MarketRegime): boolean {
  return regime === "crisis" || regime === "risk-off" || regime === "cautious-inverted";
}

/** Regimes `deterministicBearFilter` treats as risk-off (tags below-median buys as advisory pre-vetoes). */
export function isRiskOffFilterRegime(regime: MarketRegime): boolean {
  return regime === "crisis" || regime === "risk-off";
}

/**
 * Single deterministic classifier producing BOTH the enum and the numeric severity from raw
 * macro inputs. Primary axis is VIX (volatility); the yield curve (10y vs Fed funds)
 * participates too — an inverted curve nudges borderline VIX readings toward risk-off and
 * surfaces a distinct "cautious-inverted" bucket in calm-but-inverted markets. This is the one
 * place the classification logic lives; `determineMarketRegime` (src/lib/macro.ts) is a thin
 * label-projection wrapper over it so every consumer (deterministic gates, the label string, and
 * any future numeric-severity consumer) stays in sync by construction.
 */
export function classifyMarketRegime(macro: MarketRegimeInputs): { regime: MarketRegime; severity: number } {
  const toResult = (regime: MarketRegime) => ({ regime, severity: MARKET_REGIME_SEVERITY[regime] });
  // Unsourced macro (no FRED key) carries asOf "unavailable". Don't assert a confident regime off
  // fabricated constants — return an explicit Unknown so downstream conditioning/caps stay neutral.
  if (macro.asOf === "unavailable") return toResult("unknown");
  const vix = parseFloat(macro.vix);
  const fedFunds = parseFloat(macro.fedFundsRate);
  const dgs10 = parseFloat(macro.dgs10Treasury);
  // Curve inversion: 10y meaningfully below the policy rate.
  const inverted = Number.isFinite(fedFunds) && Number.isFinite(dgs10) && dgs10 < fedFunds - 0.1;
  if (Number.isFinite(vix)) {
    if (vix > 30) return toResult("crisis");
    if (vix > 20 || (inverted && vix > 17)) return toResult("risk-off");
    if (vix < 13 && !inverted) return toResult("risk-on");
  }
  return toResult(inverted ? "cautious-inverted" : "neutral");
}

/**
 * Map a PERSISTED regime label (e.g. `TradeProposal.entryMarketRegime`, a scorecard's `regime`
 * field, or the console regime card's `board.regime`) back to the typed enum for consumers that
 * only have the string in hand. Falls back to "unknown" for anything that isn't one of the five
 * canonical labels — including free-text regime tags used in tests/tuning fixtures (e.g. "Bull",
 * "Tech-Bull") and the runtime's synthetic "Active Risk Check" tag — so an unrecognized string
 * reads as severity 0 (non-escalating) rather than silently matching a stale substring rule.
 */
export function regimeFromLabel(label: string | undefined): MarketRegime {
  if (!label) return "unknown";
  const found = (Object.entries(MARKET_REGIME_LABELS) as Array<[MarketRegime, string]>).find(
    ([, value]) => value === label
  );
  return found ? found[0] : "unknown";
}
