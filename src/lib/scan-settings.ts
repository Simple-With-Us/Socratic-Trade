export const DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT = 30;
export const MIN_MARKET_SCAN_CANDIDATE_LIMIT = 10;
export const MAX_MARKET_SCAN_CANDIDATE_LIMIT = 100;

export const DEFAULT_MARKET_SCAN_OUTLIER_RESERVE = 8;
export const MIN_MARKET_SCAN_OUTLIER_RESERVE = 0;
export const MAX_MARKET_SCAN_OUTLIER_RESERVE = 25;

export function normalizeMarketScanCandidateLimit(
  value: unknown,
  fallback = DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT
): number {
  return clampInteger(value, MIN_MARKET_SCAN_CANDIDATE_LIMIT, MAX_MARKET_SCAN_CANDIDATE_LIMIT, fallback);
}

export function normalizeMarketScanOutlierReserve(
  value: unknown,
  candidateLimit = DEFAULT_MARKET_SCAN_CANDIDATE_LIMIT,
  fallback = DEFAULT_MARKET_SCAN_OUTLIER_RESERVE
): number {
  const max = Math.min(MAX_MARKET_SCAN_OUTLIER_RESERVE, Math.max(MIN_MARKET_SCAN_OUTLIER_RESERVE, candidateLimit));
  return clampInteger(value, MIN_MARKET_SCAN_OUTLIER_RESERVE, max, Math.min(fallback, max));
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
