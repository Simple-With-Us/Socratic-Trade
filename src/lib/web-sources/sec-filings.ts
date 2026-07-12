// SEC EDGAR full-filing body ingestion (10-K / 10-Q) → storeDocument → ingested_accessions de-dup.
//
// This is the "analytical body" layer that complements the existing 8-K "catalyst flag" layer
// (sec8k.ts). The 8-K path writes 6-line summaries; this path chunks and embeds the full risk
// sections, MD&A, and financial notes for RAG-grounded reasoning.
//
// KEY DESIGN DECISIONS (owner-resolved 2026-06-21):
//  • Incremental ingest only: 1 filing per scheduler tick on free tier (VECTOR_EMBED_BATCH_DELAY_MS > 5000).
//  • Recency window: 1 most-recent 10-K + 2 most-recent 10-Qs per symbol.
//  • De-dup: ingested_accessions (accession + doc_type) is the sole gate — never re-embed.
//  • All corpus writes use userId='local' (cleanMetadata → scope:'shared', app-funded).
//  • CIK map: reused from sec8k.ts loadCikMap (named export).
//  • Gate: only ingest bodies when VECTOR_EMBED_BATCH_DELAY_MS ≤ 5000 (paid-key signal).
//    Free-tier keeps the existing 8-K-summary path UNCHANGED and skips body ingest.
//  • Errors: surface via returned error field and audit log — never swallowed silently.

import { audit, getInternalSetting, hasIngestedAccession, insertIngestedAccession, setInternalSetting } from "../db";
import { politeFetchText, runRateLimited, secUserAgent, sleep } from "./http";
import { loadCikMap } from "./sec8k";

const SEC_BASE = "https://www.sec.gov";
const EDGAR_DATA_BASE = "https://data.sec.gov";

// The TTL for the per-symbol "last attempted filing ingest" stamp.
// Weekly: 10-K/10-Q cadence is quarterly; no need to re-check before 7 days.
const FILING_INGEST_TTL_MS = 7 * 24 * 60 * 60_000;
const ATTEMPT_KEY = "webSource:sec10k:lastAttempt";

// Polite delay between per-CIK submissions-JSON fetches (300 ms per EDGAR fair-use guidance).
const CIK_POLITE_DELAY_MS = 300;

// Threshold above which we treat VECTOR_EMBED_BATCH_DELAY_MS as free-tier (unpaid Voyage).
// Default is 21_000 ms; operators with a paid key set this to 0 (or very low).
const PAID_KEY_THRESHOLD_MS = 5_000;
const DEFAULT_MAX_FILINGS_PER_RUN = 1;

export interface FilingRef {
  accession: string;   // dashed form: NNNNNNNNNN-YY-NNNNNN
  docType: "10-K" | "10-Q";
  filedAt: string;           // ISO date (YYYY-MM-DD)
  acceptanceDateTime: string; // ISO datetime
  primaryDoc: string;         // filename inside the filing (e.g. "aapl-20231231.htm")
  url: string;                // full EDGAR archive URL to the primary document
}

export interface IngestResult {
  skipped: boolean;
  chunks: number;
  error?: string;
}

export interface RefreshFilingBodiesResult {
  attempted: number;
  ingested: number;
  skipped: number;
  errors: string[];
}

// ── Submission JSON parsing ──────────────────────────────────────────────────

/** Normalise a CIK to a 10-digit zero-padded string (for EDGAR submission URL). */
export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

/** Normalise accession number: strip dashes → re-add in standard NNNNNNNNNN-YY-NNNNNN form. */
export function normalizeAccession(raw: string): string {
  const stripped = raw.replace(/-/g, "");
  if (stripped.length !== 18) return raw; // pass-through if already unusual
  return `${stripped.slice(0, 10)}-${stripped.slice(10, 12)}-${stripped.slice(12)}`;
}

