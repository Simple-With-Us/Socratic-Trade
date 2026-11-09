import type { MacroData } from "./macro";

/**
 * Backend-computed macroeconomic metrics derived from the raw FRED series we already
 * fetch (Fed funds, 10Y treasury, CPI YoY, unemployment) plus an aggregate market
 * earnings yield. None are returned directly by any provider, but all are standard
 * macro reads the agent should weigh when judging the regime — so we compute them
 * deterministically here. Every value is `undefined` when its inputs are missing.
 *
 * Units: macro fields arrive as percent strings like "4.20%"; we parse to plain numbers
 * (percentage points). Differences are therefore in pp; `equityRiskPremium` compares a
 * market earnings yield (%) to the 10Y nominal yield (%).
 */
export interface MacroDerivedMetrics {
  /** 10Y treasury minus 3-month T-bill, in pp. The Fed's preferred recession curve; <0 = inverted. */
  curve3m10y?: number;
  /** 10Y treasury minus 2Y treasury, in pp. The canonical "2s10s" curve; <0 = inverted (recession signal). */
  curve2s10s?: number;
  /** 10Y treasury minus Fed funds, in pp. The policy curve; <0 = inverted vs the policy rate. */
  yieldCurveSpread?: number;
  /** VIX ÷ 3-month VIX. >1 = backwardation (acute near-term stress); <1 = normal contango. */
  vixTermStructure?: number;
  /** 10Y treasury minus CPI YoY, in pp. The real risk-free rate — drives equity discounting. */
  real10Y?: number;
  /** Fed funds minus CPI YoY, in pp. >0 = restrictive policy stance, <0 = accommodative. */
  realFedFunds?: number;
  /** Unemployment + CPI YoY. The "misery index" — higher = more macro stress. */
  miseryIndex?: number;
  /** Market earnings yield minus 10Y yield, in pp. Equity risk premium: higher = stocks cheap vs bonds. */
  equityRiskPremium?: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Parse a FRED-style percent string ("4.20%") or plain number string to a number. */
function pctToNum(value?: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

export function deriveMacroMetrics(
  macro: MacroData,
  opts?: { marketEarningsYield?: number }
): MacroDerivedMetrics {
  const fedFunds = pctToNum(macro.fedFundsRate);
  const threeMonth = pctToNum(macro.dgs3moTreasury);
  const twoYear = pctToNum(macro.dgs2Treasury);
  const tenYear = pctToNum(macro.dgs10Treasury);
  const cpi = pctToNum(macro.cpiInflation);
  const unemployment = pctToNum(macro.unemploymentRate);
  const vix = pctToNum(macro.vix);
  const vix3m = pctToNum(macro.vix3m);
  const out: MacroDerivedMetrics = {};

  if (tenYear !== undefined && threeMonth !== undefined) out.curve3m10y = round2(tenYear - threeMonth);
  if (tenYear !== undefined && twoYear !== undefined) out.curve2s10s = round2(tenYear - twoYear);
  if (tenYear !== undefined && fedFunds !== undefined) out.yieldCurveSpread = round2(tenYear - fedFunds);
  if (vix !== undefined && vix3m !== undefined && vix3m > 0) out.vixTermStructure = round2(vix / vix3m);
  if (tenYear !== undefined && cpi !== undefined) out.real10Y = round2(tenYear - cpi);
  if (fedFunds !== undefined && cpi !== undefined) out.realFedFunds = round2(fedFunds - cpi);
  if (unemployment !== undefined && cpi !== undefined) out.miseryIndex = round2(unemployment + cpi);

  const mey = opts?.marketEarningsYield;
  if (typeof mey === "number" && Number.isFinite(mey) && tenYear !== undefined) {
    out.equityRiskPremium = round2(mey - tenYear);
  }

  return out;
}
