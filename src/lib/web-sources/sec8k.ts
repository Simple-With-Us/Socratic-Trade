// SEC EDGAR 8-K (material event) ingestion.
//
// An 8-K is filed when something material happens (results, exec changes, major
// agreements, etc.), so a fresh 8-K is a catalyst flag worth surfacing to the agent.
// Free, no key (UA only). We read the market-wide "current 8-K" atom feed, map each
// filer's CIK to a ticker via SEC's company_tickers.json (cached weekly), and keep a
// short rolling window of "TICKER filed an 8-K" events. Per-item label enrichment
// IS implemented: parseEightKItemsFromHtml() fetches the filing summary page and
// extracts item codes (e.g. "Item 5.02"); eightKHasMaterialItem() filters an
// expert-panel allowlist; items surface in bulletins and trigger the event-driven
// engine (`src/lib/triggers.ts`) when a material item code is detected.
// Never fabricated: no feed / no CIK match -> no event.

import { audit, getInternalSetting, setInternalSetting } from "../db";
import { hasIngestedAccession, insertIngestedAccession } from "../db";
import { normalizeSymbol } from "../money";
import { envFlagOn } from "../rag/env-flag";
import { retryBackoffMs } from "./congress";
import { politeFetchText, runRateLimited, secUserAgent, sleep } from "./http";
import { extractFilingText } from "./sec-filings";

/**
 * R10 (2026-07-01 RAG backlog): content_hash dedup for the always-on 8-K SUMMARY ingest
 * below. Default ON - avoids re-embedding the same short summary on every refresh cycle
 * even when the underlying event data hasn't changed (the Pinecone upsert is idempotent by
 * contextId, but the Voyage embed call is NOT free). Set VECTOR_STORECONTEXTS_DEDUP=off only
 * when intentionally forcing a re-embed.
 */
function storeContextsDedupEnabled(): boolean {
  return envFlagOn("VECTOR_STORECONTEXTS_DEDUP", true);
}

const DATASET_KEY = "webSource:sec8k:dataset";
const ATTEMPT_KEY = "webSource:sec8k:lastAttempt";
const CIK_KEY = "webSource:sec:cikMap";
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // daily
const CIK_TTL_MS = 7 * 24 * 60 * 60_000; // ticker↔CIK map changes slowly
const DEFAULT_WINDOW_DAYS = 4; // an 8-K is only a "fresh" catalyst for a few days
const DEFAULT_RAG_LIMIT = 16;
const SEC_BASE = "https://www.sec.gov";

export interface EightKEvent {
  symbol: string;
  filedAt: string; // ISO date
  accession: string;
  filingUrl?: string;
  items?: string[];
}
export interface EightKDataset {
  events: EightKEvent[];
  fetchedAt: string;
  recordCount: number;
}

export function eightKTtlMs(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_TTL_MS ?? DEFAULT_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}
function windowDays(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_DAYS;
}
export function eightKRagLimit(): number {
  const v = Number(process.env.WEB_SOURCE_SEC8K_RAG_LIMIT ?? DEFAULT_RAG_LIMIT);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_RAG_LIMIT;
}
export function getEightKDataset(): EightKDataset | undefined {
  return getInternalSetting<EightKDataset>(DATASET_KEY);
}

// ── Pure parsers (unit-tested) ───────────────────────────────────────────────

/** Parse the current-8-K atom feed into {cik, accession, filedAt, filingUrl} rows. */
export function parseCurrent8KFeed(atomXml: string): Array<{ cik: string; accession: string; filedAt?: string; filingUrl?: string }> {
  const out: Array<{ cik: string; accession: string; filedAt?: string; filingUrl?: string }> = [];
  const seen = new Set<string>();
  for (const entry of atomXml.split(/<entry>/i).slice(1)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "";
    const cik = title.match(/\((\d{4,10})\)/)?.[1];
    const link = entry.match(/href="([^"]+)"/i)?.[1] ?? "";
    const accession = link.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1];
    if (!cik || !accession || seen.has(accession)) continue;
    seen.add(accession);
    out.push({ cik: String(Number(cik)), accession, filedAt: updated ? updated.slice(0, 10) : undefined, filingUrl: link });
  }
  return out;
}

/** Parse SEC company_tickers.json into a numeric-CIK-string -> ticker map. */
export function parseCikTickerMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
  for (const row of rows) {
    const r = row as { cik_str?: number | string; ticker?: string };
    if (r?.cik_str == null || !r.ticker) continue;
    map[String(Number(r.cik_str))] = normalizeSymbol(r.ticker);
  }
  return map;
}