/** Convert dashed accession to the no-dash form used in EDGAR archive paths. */
export function accessionNoDashes(acc: string): string {
  return acc.replace(/-/g, "");
}

interface SubmissionsRecent {
  accessionNumber?: string[];
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  primaryDocument?: string[];
}

interface SubmissionsJson {
  cik?: string | number;
  filings?: { recent?: SubmissionsRecent };
}

/**
 * Parse a EDGAR submissions JSON blob into FilingRef entries, filtering to the requested
 * docTypes and returning at most `limit` per docType (newest-first).
 */
export function parseRecentFilings(
  json: SubmissionsJson,
  cik: string,
  docTypes: Array<"10-K" | "10-Q">,
  limitPerType: number
): FilingRef[] {
  const recent = json?.filings?.recent;
  if (!recent) return [];

  const accessions = recent.accessionNumber ?? [];
  const forms = recent.form ?? [];
  const dates = recent.filingDate ?? [];
  const acceptances = recent.acceptanceDateTime ?? [];
  const primaries = recent.primaryDocument ?? [];

  const out: FilingRef[] = [];
  const countPerType: Record<string, number> = {};
  for (const dt of docTypes) countPerType[dt] = 0;

  for (let i = 0; i < accessions.length; i++) {
    const form = forms[i] as "10-K" | "10-Q" | undefined;
    if (!form || !docTypes.includes(form)) continue;
    if ((countPerType[form] ?? 0) >= limitPerType) continue;

    const acc = normalizeAccession(accessions[i] ?? "");
    if (!acc) continue;

    const filedAt = dates[i] ?? new Date().toISOString().slice(0, 10);
    const acceptanceDateTime = acceptances[i] ?? filedAt;
    const primaryDoc = primaries[i] ?? "";
    const paddedCik = padCik(cik);
    const noSlashAcc = accessionNoDashes(acc);
    const url = primaryDoc
      ? `${SEC_BASE}/Archives/edgar/data/${paddedCik}/${noSlashAcc}/${primaryDoc}`
      : `${SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${paddedCik}&type=${form}&dateb=&owner=include&count=40`;

    out.push({ accession: acc, docType: form, filedAt, acceptanceDateTime, primaryDoc, url });
    countPerType[form] = (countPerType[form] ?? 0) + 1;
  }

  return out;
}

// ── Network helpers ──────────────────────────────────────────────────────────

/**
 * Fetch the SEC EDGAR submissions JSON for a single CIK.
 * Returns undefined (does NOT throw) if the network call fails — let callers decide.
 */
export async function fetchRecentFilings(
  cik: string,
  docTypes: Array<"10-K" | "10-Q"> = ["10-K", "10-Q"],
  limitPerType = 2
): Promise<FilingRef[]> {
  const padded = padCik(cik);
  const url = `${EDGAR_DATA_BASE}/submissions/CIK${padded}.json`;
  const raw = await politeFetchText(url, {
    headers: { "user-agent": secUserAgent(), accept: "application/json" },
    timeoutMs: 15_000
  });
  const json = JSON.parse(raw) as SubmissionsJson;
  return parseRecentFilings(json, cik, docTypes, limitPerType);
}

/**
 * Fetch the primary HTM document for a single filing from EDGAR.
 * Uses a raised timeout (30s) because 10-K bodies can be 2–10 MB.
 */
export async function fetchFilingHtml(url: string): Promise<string> {
  return politeFetchText(url, {
    headers: { "user-agent": secUserAgent(), accept: "text/html,application/xhtml+xml" },
    timeoutMs: 30_000
  });
}

// ── HTML → plain text ────────────────────────────────────────────────────────

/**
 * Strip an EDGAR HTM filing down to plain text, preserving structural whitespace
 * so the chunker's blockDocument() receives well-separated paragraphs and headings.
 *
 * Pipeline:
 *  1. Strip <script> and <style> blocks entirely.
 *  2. Inject newlines around block elements so headings/paragraphs split cleanly.
 *  3. Decode XML/HTML entities.
 *  4. Strip remaining tags.
 *  5. Collapse whitespace runs.
 */
