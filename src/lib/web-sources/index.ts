// Web-sources subsystem entry point.
//
// One place for the rest of the app to:
//   - refresh due connectors (called from the scheduler tick, gated by cadence),
//   - read the per-symbol overlay (called from the market scan), and
//   - collect 1-line evidence bulletins (fed to the agent prompt).
//
// Adding a new backend source = add a connector module and register it here, then
// fold its per-symbol contribution into getSymbolWebSignals/collectEvidenceBulletins.

import {
  congressTtlMs,
  getCongressDataset,
  getCongressSignals,
  isCongressRefreshDue,
  refreshCongress
} from "./congress";
import {
  getInsiderDataset,
  getInsiderSignals,
  insiderTtlMs,
  isInsiderRefreshDue,
  refreshInsider
} from "./sec";
import {
  finraTtlMs,
  getFinraDataset,
  getShortVolumeSignals,
  isFinraRefreshDue,
  refreshFinra
} from "./finra";
import {
  eightKTtlMs,
  getEightKDataset,
  getEightKSignals,
  isEightKRefreshDue,
  refreshEightK
} from "./sec8k";
import {
  getTechnicalStatus,
  getTechnicalSignals,
  isTechnicalRefreshDue,
  refreshTechnical,
  setTechnicalWatchlist,
  technicalEnabled
} from "./technical";
import {
  congressAnalyticsEnabled,
  getCongressAnalyticsOverlay,
  isCongressAnalyticsRefreshDue,
  refreshCongressAnalytics
} from "./congress-analytics";
import { scoreCongressSignal } from "../congress-score";
import { resolveSourceBool } from "../source-settings";
import { isFilingIngestDue, refreshFilingBodies } from "./sec-filings";
import { disclosureRagEnabled, embedDisclosures } from "./disclosure-rag";
import { getFmpTranscriptStatus, type FmpTranscriptStatus } from "./fmp-transcripts";
import {
  getThirteenFDataset,
  getThirteenFSignals,
  isThirteenFRefreshDue,
  refreshThirteenF,
  thirteenFTtlMs
} from "./thirteen-f";
import {
  arkTtlMs,
  getArkDataset,
  getArkSignals,
  isArkRefreshDue,
  refreshArkHoldings
} from "./ark-holdings";
import type { SymbolWebSignal, WebSourceRefreshResult } from "./types";

export type { CongressAnalytics, CongressSignal, CongressTrade, SymbolWebSignal, WebSourceRefreshResult } from "./types";
export { getCongressAnalyticsOverlay, refreshCongressAnalytics } from "./congress-analytics";
export { getCongressDataset, getCongressSignals, refreshCongress } from "./congress";
export { getInsiderDataset, getInsiderSignals, refreshInsider } from "./sec";
export { getThirteenFDataset, getThirteenFSignals, refreshThirteenF } from "./thirteen-f";
export { getArkDataset, getArkSignals, refreshArkHoldings } from "./ark-holdings";
export { getFinraDataset, getShortVolumeSignals, refreshFinra } from "./finra";
export { getEightKDataset, getEightKSignals, refreshEightK } from "./sec8k";
export {
  getTechnicalDataset,
  getTechnicalSignals,
  getTechnicalStatus,
  getTechnicalWatchlist,
  recordTradingViewSignal,
  refreshTechnical,
  setTechnicalWatchlist,
  technicalEnabled,
  technicalSource,
  verifyWebhookSecret
} from "./technical";
export type { TechnicalSignal, TechnicalSource, TradingViewWebhookPayload } from "./technical";
export { refreshFilingBodies, isFilingIngestDue } from "./sec-filings";
export type { FilingRef, IngestResult, RefreshFilingBodiesResult } from "./sec-filings";
export {
  fmpTranscriptStorageRightsConfirmed,
  fmpTranscriptsEnabled,
  getFmpTranscriptCapability,
  getFmpTranscriptStatus,
  isFmpTranscriptRefreshDue,
  refreshFmpTranscripts
} from "./fmp-transcripts";
export type {
  FmpTranscriptCapability,
  FmpTranscriptCapabilityObservation,
  FmpTranscriptBody,
  FmpTranscriptObservation,
  FmpTranscriptRef,
  FmpTranscriptStatus,
  RefreshFmpTranscriptsResult
} from "./fmp-transcripts";

