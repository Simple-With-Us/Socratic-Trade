// Pure Polymarket translation layer: classify a market question, read the Yes token,
// and label a crowd lean / equity tilt.  Never invents a 0-100 "Polymarket score"
// and never treats Yes as automatically bullish.

export type PolymarketScope = "company" | "sector" | "theme" | "macro";

export type PolymarketMarketKind =
  | "earnings_beat"
  | "price_above"
  | "recession"
  | "fed_cut"
  | "fed_hike"
  | "inflation"
  | "oil"
  | "tariff"
  | "regulation"
  | "other";

export type PolymarketCrowdLean = "yes_favored" | "no_favored" | "near_even";
export type PolymarketEquityTilt = "bullish" | "bearish" | "neutral" | "unclear";
export type PolymarketBookDepth = "thin" | "ok" | "deep";

export interface PolymarketThemeSpec {
  id: string;
  queries: string[];
  sectorMatch?: RegExp;
  industryMatch?: RegExp;
  kindHint?: PolymarketMarketKind;
}

export interface PolymarketMacroSpec {
  id: string;
  queries: string[];
  kind: PolymarketMarketKind;
}

export const POLYMARKET_THEME_CATALOG: PolymarketThemeSpec[] = [
  {
    id: "semiconductors",
    queries: ["semiconductor tariff", "chip export"],
    industryMatch: /semiconductor/i,
    kindHint: "tariff"
  },
  {
    id: "ai",
    queries: ["artificial intelligence regulation", "AI chip"],
    sectorMatch: /technology|information technology/i,
    industryMatch: /software|internet|semiconductor/i,
    kindHint: "regulation"
  },
  {
    id: "energy",
    queries: ["WTI oil", "OPEC"],
    sectorMatch: /^energy$/i,
    kindHint: "oil"
  },
  {
    id: "finance",
    queries: ["bank stress", "regional bank"],
    sectorMatch: /financial/i
  },
  {
    id: "defense",
    queries: ["NATO spending", "defense spending"],
    industryMatch: /aerospace|defense/i
  }
];

export const POLYMARKET_MACRO_CATALOG: PolymarketMacroSpec[] = [
  { id: "us_recession", queries: ["US recession"], kind: "recession" },
  { id: "fed_cuts", queries: ["Fed rate cuts"], kind: "fed_cut" },
  { id: "us_cpi", queries: ["US CPI", "US inflation"], kind: "inflation" },
  { id: "wti_oil", queries: ["WTI oil"], kind: "oil" }
];

const US_SCOPE_RE = /\bU\.?S\.?\b|\bUnited States\b|\bFed\b|\bFOMC\b|\bWTI\b|\bOPEC\b/i;

export function classifyMarketKind(question: string): PolymarketMarketKind {
  const q = question.toLowerCase();
  if (/\bearnings\b|\bbeat (eps|earnings|estimates)\b/.test(q)) return "earnings_beat";
  if (/\bwti\b|\boil price|\bbrent\b|\bopec\b/.test(q)) return "oil";
  if (/\b(close|above|below)\b.*\$|\bprice (above|below)\b/.test(q)) return "price_above";
  if (/\brecession\b/.test(q)) return "recession";
  if (/\bfed\b.*\bhike|\brate hike/.test(q)) return "fed_hike";
  if (/\bfed\b.*\bcut|\brate cut|\bno (fed )?rate cuts/.test(q)) return "fed_cut";
  if (/\binflation\b|\bcpi\b|\bpce\b/.test(q)) return "inflation";
  if (/\btariff\b/.test(q)) return "tariff";
  if (/\bregulat|\bantitrust\b|\bbreak[\s-]?up\b/.test(q)) return "regulation";
  return "other";
}

export function yesImpliesForKind(kind: PolymarketMarketKind): PolymarketEquityTilt {
  switch (kind) {
    case "earnings_beat":
    case "price_above":
      return "bullish";
    case "recession":
    case "fed_hike":
    case "inflation":
    case "tariff":
    case "regulation":
      return "bearish";
    case "fed_cut":
      return "bullish";
    case "oil":
      return "unclear";
    default:
      return "unclear";
  }
}

export function crowdLeanFromYes(yesPct: number): PolymarketCrowdLean {
  if (!Number.isFinite(yesPct)) return "near_even";
  if (Math.abs(yesPct - 50) < 10) return "near_even";
  return yesPct >= 60 ? "yes_favored" : yesPct <= 40 ? "no_favored" : "near_even";
}

export function flipTilt(tilt: PolymarketEquityTilt): PolymarketEquityTilt {
  if (tilt === "bullish") return "bearish";
  if (tilt === "bearish") return "bullish";
  return tilt;
}

export function tiltFrom(
  yesImplies: PolymarketEquityTilt,
  crowdLean: PolymarketCrowdLean,
  bookDepth: PolymarketBookDepth
): PolymarketEquityTilt {
  if (yesImplies === "unclear") return "unclear";
  if (bookDepth === "thin") return "neutral";
  if (crowdLean === "near_even") return "neutral";
  if (crowdLean === "yes_favored") return yesImplies;
  return flipTilt(yesImplies);
}

export function bookDepthFrom(volume24h?: number, volumeTotal?: number): PolymarketBookDepth {
  const vol = typeof volume24h === "number" && volume24h > 0 ? volume24h : volumeTotal ?? 0;
  if (vol < 1_000) return "thin";
  if (vol < 50_000) return "ok";
  return "deep";
}

export function isUsScopedQuestion(question: string): boolean {
  return US_SCOPE_RE.test(question);
}

export function themesForQuote(input: { sector?: string; industry?: string }): PolymarketThemeSpec[] {
  const sector = input.sector ?? "";
  const industry = input.industry ?? "";
  return POLYMARKET_THEME_CATALOG.filter((theme) => {
    const sectorHit = theme.sectorMatch ? theme.sectorMatch.test(sector) : false;
    const industryHit = theme.industryMatch ? theme.industryMatch.test(industry) : false;
    if (theme.industryMatch && theme.sectorMatch) return industryHit || sectorHit;
    if (theme.industryMatch) return industryHit;
    if (theme.sectorMatch) return sectorHit;
    return false;
  });
}

export function parseYesNoPercents(outcomes: string[], prices: number[]): { yesPct: number; noPct?: number } | undefined {
  let yesIdx = -1;
  let noIdx = -1;
  for (let i = 0; i < outcomes.length; i++) {
    const label = outcomes[i]?.trim().toLowerCase();
    if (label === "yes") yesIdx = i;
    if (label === "no") noIdx = i;
  }
  if (yesIdx < 0 || !Number.isFinite(prices[yesIdx])) return undefined;
  const yesPct = Math.round(prices[yesIdx] * 1000) / 10;
  const noPct = noIdx >= 0 && Number.isFinite(prices[noIdx]) ? Math.round(prices[noIdx] * 1000) / 10 : undefined;
  return { yesPct, noPct };
}
