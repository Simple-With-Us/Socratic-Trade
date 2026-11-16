// Advisory strategy-overlay router. Selects 1-N owner-authored instruction
// templates whose market_regimes match the current classifyMarketRegime tag
// (or "any"), sorted by priority. Pure — no DB. Overlays are DATA, never able
// to override risk limits (same trust tier as ownerCoaching).

import { regimeFromLabel, type MarketRegime } from "./market-regime";

export type OverlayRegimeTag = MarketRegime | "any";

export interface StrategyOverlay {
  id: string;
  name: string;
  marketRegimes: OverlayRegimeTag[];
  instructions: string;
  priority: number;
  enabled: boolean;
}

export interface SelectActiveOverlaysOptions {
  overlays: StrategyOverlay[];
  regime: MarketRegime | string;
  maxCount?: number;
}

export function parseOverlayRegimes(raw: unknown): OverlayRegimeTag[] {
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value).trim())
      .filter((value): value is OverlayRegimeTag => value.length > 0) as OverlayRegimeTag[];
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseOverlayRegimes(JSON.parse(raw));
    } catch {
      return raw
        .split(",")
        .map((value) => value.trim())
        .filter((value): value is OverlayRegimeTag => value.length > 0) as OverlayRegimeTag[];
    }
  }
  return ["any"];
}

const REGIME_ENUMS = new Set<string>(["crisis", "risk-off", "cautious-inverted", "neutral", "risk-on", "unknown"]);

/** Accepts a typed enum or a persisted `determineMarketRegime` label. */
export function normalizeOverlayRegime(regime: string | undefined): OverlayRegimeTag {
  const raw = String(regime ?? "").trim();
  if (!raw) return "unknown";
  if (raw === "any") return "any";
  if (REGIME_ENUMS.has(raw)) return raw as OverlayRegimeTag;
  return regimeFromLabel(raw);
}

function matchesRegime(overlay: StrategyOverlay, regime: string): boolean {
  const tags = overlay.marketRegimes.length > 0 ? overlay.marketRegimes : (["any"] as OverlayRegimeTag[]);
  const normalized = normalizeOverlayRegime(regime);
  return tags.includes("any") || tags.includes(normalized);
}

/**
 * Enabled overlays whose tags include the current regime or "any", sorted by
 * priority ascending (lower number = first), then name. Empty match returns [].
 */
export function selectActiveOverlays(input: SelectActiveOverlaysOptions): StrategyOverlay[] {
  const maxCount = Math.max(0, Math.floor(input.maxCount ?? 2));
  if (maxCount <= 0) return [];
  const regime = String(input.regime || "unknown");
  return input.overlays
    .filter((overlay) => overlay.enabled !== false)
    .filter((overlay) => matchesRegime(overlay, regime))
    .filter((overlay) => typeof overlay.instructions === "string" && overlay.instructions.trim().length > 0)
    .sort((a, b) => {
      const byPriority = (a.priority ?? 100) - (b.priority ?? 100);
      if (byPriority !== 0) return byPriority;
      return a.name.localeCompare(b.name);
    })
    .slice(0, maxCount);
}
