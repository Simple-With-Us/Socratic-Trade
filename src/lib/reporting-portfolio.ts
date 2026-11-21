import type { Portfolio } from "./types";

/** Preserve current reporting values without assigning broker proof to local estimates. */
export function finalReportingPortfolio(current: Portfolio, producerCapture: Portfolio): Portfolio {
  const final = { ...current };
  // This proof describes cash, not price marks or available buying power.
  const unchanged = Number.isFinite(current.cash) && current.cash === producerCapture.cash;
  final.cashRequestStartedAt = unchanged ? producerCapture.cashRequestStartedAt : undefined;
  return final;
}