/** Whether the congress connector is enabled (default on; Settings / WEB_SOURCE_CONGRESS=off). */
function congressEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_CONGRESS");
}

/** Whether the SEC insider connector is enabled (default on; Settings / WEB_SOURCE_INSIDER=off). */
function insiderEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_INSIDER");
}

function thirteenFEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_13F");
}

function arkEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_ARK");
}

/** Whether the FINRA short-volume connector is enabled (default on; Settings / WEB_SOURCE_FINRA=off). */
function finraEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_FINRA");
}

/** Whether the SEC 8-K connector is enabled (default on; Settings / WEB_SOURCE_SEC8K=off). */
function eightKEnabled(): boolean {
  return resolveSourceBool("WEB_SOURCE_SEC8K");
}

// Guard against overlapping refreshes: the scheduler fires this fire-and-forget
// every 60s, but a scrape can take longer than a tick. Without this, a slow refresh
// could overlap the next tick's refresh and double-hit the same .gov sources.
let refreshInFlight = false;

/**
 * Refresh every due connector. Safe to call frequently (e.g. each 60s scheduler
 * tick) — each connector no-ops until its own cadence elapses, and overlapping calls
 * are skipped. Fully guarded so a scrape failure can never throw into the scheduler.
 */
export async function refreshDueWebSources(now: number = Date.now()): Promise<WebSourceRefreshResult[]> {
  if (refreshInFlight) return [];
  refreshInFlight = true;
  try {
    return await runDueRefreshes(now);
  } finally {
    refreshInFlight = false;
  }
}

