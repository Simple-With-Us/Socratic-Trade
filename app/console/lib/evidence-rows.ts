/** Defensive helpers for console evidence rows built from persisted snapshot shapes.
 *
 *  Audit-backed `latestScan` / strategy-run marketScan payloads are not guaranteed to be a full
 *  `MarketScan`. Historical or truncated rows can be truthy objects missing `topCandidates` (or
 *  carrying compact prompt keys). The home dashboard used to call `.slice` on that field and
 *  white-screen the whole console (`undefined is not an object (evaluating 'r.topCandidates.slice')`).
 */

import type { MarketQuote } from "@/lib/types";

/** Safe top-candidate list for evidence UI. Never throws on partial scan shapes. */
export function safeTopCandidates(scan: { topCandidates?: unknown } | null | undefined): MarketQuote[] {
  if (!scan || !Array.isArray(scan.topCandidates)) return [];
  return scan.topCandidates.filter(
    (candidate): candidate is MarketQuote =>
      Boolean(
        candidate &&
          typeof candidate === "object" &&
          typeof (candidate as MarketQuote).symbol === "string" &&
          (candidate as MarketQuote).symbol.trim().length > 0
      )
  );
}