/**
 * Parse SEC company_tickers.json into a ticker -> numeric-CIK-string map. Unlike parseCikTickerMap
 * (which collapses each CIK to ONE ticker), this keeps EVERY ticker, so dual-class names that share a
 * CIK (e.g. GOOGL & GOOG) both resolve to their CIK.
 */
export function parseTickerCikMap(json: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const rows = json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
  for (const row of rows) {
    const r = row as { cik_str?: number | string; ticker?: string };
    if (r?.cik_str == null || !r.ticker) continue;
    const ticker = normalizeSymbol(r.ticker);
    if (ticker) map[ticker] = String(Number(r.cik_str));
  }
  return map;
}

// ── Read API ─────────────────────────────────────────────────────────────────

export interface EightKSignal {
  count: number;
  lastFiledAt?: string;
  bulletin: string;
}

export function getEightKSignals(symbols: string[], now: number = Date.now()): Record<string, EightKSignal> {
  const dataset = getEightKDataset();
  if (!dataset?.events?.length) return {};
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const cutoff = now - windowDays() * 24 * 60 * 60_000;
  const bySymbol = new Map<string, EightKEvent[]>();
  for (const e of dataset.events) {
    if (!wanted.has(e.symbol)) continue;
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    (bySymbol.get(e.symbol) ?? bySymbol.set(e.symbol, []).get(e.symbol)!).push(e);
  }
  const out: Record<string, EightKSignal> = {};
  for (const [symbol, events] of bySymbol) {
    events.sort((a, b) => Date.parse(b.filedAt) - Date.parse(a.filedAt));
    const last = events[0]?.filedAt;
    const items = events.flatMap((event) => event.items ?? []).slice(0, 3);
    const itemText = items.length > 0 ? ` Items: ${items.join("; ")}.` : "";
    out[symbol] = {
      count: events.length,
      lastFiledAt: last,
      bulletin: `Catalyst: ${symbol} filed ${events.length > 1 ? `${events.length} 8-Ks` : "an 8-K"} (material event) ${last ? `on ${last}` : "recently"}.${itemText} Check for fresh news.`
    };
  }
  return out;
}

// ── Refresh ──────────────────────────────────────────────────────────────────

export function isEightKRefreshDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const ds = getEightKDataset();
  if (!ds?.fetchedAt) return true;
  return now - Date.parse(ds.fetchedAt) >= eightKTtlMs();
}

// Shared in-flight promises for the cold company_tickers.json fetch. Both maps derive from the SAME
// SEC file; without these guards, concurrent scans (or repeated dashboard refreshes) that all miss the
// weekly cache would each fire a duplicate request and defeat SEC fair-access throttling. A pending load
// is shared across callers and cleared once settled, so a later cache expiry re-fetches.
let cikMapInFlight: Promise<Record<string, string>> | null = null;
let tickerCikMapInFlight: Promise<Record<string, string>> | null = null;

/** Load the CIK→ticker map, cached weekly in the settings KV. */
export async function loadCikMap(now: number): Promise<Record<string, string>> {
  const cached = getInternalSetting<{ map: Record<string, string>; fetchedAt: string }>(CIK_KEY);
  if (cached?.map && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CIK_TTL_MS) return cached.map;
  if (cikMapInFlight) return cikMapInFlight;
  cikMapInFlight = (async () => {
    const json = JSON.parse(await politeFetchText(`${SEC_BASE}/files/company_tickers.json`, { headers: { "user-agent": secUserAgent() } }));
    const map = parseCikTickerMap(json);
    if (Object.keys(map).length > 0) setInternalSetting(CIK_KEY, { map, fetchedAt: new Date(now).toISOString() });
    return map;
  })();
  try {
    return await cikMapInFlight;
  } finally {
    cikMapInFlight = null;
  }
}

const TICKER_CIK_KEY = "webSource:sec:tickerCikMap";

/** Load the ticker→CIK map (preserves dual-class tickers), cached weekly in the settings KV. */
export async function loadTickerCikMap(now: number): Promise<Record<string, string>> {
  const cached = getInternalSetting<{ map: Record<string, string>; fetchedAt: string }>(TICKER_CIK_KEY);
  if (cached?.map && cached.fetchedAt && now - Date.parse(cached.fetchedAt) < CIK_TTL_MS) return cached.map;
  if (tickerCikMapInFlight) return tickerCikMapInFlight;
  tickerCikMapInFlight = (async () => {
    const json = JSON.parse(await politeFetchText(`${SEC_BASE}/files/company_tickers.json`, { headers: { "user-agent": secUserAgent() } }));
    const map = parseTickerCikMap(json);
    if (Object.keys(map).length > 0) setInternalSetting(TICKER_CIK_KEY, { map, fetchedAt: new Date(now).toISOString() });
    return map;
  })();
  try {
    return await tickerCikMapInFlight;
  } finally {
    tickerCikMapInFlight = null;
  }
}