export function extractFilingText(html: string): string {
  // 1, 2, 4. Unified tag extraction in a single pass to minimize massive intermediate string allocations
  let text = html.replace(
    /(<script[\s\S]*?<\/script>)|(<style[\s\S]*?<\/style>)|(<\/?(?:div|p|h[1-6]|li|tr|td|th|table|thead|tbody|tfoot|blockquote|article|section|header|footer|main|aside|figure|figcaption|pre|hr|br)[^>]*>)|(<[^>]+>)/gi,
    (match, script, style, blockTag) => {
      if (script || style) return " ";
      if (blockTag) return "\n";
      return " ";
    }
  );

  // 3. Decode XML entities (mirrors sec8k.ts decodeXmlEntities)
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  // 5. Collapse whitespace: replace runs of spaces/tabs with a single space,
  //    preserve structural newlines (collapse 3+ newlines to 2).
  text = text
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

// ── Core ingest ──────────────────────────────────────────────────────────────

/**
 * Ingest a single filing body into the vector store.
 * - Checks ingested_accessions de-dup table first (skips if already indexed).
 * - Fetches + strips the HTM body.
 * - Calls storeDocument (which routes through chunkDocument → storeContexts).
 * - On success, records the accession in ingested_accessions.
 * - On failure, returns the error string rather than swallowing it.
 * - Always writes with userId='local' so cleanMetadata → scope:'shared'.
 */
export async function ingestFiling(
  ticker: string,
  filingRef: FilingRef,
  userId: string = "local"
): Promise<IngestResult> {
  if (hasIngestedAccession(filingRef.accession, filingRef.docType)) {
    return { skipped: true, chunks: 0 };
  }

  let html: string;
  try {
    html = await fetchFilingHtml(filingRef.url);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { skipped: false, chunks: 0, error: `fetch failed: ${error}` };
  }

  const text = extractFilingText(html);
  if (text.length < 100) {
    return { skipped: false, chunks: 0, error: "extracted text too short (possible XBRL viewer redirect)" };
  }

  const { storeDocument } = await import("../vector-db");
  const result = await storeDocument(
    {
      text,
      doc_id: `${ticker}:${filingRef.accession}:${filingRef.docType}`,
      ticker,
      title: `${ticker} ${filingRef.docType} (${filingRef.filedAt})`,
      doc_type: filingRef.docType.toLowerCase(),
      published_at: filingRef.filedAt,
      acceptance_datetime: filingRef.acceptanceDateTime,
      source: "sec-edgar",
      url: filingRef.url
    },
    userId
  );

  if (result.error) {
    return { skipped: false, chunks: result.indexed, error: result.error };
  }

  // Persist de-dup record only after successful embedding so a partial failure doesn't
  // permanently block re-ingest of the same filing.
  insertIngestedAccession(filingRef.accession, filingRef.docType, ticker, result.indexed);
  audit("sec_filing_ingest", {
    ticker,
    accession: filingRef.accession,
    docType: filingRef.docType,
    filedAt: filingRef.filedAt,
    chunks: result.indexed,
    attempted: result.attempted
  });

  return { skipped: false, chunks: result.indexed };
}

// ── Scheduler-facing refresh ─────────────────────────────────────────────────

/** Whether the free-tier cap applies (VECTOR_EMBED_BATCH_DELAY_MS > 5000 = free/default). */
function isFreeTier(): boolean {
  const delay = Number(process.env.VECTOR_EMBED_BATCH_DELAY_MS ?? 21_000);
  return !Number.isFinite(delay) || delay > PAID_KEY_THRESHOLD_MS;
}

function maxFilingsPerRunFromEnv(): number {
  const parsed = Number(process.env.SEC_FILING_RAG_MAX_PER_RUN ?? DEFAULT_MAX_FILINGS_PER_RUN);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_FILINGS_PER_RUN;
}

/** Whether we're due for a filing ingest check (weekly TTL). */
export function isFilingIngestDue(now: number = Date.now()): boolean {
  const last = getInternalSetting<string>(ATTEMPT_KEY);
  if (!last) return true;
  return now - Date.parse(last) >= FILING_INGEST_TTL_MS;
}

/**
 * Refresh 10-K/10-Q body ingestion for the given symbol list.
 *
 * Free-tier (VECTOR_EMBED_BATCH_DELAY_MS > 5000): processes at most 1 filing total per
 * invocation to avoid multi-hour scheduler stalls. The function is still called every tick but
 * the TTL gate (isFilingIngestDue) means it's a no-op until a week has passed.
 *
 * Paid-tier (VECTOR_EMBED_BATCH_DELAY_MS <= 5000): processes up to `maxPerRun` filings per
 * invocation (default: SEC_FILING_RAG_MAX_PER_RUN, or 1).
 *
 * Never throws — all errors are captured in the returned result and the audit log.
 */
export async function refreshFilingBodies(
  symbols: string[],
  now: number = Date.now(),
  maxPerRun = maxFilingsPerRunFromEnv()
): Promise<RefreshFilingBodiesResult> {
  const result: RefreshFilingBodiesResult = { attempted: 0, ingested: 0, skipped: 0, errors: [] };

  if (symbols.length === 0) return result;
  if (!isFilingIngestDue(now)) return result;

  // Mark attempt so the next tick won't immediately retry
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());

  const freeTier = isFreeTier();
  const cap = freeTier ? 1 : (Number.isFinite(maxPerRun) ? maxPerRun : Number.POSITIVE_INFINITY);

  let cikMap: Record<string, string>;
  try {
    cikMap = await loadCikMap(now);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`loadCikMap failed: ${msg}`);
    return result;
  }

  // Build a reverse map: ticker → CIK
  const tickerToCik: Record<string, string> = {};
  for (const [cik, ticker] of Object.entries(cikMap)) {
    tickerToCik[ticker] = cik;
  }

  // Collect (ticker, FilingRef) pairs that need ingesting, newest-first.
  // We do this in a rate-limited loop to avoid EDGAR bursting.
  const pending: Array<{ ticker: string; ref: FilingRef }> = [];

  await runRateLimited(symbols, CIK_POLITE_DELAY_MS, async (symbol) => {
    const cik = tickerToCik[symbol];
    if (!cik) return; // symbol not in CIK map — skip silently
    try {
      const filings = await fetchRecentFilings(cik, ["10-K", "10-Q"], 2);
      for (const ref of filings) {
        if (!hasIngestedAccession(ref.accession, ref.docType)) {
          pending.push({ ticker: symbol, ref });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`fetchRecentFilings(${symbol}): ${msg}`);
    }
  });

  // Process pending filings sequentially (EDGAR + Voyage both require polite pacing).
  for (const { ticker, ref } of pending) {
    if (result.attempted >= cap) break;
    result.attempted++;
    try {
      const ingestResult = await ingestFiling(ticker, ref);
      if (ingestResult.skipped) {
        result.skipped++;
      } else if (ingestResult.error) {
        result.errors.push(`ingestFiling(${ticker} ${ref.accession}): ${ingestResult.error}`);
      } else {
        result.ingested++;
      }
      // Polite delay between filings (separate from VECTOR_EMBED_BATCH_DELAY_MS which governs
      // chunk-level Voyage batching). Keep at least 300ms between EDGAR fetches.
      if (result.attempted < cap) await sleep(CIK_POLITE_DELAY_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`ingestFiling(${ticker} ${ref.accession}) threw: ${msg}`);
    }
  }

  audit("sec_filing_refresh", { symbols: symbols.length, ...result, freeTier });
  return result;
}
