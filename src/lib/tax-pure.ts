/** Client-safe tax display helpers — no db / performance imports. */

/** When `subtractFromResults` is on, show realized P&L net of estimated tax liability. */
export function realizedPnlNetOfEstimatedTax(
  realized: number | undefined,
  estimatedTaxLiability: number | undefined,
  subtractFromResults: boolean
): number | undefined {
  if (typeof realized !== "number" || !subtractFromResults) return realized;
  return Number((realized - (estimatedTaxLiability ?? 0)).toFixed(2));
}