export function mergeEightK(existing: EightKEvent[], fresh: EightKEvent[], now: number, window = windowDays()): EightKEvent[] {
  const cutoff = now - window * 24 * 60 * 60_000;
  const byAccession = new Map<string, EightKEvent>();
  for (const e of [...existing, ...fresh]) {
    const ts = Date.parse(e.filedAt);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    byAccession.set(e.accession, e);
  }
  return Array.from(byAccession.values());
}

function absoluteSecUrl(url?: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${SEC_BASE}${url}`;
  return `${SEC_BASE}/${url}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseEightKItemsFromHtml(html: string): string[] {
  const items = new Set<string>();
  const infoBlocks = html.match(/<div[^>]*class=["']info["'][^>]*>[\s\S]*?<\/div>/gi) ?? [];
  for (const block of infoBlocks) {
    const text = decodeXmlEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    for (const match of text.matchAll(/Item\s+\d+\.\d{2}\s+[^;.]+/gi)) {
      items.add(match[0].trim());
    }
  }
  for (const match of html.matchAll(/Item\s+\d+\.\d{2}\s+[^<\n\r;.]+/gi)) {
    items.add(decodeXmlEntities(match[0].replace(/\s+/g, " ").trim()));
  }
  return Array.from(items).slice(0, 8);
}

async function enrichEightKEvents(events: EightKEvent[]): Promise<EightKEvent[]> {
  const limit = Number(process.env.WEB_SOURCE_SEC8K_DETAIL_LIMIT ?? 25);
  const maxDetails = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const slice = events.slice(0, maxDetails);
  const enriched = await runRateLimited(slice, 250, async (event) => {
    const url = absoluteSecUrl(event.filingUrl);
    if (!url) return event;
    try {
      const html = await politeFetchText(url, { headers: { "user-agent": secUserAgent(), accept: "text/html" } });
      const items = parseEightKItemsFromHtml(html);
      return items.length > 0 ? { ...event, filingUrl: url, items } : { ...event, filingUrl: url };
    } catch {
      return { ...event, filingUrl: url };
    }
  });
  return [...enriched, ...events.slice(maxDetails)];
}

// 8-K item codes that are genuinely tradeable-material (expert panel). Most 8-Ks (5.07 votes,
// 9.01 exhibits, 5.03 bylaws, routine 8.01 PR) are noise and intentionally excluded.
const MATERIAL_8K_ITEMS = new Set(["1.01", "1.02", "1.03", "2.01", "2.02", "4.01", "4.02", "5.02"]);

export function eightKHasMaterialItem(event: EightKEvent): boolean {
  const items = event.items ?? [];
  for (const item of items) {
    const code = item.match(/(\d+\.\d{2})/)?.[1];
    if (code && MATERIAL_8K_ITEMS.has(code)) return true;
  }
  return false;
}

export function buildEightKContext(event: EightKEvent): string {
  return [
    `SEC 8-K filing for ${event.symbol}.`,
    `Filed: ${event.filedAt}.`,
    `Accession: ${event.accession}.`,
    event.items?.length ? `Reported item(s): ${event.items.join("; ")}.` : "Reported item(s): not available from the filing summary page.",
    event.filingUrl ? `SEC filing page: ${event.filingUrl}.` : "",
    "Use this as catalyst context only; infer bullish/bearish impact from item details and other market evidence."
  ].filter(Boolean).join("\n");
}

/**
 * Re-embed the *persisted* 8-K dataset into vector memory. Unlike a normal refresh (which only
 * embeds newly-`fresh` filings), this backfills everything already stored — the path used to
 * recover after the Voyage-billing 429 left the Pinecone index empty. Returns the embed/upsert
 * outcome so a caller (e.g. the reindex route) can confirm `indexed > 0`.
 */
export async function reindexEightKDataset(
  userId: string = "local",
  limit: number = Number.POSITIVE_INFINITY
): Promise<{ attempted: number; indexed: number; error?: string; skipped?: boolean }> {
  const dataset = getEightKDataset();
  const events = dataset?.events ?? [];
  if (events.length === 0) return { attempted: 0, indexed: 0 };
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : events.length;
  const slice = events.slice(0, cap);
  const { storeContexts } = await import("../vector-db");
  return storeContexts(
    slice.map((event) => ({
      text: buildEightKContext(event),
      metadata: {
        symbol: event.symbol,
        source: "sec-8k",
        timestamp: event.filedAt,
        // Point-in-time anchor so retrieveContextDetailed({asOf}) can exclude look-ahead filings.
        acceptance_datetime: event.filedAt,
        doc_type: "8-k",
        accession: event.accession,
        filingUrl: event.filingUrl,
        items: event.items ?? []
      }
    })),
    userId
  );
}

export async function refreshEightK(now: number = Date.now(), force = false): Promise<import("./types").WebSourceRefreshResult> {
  if (!force && !isEightKRefreshDue(now)) {
    const ds = getEightKDataset();
    return { id: "sec8k", ok: true, recordCount: ds?.recordCount ?? 0, sources: ds ? ["sec-edgar"] : [], fetchedAt: ds?.fetchedAt ?? "", skipped: true };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  let fresh: EightKEvent[] = [];
  let warning: string | undefined;
  try {
    const cikMap = await loadCikMap(now);
    const feed = await politeFetchText(
      `${SEC_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom`,
      { headers: { "user-agent": secUserAgent(), accept: "application/atom+xml" } }
    );
    fresh = parseCurrent8KFeed(feed)
      .map((row): EightKEvent | undefined => {
        const symbol = cikMap[row.cik];
        if (!symbol) return undefined;
        return { symbol, filedAt: row.filedAt ?? new Date(now).toISOString().slice(0, 10), accession: row.accession, ...(row.filingUrl ? { filingUrl: row.filingUrl } : {}) };
      })
      .filter((event): event is EightKEvent => Boolean(event));
    fresh = await enrichEightKEvents(fresh);
  } catch (error) {
    warning = error instanceof Error ? error.message : "sec8k failed";
  }

  const prior = getEightKDataset();
  const merged = mergeEightK(prior?.events ?? [], fresh, now);
  if (merged.length === 0) {
    audit("web_source_refresh", { id: "sec8k", ok: false, recordCount: 0, warning });
    return { id: "sec8k", ok: false, recordCount: 0, sources: [], fetchedAt: prior?.fetchedAt ?? "", warning: warning ?? "no events" };
  }
  const fetchedAt = fresh.length > 0 ? new Date(now).toISOString() : (prior?.fetchedAt ?? new Date(now).toISOString());
  const dataset: EightKDataset = { events: merged, fetchedAt, recordCount: merged.length };
  setInternalSetting(DATASET_KEY, dataset);
  const ok = fresh.length > 0;
  audit("web_source_refresh", { id: "sec8k", ok, recordCount: merged.length, fresh: fresh.length, warning });

  // Event-driven trigger (Phase 2): a fresh 8-K with a MATERIAL item code is a catalyst worth a
  // strategy run. No-op unless TRIGGER_ENGINE is on (dynamic import breaks the strategy↔web-sources
  // import cycle). Item allowlist per the expert panel — most 8-Ks (5.07/9.01/5.03/routine 8.01)
  // are non-tradeable and must not trigger.
  const materialFresh = fresh.filter(eightKHasMaterialItem);
  if (materialFresh.length > 0) {
    import("../triggers")
      .then(({ broadcastMaterialEvent }) => {
        for (const ev of materialFresh) {
          broadcastMaterialEvent({ type: "sec8k", symbol: ev.symbol, sourceId: ev.accession, reason: `8-K ${ev.items?.[0] ?? ""}`.trim() });
        }
      })
      .catch(() => { /* triggers unavailable — refresh durability is unaffected */ });
  }

  // Store new filings into vector DB for RAG. This is best-effort and batched so refresh
  // durability does not depend on Pinecone/Voyage availability.
  if (fresh.length > 0) {
    const ragEvents = fresh.slice(0, eightKRagLimit());
    import("../vector-db")
      .then(({ storeContexts }) =>
        storeContexts(
          ragEvents.map((event) => ({
            text: buildEightKContext(event),
            metadata: {
              symbol: event.symbol,
              source: "sec-8k",
              timestamp: event.filedAt,
              // Point-in-time anchor so retrieveContextDetailed({asOf}) can exclude look-ahead filings.
              acceptance_datetime: event.filedAt,
              doc_type: "8-k",
              accession: event.accession,
              filingUrl: event.filingUrl,
              items: event.items ?? []
            }
          })),
          "local",
          // R10: dedup so an unchanged summary isn't re-embedded every refresh cycle.
          storeContextsDedupEnabled() ? { dedupKeyPrefix: "sec8k-summary" } : undefined
        )
      )
      .catch((error) => console.warn("[sec8k] vector store failed", error));
  }

  // 8-K full-body ingest: when enabled, fetch + embed the FULL filing text (not just the
  // 6-line summary) via the same storeDocument pipeline as 10-K/10-Qs. Gated behind
  // WEB_SOURCE_SEC8K_FULL_BODY (default OFF) because it multiplies EDGAR fetch + Voyage
  // cost per filing. Fire-and-forget so refresh durability is unaffected.
  if (eightKFullBodyEnabled() && fresh.length > 0) {
    const bodyLimit = Number(process.env.WEB_SOURCE_SEC8K_FULL_BODY_LIMIT ?? 5);
    const cap = Number.isFinite(bodyLimit) && bodyLimit > 0 ? Math.floor(bodyLimit) : 5;
    const bodyEvents = fresh.slice(0, cap);
    // Don't block the refresh — body ingest runs async.
    ingestEightKBodies(bodyEvents, now).catch((error) =>
      console.warn("[sec8k] full-body ingest failed:", error)
    );
  }

  return { id: "sec8k", ok, recordCount: merged.length, sources: ["sec-edgar"], fetchedAt, warning };
}

// ── 8-K full-body ingest (gated behind WEB_SOURCE_SEC8K_FULL_BODY) ───────────

const DEFAULT_SEC8K_FULL_BODY_LIMIT = 5;

/** Whether full 8-K body ingestion is enabled (default OFF). */
export function eightKFullBodyEnabled(): boolean {
  const v = String(process.env.WEB_SOURCE_SEC8K_FULL_BODY ?? "off").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(v);
}

/**
 * Fetch the full 8-K filing body for one event, chunk it via storeDocument, and record
 * the accession in ingested_accessions so the same filing is never re-fetched.
 *
 * Only calls storeDocument when the accession isn't already in ingested_accessions.
 * Returns the number of chunks indexed (0 = skipped or failed).
 */
export async function ingestEightKBody(event: EightKEvent, now: number = Date.now()): Promise<{ skipped: boolean; chunks: number; error?: string }> {
  if (hasIngestedAccession(event.accession, "8-K-body")) {
    return { skipped: true, chunks: 0 };
  }

  const url = absoluteSecUrl(event.filingUrl);
  if (!url) {
    return { skipped: false, chunks: 0, error: "no filing URL" };
  }

  let html: string;
  try {
    html = await politeFetchText(url, {
      headers: { "user-agent": secUserAgent(), accept: "text/html,application/xhtml+xml" },
      timeoutMs: 30_000
    });
  } catch (err) {
    return { skipped: false, chunks: 0, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = extractFilingText(html);
  if (text.length < 100) {
    return { skipped: false, chunks: 0, error: "extracted text too short" };
  }

  const { storeDocument } = await import("../vector-db");
  const result = await storeDocument(
    {
      text,
      ticker: event.symbol,
      title: `${event.symbol} 8-K (${event.filedAt})`,
      doc_type: "8-k",
      published_at: event.filedAt,
      acceptance_datetime: event.filedAt,
      source: "sec-8k",
      url
    },
    "local"
  );

  if (result.error) {
    return { skipped: false, chunks: result.indexed, error: result.error };
  }

  insertIngestedAccession(event.accession, "8-K-body", event.symbol, result.indexed);
  return { skipped: false, chunks: result.indexed };
}

/**
 * Ingest full 8-K bodies for multiple events sequentially (respects EDGAR fair-use).
 * Never throws — errors are logged and aggregated.
 */
export async function ingestEightKBodies(
  events: EightKEvent[],
  now: number = Date.now()
): Promise<{ attempted: number; ingested: number; skipped: number; errors: string[] }> {
  const result = { attempted: 0, ingested: 0, skipped: 0, errors: [] as string[] };
  for (const event of events) {
    result.attempted++;
    try {
      const ingestResult = await ingestEightKBody(event, now);
      if (ingestResult.skipped) {
        result.skipped++;
      } else if (ingestResult.error) {
        result.errors.push(`${event.symbol} ${event.accession}: ${ingestResult.error}`);
      } else {
        result.ingested++;
      }
      // Polite delay between EDGAR fetches
      if (result.attempted < events.length) await sleep(300);
    } catch (err) {
      result.errors.push(`${event.symbol} ${event.accession}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