async function runDueRefreshes(now: number): Promise<WebSourceRefreshResult[]> {
  const results: WebSourceRefreshResult[] = [];
  if (congressEnabled() && isCongressRefreshDue(now)) {
    try {
      results.push(await refreshCongress(now));
    } catch (error) {
      results.push({ id: "congress", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (insiderEnabled() && isInsiderRefreshDue(now)) {
    try {
      results.push(await refreshInsider(now));
    } catch (error) {
      results.push({ id: "insider", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (thirteenFEnabled() && isThirteenFRefreshDue(now)) {
    try {
      results.push(await refreshThirteenF(now));
    } catch (error) {
      results.push({ id: "13f", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (arkEnabled() && isArkRefreshDue(now)) {
    try {
      results.push(await refreshArkHoldings(now));
    } catch (error) {
      results.push({ id: "ark", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  // App A (congress.trade) analytics overlay — the Trends composite (dollar net flow, cluster buys,
  // member track-record). Network pull, so it lives here in the cadence-gated refresh; default off.
  if (congressAnalyticsEnabled() && isCongressAnalyticsRefreshDue(now)) {
    try {
      results.push(await refreshCongressAnalytics(now));
    } catch (error) {
      results.push({ id: "congress-analytics", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (finraEnabled() && isFinraRefreshDue(now)) {
    try {
      results.push(await refreshFinra(now));
    } catch (error) {
      results.push({ id: "finra", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  if (eightKEnabled() && isEightKRefreshDue(now)) {
    try {
      results.push(await refreshEightK(now));
    } catch (error) {
      results.push({ id: "sec8k", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  // Technical: only the in-house "computed" producer has anything to pull here; the
  // TradingView producer is push-fed via /api/webhooks/tradingview, so refreshTechnical
  // returns skipped in that mode.
  if (technicalEnabled() && isTechnicalRefreshDue(now)) {
    try {
      results.push(await refreshTechnical(now));
    } catch (error) {
      results.push({ id: "technical", ok: false, recordCount: 0, sources: [], fetchedAt: "", warning: error instanceof Error ? error.message : "refresh threw" });
    }
  }
  // RAG embed for congressional + insider disclosures (flag-gated, default OFF).
  // Fire-and-forget: advisory RAG only — never blocks or errors the refresh loop.
  if (disclosureRagEnabled()) {
    const congressData = getCongressDataset();
    const insiderData = getInsiderDataset();
    const trades = congressData?.trades ?? [];
    const filings = insiderData?.filings ?? [];
    embedDisclosures(trades, filings).catch((err) => {
      void import("../sentry-metrics").then(({ logError, recordEmbedFailure }) => {
        recordEmbedFailure("disclosure-rag", "refresh-embed-error");
        logError("embed.failed", {
          provider: "disclosure-rag",
          error_type: "refresh-embed-error",
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
  }
  return results;
}

/**
 * Per-symbol overlay built from cached web-source datasets (no network). Merged onto
 * quotes in the market scan. Returns only symbols that actually have a signal.
 */
export function getSymbolWebSignals(symbols: string[], now: number = Date.now()): Record<string, SymbolWebSignal> {
  const out: Record<string, SymbolWebSignal> = {};
  const congress = congressEnabled() ? getCongressSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(congress)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.congress = signal;
    entry.bulletins.push(signal.bulletin);
  }
  // App A analytics overlay (dollar net flow / cluster / member quality) — additive to the scraped
  // signal; only present when CONGRESS_ANALYTICS_ENABLED is on and the refresh has populated it.
  const analytics = congressAnalyticsEnabled() ? getCongressAnalyticsOverlay(symbols) : {};
  for (const [symbol, a] of Object.entries(analytics)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.congressAnalytics = a;
    const composite = scoreCongressSignal({ congress: entry.congress, congressAnalytics: a }, now);
    if (composite.score > 0) {
      const capped = a.convictionScore != null && composite.score < a.convictionScore ? ", confidence-capped" : "";
      entry.bulletins.push(
        `Congress.Trade advisory composite: ${composite.direction} ${composite.score}/100, coverage ${Math.round(composite.confidence * 100)}%${capped}`
      );
    }
    if (a.cluster) {
      entry.bulletins.push(
        `Congress cluster buy${a.clusterMemberCount ? ` (${a.clusterMemberCount} members)` : ""}` +
          (typeof a.netFlowUsd === "number" ? `, net $${Math.round(a.netFlowUsd).toLocaleString()}` : "")
      );
    }
    if (a.convictionScore !== null && a.convictionScore !== undefined && a.convictionDirection) {
      entry.bulletins.push(
        `Congress.Trade conviction input/pre-cap: ${a.convictionDirection} ${a.convictionScore}/100${a.convictionFallback ? " (proxy inputs)" : ""}`
      );
    }
    if (typeof a.topMemberScore === "number" && a.topMemberScore > 0) {
      const src = a.topMemberScoreSource ?? "unknown";
      const parts: string[] = [`Congress member skill: ${a.topMemberScore}/100 (${src})`];
      if (typeof a.topMemberFilingAvgExcess === "number") {
        parts.push(`filing avgExcess ${(a.topMemberFilingAvgExcess * 100).toFixed(1)}% vs SPX`);
      }
      if (typeof a.topMemberFilingWinRate === "number") {
        parts.push(`filing winRate ${(a.topMemberFilingWinRate * 100).toFixed(0)}%`);
      }
      if (typeof a.topMemberFilingScoredCount === "number") {
        parts.push(`n=${a.topMemberFilingScoredCount}`);
      }
      if (typeof a.topMemberTradeAvgExcess === "number") {
        parts.push(`trade-date avgExcess ${(a.topMemberTradeAvgExcess * 100).toFixed(1)}% (context)`);
      }
      entry.bulletins.push(parts.join(", "));
    }
    if ((a.conflictCount ?? 0) > 0) {
      entry.bulletins.push(`Congress committee-sector overlap context: ${a.conflictCount} disclosure${a.conflictCount === 1 ? "" : "s"}, legalConclusion:false`);
    }
  }
  const insider = insiderEnabled() ? getInsiderSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(insider)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.insiderSentiment = signal.insiderSentiment;
    entry.bulletins.push(signal.bulletin);
  }
  const thirteenF = thirteenFEnabled() ? getThirteenFSignals(symbols) : {};
  for (const [symbol, signal] of Object.entries(thirteenF)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.bulletins.push(signal.bulletin);
  }
  const ark = arkEnabled() ? getArkSignals(symbols) : {};
  for (const [symbol, signal] of Object.entries(ark)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.bulletins.push(signal.bulletin);
  }
  const shortVol = finraEnabled() ? getShortVolumeSignals(symbols) : {};
  for (const [symbol, signal] of Object.entries(shortVol)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.shortVolumeRatio = signal.shortVolumeRatio;
    if (signal.bulletin) entry.bulletins.push(signal.bulletin);
  }
  const eightK = eightKEnabled() ? getEightKSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(eightK)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.bulletins.push(signal.bulletin);
  }
  const technical = technicalEnabled() ? getTechnicalSignals(symbols, now) : {};
  for (const [symbol, signal] of Object.entries(technical)) {
    const entry = (out[symbol] ??= { bulletins: [] });
    entry.technical = {
      score: signal.score,
      direction: signal.direction,
      signals: signal.signals,
      tf: signal.tf,
      asOf: signal.asOf,
      source: signal.source
    };
    entry.bulletins.push(signal.bulletin);
  }
  return out;
}

/** Flat 1-line bulletins per symbol for the agent prompt (raw rows stay out of the prompt). */
export function collectEvidenceBulletins(symbols: string[], now: number = Date.now()): Record<string, string[]> {
  const signals = getSymbolWebSignals(symbols, now);
  const out: Record<string, string[]> = {};
  for (const [symbol, signal] of Object.entries(signals)) {
    if (signal.bulletins.length > 0) out[symbol] = signal.bulletins;
  }
  return out;
}

/** Health/status for the dashboard (which sources, how fresh, how many records). */
export function getWebSourcesStatus(): {
  congress: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  insider: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  finra: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
  sec8k: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  earningsTranscripts: FmpTranscriptStatus;
  technical: { enabled: boolean; source: "tradingview" | "computed"; fetchedAt?: string; recordCount: number; due: boolean; ttlMs: number; secretConfigured: boolean };
  thirteenF: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number };
  ark: { enabled: boolean; fetchedAt?: string; recordCount: number; sources: string[]; due: boolean; ttlMs: number; asOf?: string };
} {
  const congress = getCongressDataset();
  const insider = getInsiderDataset();
  const finra = getFinraDataset();
  const sec8k = getEightKDataset();
  const thirteenF = getThirteenFDataset();
  const ark = getArkDataset();
  return {
    congress: {
      enabled: congressEnabled(),
      fetchedAt: congress?.fetchedAt,
      recordCount: congress?.recordCount ?? 0,
      sources: congress?.sources ?? [],
      due: isCongressRefreshDue(),
      ttlMs: congressTtlMs()
    },
    insider: {
      enabled: insiderEnabled(),
      fetchedAt: insider?.fetchedAt,
      recordCount: insider?.recordCount ?? 0,
      sources: insider ? ["sec-edgar"] : [],
      due: isInsiderRefreshDue(),
      ttlMs: insiderTtlMs()
    },
    finra: {
      enabled: finraEnabled(),
      fetchedAt: finra?.fetchedAt,
      recordCount: finra?.recordCount ?? 0,
      sources: finra ? ["finra"] : [],
      due: isFinraRefreshDue(),
      ttlMs: finraTtlMs(),
      asOf: finra?.asOf
    },
    sec8k: {
      enabled: eightKEnabled(),
      fetchedAt: sec8k?.fetchedAt,
      recordCount: sec8k?.recordCount ?? 0,
      sources: sec8k ? ["sec-edgar"] : [],
      due: isEightKRefreshDue(),
      ttlMs: eightKTtlMs()
    },
    earningsTranscripts: getFmpTranscriptStatus(),
    technical: getTechnicalStatus(),
    thirteenF: {
      enabled: thirteenFEnabled(),
      fetchedAt: thirteenF?.fetchedAt,
      recordCount: thirteenF?.recordCount ?? 0,
      sources: thirteenF ? ["sec-edgar"] : [],
      due: isThirteenFRefreshDue(),
      ttlMs: thirteenFTtlMs()
    },
    ark: {
      enabled: arkEnabled(),
      fetchedAt: ark?.fetchedAt,
      recordCount: ark?.recordCount ?? 0,
      sources: ark ? ["ark-funds"] : [],
      due: isArkRefreshDue(),
      ttlMs: arkTtlMs(),
      asOf: ark?.asOf
    }
  };
}
