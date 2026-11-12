/**
 * Decide which ingest texts may spend RAG_INGEST_MAX_TEXTS_PER_DAY.
 *
 * Units are embed windows (EMBED_REQUEST_TOKEN_BUDGET), not provider POSTs and not
 * a fraction of a short text. A reusable text (document cache, content cache, embed
 * stage, or a later copy of a text already charged in this batch) costs 0. A managed
 * commit that cannot finish inside the allowance is withheld whole: the prefix is
 * not charged, because those vectors would be aborted and would not be retrievable.
 */

export interface IngestBudgetCandidate {
  id: string;
  /** Embed windows this text costs when it is the first unpaid row of its chargeKey. */
  units: number;
  /** Vector already paid. Costs 0. */
  reusable: boolean;
  /**
   * Rows that share a chargeKey are one provider call. The first non-reusable row
   * pays `units`. Later rows with that key are kept only when the first is kept.
   */
  chargeKey: string;
}

export interface IngestBudgetSelection {
  /** Original-order ids to store. Empty when a managed commit is withheld. */
  keepIds: string[];
  /** Window sum of texts that still need a provider call. */
  requestedUnits: number;
  /** Count of texts that still need a provider call (one per chargeKey). */
  requestedTexts: number;
  /** Window sum that will actually be sent. 0 when a managed partial is withheld. */
  chargedUnits: number;
  /** True when a managed document did not fit, so no new provider call is made. */
  withheldPartialCommit: boolean;
}

export function selectIngestBudgetTexts(
  texts: readonly IngestBudgetCandidate[],
  allowedUnits: number,
  options?: { managedExpectedCount?: number }
): IngestBudgetSelection {
  const allowance = Number.isFinite(allowedUnits) ? Math.max(0, allowedUnits) : Number.POSITIVE_INFINITY;
  const seenRequest = new Set<string>();
  let requestedUnits = 0;
  let requestedTexts = 0;
  for (const text of texts) {
    if (text.reusable || seenRequest.has(text.chargeKey)) continue;
    seenRequest.add(text.chargeKey);
    requestedUnits += Math.max(0, text.units);
    requestedTexts += 1;
  }

  const affordableKeys = new Set<string>();
  const considered = new Set<string>();
  let chargedUnits = 0;
  for (const text of texts) {
    if (text.reusable || considered.has(text.chargeKey)) continue;
    considered.add(text.chargeKey);
    const cost = Math.max(0, text.units);
    if (chargedUnits + cost <= allowance) {
      affordableKeys.add(text.chargeKey);
      chargedUnits += cost;
    }
  }

  const keepIds: string[] = [];
  for (const text of texts) {
    if (text.reusable || affordableKeys.has(text.chargeKey)) keepIds.push(text.id);
  }

  const managedExpected = options?.managedExpectedCount;
  if (
    managedExpected != null &&
    keepIds.length !== managedExpected &&
    requestedUnits > chargedUnits
  ) {
    return {
      keepIds: [],
      requestedUnits,
      requestedTexts,
      chargedUnits: 0,
      withheldPartialCommit: true
    };
  }

  return {
    keepIds,
    requestedUnits,
    requestedTexts,
    chargedUnits,
    withheldPartialCommit: false
  };
}
