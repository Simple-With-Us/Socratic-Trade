import type { Portfolio } from "./types";

/** Preserve current reporting values without assigning broker proof to local estimates. */
export function finalReportingPortfolio(current: Portfolio, producerCapture: Portfolio): Portfolio {
  const final = { ...current };
  const unchanged = current.cash === producerCapture.cash &&
    current.totalMarketValue === producerCapture.totalMarketValue &&
    current.equityMarketValue === producerCapture.equityMarketValue &&
    current.optionMarketValue === producerCapture.optionMarketValue &&
    current.buyingPower === producerCapture.buyingPower;
  final.cashRequestStartedAt = unchanged ? producerCapture.cashRequestStartedAt : undefined;
  return final;
}
