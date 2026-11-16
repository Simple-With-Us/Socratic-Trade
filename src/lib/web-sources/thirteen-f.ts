/**
 * Official SEC EDGAR 13F-HR ingest for a curated superinvestor set.
 * Observe-only idea source — never auto-copies a filer's book.
 */
import { createHash } from "crypto";
import {
  audit,
  getInternalSetting,
  setInternalSetting,
  lookupTickerByCusip,
  upsertCusipTicker,
  replaceThirteenFFiling,
  purgeInvalidThirteenFPeriods,
  listThirteenFHoldingsForTicker,
  listLatestThirteenFPeriodByFiler,
  listThirteenFHoldingsForFilerPeriod,
  countThirteenFHoldings
} from "../db";
import { normalizeSymbol } from "../money";
import { resolveSourceNumber } from "../source-settings";
import { retryBackoffMs } from "./congress";
import { politeFetchText, runRateLimited, secUserAgent } from "./http";
import { padCik } from "./sec-filings";
import { persistCorpusSnapshot, thirteenFWritePath } from "../rag/corpus-layout";
import type { WebSourceRefreshResult } from "./types";

const DATASET_KEY = "webSource:13f:dataset";
const ATTEMPT_KEY = "webSource:13f:lastAttempt";
const SEC_BASE = "https://www.sec.gov";
const OPENFIGI = "https://api.openfigi.com/v3/mapping";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

export const DEFAULT_13F_FILERS: readonly { cik: string; name: string; short: string }[] = [
  { cik: "0001067983", name: "Berkshire Hathaway", short: "Berkshire" },
  { cik: "0001336528", name: "Pershing Square Capital Management", short: "Pershing" },
  { cik: "0001649339", name: "Scion Asset Management", short: "Burry" },
  { cik: "0001079114", name: "Greenlight Capital", short: "Greenlight" },
  { cik: "0001536411", name: "Duquesne Family Office", short: "Druckenmiller" },
  { cik: "0001040273", name: "Third Point", short: "Third Point" },
  { cik: "0001167483", name: "Tiger Global Management", short: "Tiger" },
  { cik: "0001135730", name: "Coatue Management", short: "Coatue" },
  { cik: "0000921669", name: "Icahn Associates", short: "Icahn" },
  { cik: "0001418814", name: "ValueAct Capital", short: "ValueAct" },
  { cik: "0001656456", name: "Appaloosa LP", short: "Tepper" },
  { cik: "0001061768", name: "Baupost Group", short: "Baupost" }
];

export interface ThirteenFInfoRow {
  cusip: string;
  issuerName: string;
  titleOfClass: string;
  shares: number;
  valueThousands: number;
  sshPrnType: string;
}

export interface ThirteenFSignal {
  bulletin: string;
  filerCount: number;
  addedBy: string[];
  increasedBy: string[];
  exitedBy: string[];
  periodEnd?: string;
}

export interface ThirteenFDataset {
  fetchedAt: string;
  recordCount: number;
  filers: number;
  /** Filers that returned rows on the last successful refresh.  Incomplete sets stay due. */
  okFilers?: string[];
}

export function thirteenFTtlMs(): number {
  const v = resolveSourceNumber("WEB_SOURCE_13F_TTL_MS");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

export function getThirteenFDataset(): ThirteenFDataset | undefined {
  return getInternalSetting<ThirteenFDataset>(DATASET_KEY);
}

export function isThirteenFRefreshDue(now: number = Date.now()): boolean {
  const lastAttempt = getInternalSetting<string>(ATTEMPT_KEY);
  if (lastAttempt && now - Date.parse(lastAttempt) < retryBackoffMs()) return false;
  const dataset = getThirteenFDataset();
  if (!dataset?.fetchedAt || dataset.recordCount <= 0) return true;
  if ((dataset.okFilers?.length ?? 0) < DEFAULT_13F_FILERS.length) return true;
  return now - Date.parse(dataset.fetchedAt) >= thirteenFTtlMs();
}

/** EDGAR cover tags may be namespaced (`ns1:cusip`) and dates are often MM-DD-YYYY. */
export function xmlTagText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<(?:[\\w]+:)?${tag}(?:\\s[^>]*)?>([^<]*)`, "i");
  const raw = xml.match(re)?.[1]?.trim();
  return raw || undefined;
}

export function normalizeEdgarDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!us) return undefined;
  return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
}

/** Latest 13F-HR accession + folder from a company atom feed. */
export function parseLatest13FFeed(atomXml: string): { dir: string; accession: string } | null {
  for (const m of atomXml.matchAll(/href="([^"]*\/Archives\/edgar\/data\/[^"]*?index[^"]*)"/g)) {
    const link = m[1];
    const accession = link.match(/(\d{10}-\d{2}-\d{6})/)?.[1];
    if (!accession) continue;
    return { dir: link.replace(/\/[^/]+$/, "/"), accession };
  }
  return null;
}

function indexXmlNames(indexJson: unknown): string[] {
  const items = (indexJson as { directory?: { item?: Array<{ name?: string }> } })?.directory?.item;
  if (!Array.isArray(items)) return [];
  return items.map((i) => i?.name ?? "").filter((n) => /\.xml$/i.test(n));
}

export function pick13FXmls(indexJson: unknown): { infoTable?: string; primary?: string } {
  const names = indexXmlNames(indexJson);
  // Do not treat form13f_YYYYMMDD.xml as the cover — that is often the information table.
  const primary = names.find((n) => /primary[_-]?doc/i.test(n));
  const namedInfo = names.find(
    (n) => n !== primary && /infoTable|informationtable|form13fInfoTable|infotable/i.test(n)
  );
  const other = names.find((n) => n !== primary && n !== namedInfo);
  return { infoTable: namedInfo ?? other, primary };
}

export function pick13FInfoTableCandidates(indexJson: unknown): string[] {
  const xmls = pick13FXmls(indexJson);
  const rest = indexXmlNames(indexJson).filter((n) => n !== xmls.infoTable && n !== xmls.primary);
  return [xmls.infoTable, ...rest].filter((n): n is string => Boolean(n));
}

export function parse13FPeriod(coverXml: string): string | undefined {
  return normalizeEdgarDate(
    xmlTagText(coverXml, "reportCalendarOrQuarter") ?? xmlTagText(coverXml, "periodOfReport")
  );
}

export function parse13FInfoTable(xml: string): ThirteenFInfoRow[] {
  const out: ThirteenFInfoRow[] = [];
  const blocks = xml.split(/<(?:[\w]+:)?infoTable[\s>]/i).slice(1);
  for (const block of blocks) {
    const cusip = (xmlTagText(block, "cusip") ?? "").replace(/\s+/g, "").toUpperCase();
    const issuerName = (xmlTagText(block, "nameOfIssuer") ?? "").replace(/\s+/g, " ").trim();
    const titleOfClass = xmlTagText(block, "titleOfClass") ?? "";
    const shares = Number(xmlTagText(block, "sshPrnamt") ?? 0);
    const valueThousands = Number(xmlTagText(block, "value") ?? 0);
    const sshPrnType = xmlTagText(block, "sshPrnamtType") ?? "SH";
    if (!cusip || !Number.isFinite(shares) || shares <= 0) continue;
    out.push({
      cusip,
      issuerName,
      titleOfClass,
      shares,
      valueThousands: Number.isFinite(valueThousands) ? valueThousands : 0,
      sshPrnType
    });
  }
  return out;
}

export function previousQuarterEnd(periodEnd: string): string {
  const [y, m] = periodEnd.split("-").map(Number);
  const month = m - 3;
  if (month > 0) {
    const last = new Date(Date.UTC(y, month, 0));
    return last.toISOString().slice(0, 10);
  }
  const last = new Date(Date.UTC(y - 1, 12 + month, 0));
  return last.toISOString().slice(0, 10);
}

export function formatThirteenFEvidenceCard(ticker: string): string {
  const rows = listThirteenFHoldingsForTicker(ticker, 24);
  if (rows.length === 0) return "";
  const lines = [`[SEC 13F holdings in ${ticker} — tracked filers, latest periods]`];
  for (const r of rows.slice(0, 16)) {
    lines.push(
      `- ${r.periodEnd}: ${r.filerName} holds ${r.shares.toLocaleString()} sh / $${Math.round(r.valueUsd).toLocaleString()} [acc: ${r.accession}]`
    );
  }
  return lines.join("\n");
}

export function getThirteenFSignals(symbols: string[]): Record<string, ThirteenFSignal> {
  const wanted = new Set(symbols.map(normalizeSymbol).filter(Boolean));
  const out: Record<string, ThirteenFSignal> = {};
  for (const symbol of wanted) {
    const current = listThirteenFHoldingsForTicker(symbol, 80);
    if (current.length === 0) continue;
    const latestPeriod = current[0].periodEnd;
    const latest = current.filter((r) => r.periodEnd === latestPeriod);
    const addedBy: string[] = [];
    const increasedBy: string[] = [];
    const exitedBy: string[] = [];
    const seenFilers = new Set<string>();
    for (const row of latest) {
      if (seenFilers.has(row.filerCik)) continue;
      seenFilers.add(row.filerCik);
      const priorPeriod = previousQuarterEnd(row.periodEnd);
      const prior = listThirteenFHoldingsForFilerPeriod(row.filerCik, priorPeriod).find(
        (p) => p.ticker === symbol || p.cusip === row.cusip
      );
      if (!prior) addedBy.push(row.filerName);
      else if (row.shares > prior.shares * 1.05) increasedBy.push(row.filerName);
    }
    const priorPeriods = listLatestThirteenFPeriodByFiler();
    for (const { filerCik, periodEnd } of priorPeriods) {
      if (periodEnd === latestPeriod) continue;
      if (latest.some((r) => r.filerCik === filerCik)) continue;
      const priorHold = listThirteenFHoldingsForFilerPeriod(filerCik, periodEnd).find((p) => p.ticker === symbol);
      if (priorHold) exitedBy.push(priorHold.filerName);
    }
    const holders = latest.map((r) => r.filerName);
    const bits: string[] = [];
    if (addedBy.length) bits.push(`opened by ${addedBy.slice(0, 3).join(", ")}`);
    if (increasedBy.length) bits.push(`increased by ${increasedBy.slice(0, 3).join(", ")}`);
    if (exitedBy.length) bits.push(`exited by ${exitedBy.slice(0, 2).join(", ")}`);
    if (bits.length === 0 && holders.length > 0) {
      bits.push(`held by ${holders.slice(0, 3).join(", ")}${holders.length > 3 ? ` +${holders.length - 3}` : ""}`);
    }
    if (bits.length === 0) continue;
    out[symbol] = {
      bulletin: `13F (${latestPeriod}): ${symbol} ${bits.join("; ")}.`,
      filerCount: holders.length,
      addedBy,
      increasedBy,
      exitedBy,
      periodEnd: latestPeriod
    };
  }
  return out;
}

export async function resolveCusipsToTickers(
  cusips: string[],
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const raw of cusips) {
    const cusip = raw.trim().toUpperCase();
    if (!cusip) continue;
    const cached = lookupTickerByCusip(cusip);
    if (cached) out[cusip] = cached;
    else missing.push(cusip);
  }
  const nowIso = new Date().toISOString();
  for (let i = 0; i < missing.length; i += 10) {
    const batch = missing.slice(i, i + 10);
    try {
      const res = await fetchImpl(OPENFIGI, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch.map((idValue) => ({ idType: "ID_CUSIP", idValue })))
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Array<{ data?: Array<{ ticker?: string; exchCode?: string }> }>;
      json.forEach((entry, idx) => {
        const ticker = entry.data?.find((d) => d.ticker)?.ticker;
        if (!ticker) return;
        const cusip = batch[idx];
        const norm = normalizeSymbol(ticker);
        if (!norm) return;
        out[cusip] = norm;
        upsertCusipTicker(cusip, norm, "openfigi", nowIso);
      });
    } catch {
      // Mapping is best-effort; holdings still persist by CUSIP.
    }
  }
  return out;
}

/**
 * Build the retrievable 13F holdings document and push it through the SAME chunk→embed→index
 * path every 10-K/10-Q uses (`storeDocument` chunks with the shared `chunkDocument`).
 *
 * 2026-09-27 B-3: this file used to write holdings as DB rows plus a text bulletin and called
 * `storeDocument` NOWHERE, so 13F positions were structurally invisible to retrieval — a
 * "what is Berkshire holding" question had no vector to hit even though the data was in the DB.
 *
 * Deliberate constraints:
 * - Capped to the top `THIRTEEN_F_EMBED_MAX_POSITIONS` positions by reported value, with the
 *   remainder summarized as a count. A 13F information table is 3,000+ rows; embedding all of
 *   it would spend the shared Pinecone write-unit budget on rows nobody queries.
 * - `publishedAt` is the FILING date taken from the EDGAR directory `last-modified` (when
 *   present), never the period end. A 13F is filed up to 45 days after the quarter it reports, so
 *   stamping the period end would let as-of retrieval show positions before they were public.
 * - Best-effort: an embed failure is logged and swallowed. The DB write above it is already
 *   durable, and a vector-store outage must not fail the whole 13F refresh.
 */
export const THIRTEEN_F_EMBED_MAX_POSITIONS = 60;

export function buildThirteenFHoldingsText(input: {
  filerName: string;
  periodEnd: string;
  rows: Array<{
    issuerName: string;
    titleOfClass: string;
    cusip: string;
    ticker: string;
    shares: number;
    valueUsd: number;
    sshPrnType: string;
  }>;
  maxPositions?: number;
}): string {
  const max = Math.max(1, input.maxPositions ?? THIRTEEN_F_EMBED_MAX_POSITIONS);
  const sorted = [...input.rows].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  const top = sorted.slice(0, max);
  const totalValue = sorted.reduce((sum, r) => sum + (r.valueUsd ?? 0), 0);
  const lines: string[] = [
    `${input.filerName} 13F-HR holdings for the quarter ended ${input.periodEnd}.`,
    `${sorted.length} reported positions, ${formatUsdCompact(totalValue)} total reported value.`,
    "A 13F is a long-gated institutional position report: positions are as of the quarter end,",
    "up to 45 days before the filing date, and most short positions and non-13F securities are excluded.",
    "",
    "Position - issuer (CUSIP) - shares - reported value - security type"
  ];
  for (const row of top) {
    const issuer = [row.issuerName, row.titleOfClass].filter(Boolean).join(" ");
    const ticker = row.ticker ? ` [${row.ticker}]` : "";
    lines.push(
      `${issuer}${ticker} (${row.cusip}) - ${formatShares(row.shares)} shares - ${formatUsdCompact(row.valueUsd)} - ${row.sshPrnType || "n/a"}`
    );
  }
  if (sorted.length > top.length) {
    lines.push(
      `… and ${sorted.length - top.length} further positions below the top ${top.length} by reported value, omitted for retrieval cost.`
    );
  }
  return lines.join("\n");
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function formatShares(shares: number): string {
  if (!Number.isFinite(shares) || shares <= 0) return "0";
  if (shares >= 1_000_000_000) return `${(shares / 1_000_000_000).toFixed(2)}B`;
  if (shares >= 1_000_000) return `${(shares / 1_000_000).toFixed(2)}M`;
  if (shares >= 1_000) return `${(shares / 1_000).toFixed(1)}K`;
  return `${Math.round(shares)}`;
}

/** Latest `last-modified` in an EDGAR directory index, i.e. when the filing was actually posted. */
export function pick13FFilingDate(indexJson: unknown): string | undefined {
  const items = (indexJson as { directory?: { item?: Array<{ name?: string; "last-modified"?: string }> } })
    ?.directory?.item;
  if (!Array.isArray(items)) return undefined;
  const stamps = items
    .map((item) => item?.["last-modified"])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
  const latest = stamps.at(-1);
  if (!latest) return undefined;
  const parsed = new Date(latest);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export async function storeThirteenFHoldingsDocument(input: {
  filerCik: string;
  filerName: string;
  periodEnd: string;
  accession: string;
  filedAt?: string;
  rows: Parameters<typeof buildThirteenFHoldingsText>[0]["rows"];
}): Promise<{ indexed: number; skipped?: boolean; error?: string }> {
  try {
    const { storeDocument } = await import("../vector-db");
    const text = buildThirteenFHoldingsText({
      filerName: input.filerName,
      periodEnd: input.periodEnd,
      rows: input.rows
    });
    const result = await storeDocument(
      {
        text,
        doc_id: `13f:${input.filerCik}:${input.periodEnd}`,
        title: `${input.filerName} 13F holdings (${input.periodEnd})`,
        ticker: "",
        doc_type: "13f-holdings",
        source: "sec-edgar",
        url: `https://www.sec.gov/Archives/edgar/data/${Number(input.filerCik)}/${input.accession.replace(/-/g, "")}/`,
        published_at: input.filedAt ?? `${input.periodEnd}T23:59:59.000Z`,
        ...(input.filedAt ? { acceptance_datetime: input.filedAt } : {})
      },
      "local",
      { maxTokens: 400, overlapRatio: 0.15 }
    );
    return { indexed: result.indexed ?? 0, skipped: result.skipped };
  } catch (error) {
    const message = error instanceof Error ? error.message : "13f holdings embed failed";
    console.warn(`[13f] holdings document not embedded for ${input.filerCik} ${input.periodEnd}: ${message}`);
    return { indexed: 0, error: message };
  }
}

export async function refreshThirteenF(
  now: number = Date.now(),
  force = false,
  fetchImpl: typeof fetch = fetch
): Promise<WebSourceRefreshResult> {
  if (!force && !isThirteenFRefreshDue(now)) {
    const ds = getThirteenFDataset();
    return {
      id: "13f",
      ok: true,
      recordCount: ds?.recordCount ?? countThirteenFHoldings(),
      sources: ds ? ["sec-edgar"] : [],
      fetchedAt: ds?.fetchedAt ?? "",
      skipped: true
    };
  }
  setInternalSetting(ATTEMPT_KEY, new Date(now).toISOString());
  const ua = secUserAgent();
  let warning: string | undefined;
  let ingested = 0;
  const fetchedAt = new Date(now).toISOString();
  const okFilers: string[] = [];

  const results = await runRateLimited([...DEFAULT_13F_FILERS], 250, async (filer) => {
    try {
      const atom = await politeFetchText(
        `${SEC_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${filer.cik}&type=13F-HR&count=5&output=atom`,
        { headers: { "user-agent": ua, accept: "application/atom+xml" }, timeoutMs: 15_000 }
      );
      const latest = parseLatest13FFeed(atom);
      if (!latest) return 0;
      const indexJson = JSON.parse(
        await politeFetchText(`${latest.dir}index.json`, { headers: { "user-agent": ua }, timeoutMs: 15_000 })
      );
      const xmls = pick13FXmls(indexJson);
      const candidates = pick13FInfoTableCandidates(indexJson);
      let period = "";
      if (xmls.primary) {
        const cover = await politeFetchText(`${latest.dir}${xmls.primary}`, {
          headers: { "user-agent": ua },
          timeoutMs: 15_000
        });
        period = parse13FPeriod(cover) ?? "";
      }
      if (!period) {
        warning = `13f ${filer.short}: no report calendar quarter`;
        return 0;
      }
      let infoRows: ThirteenFInfoRow[] = [];
      for (const name of candidates) {
        const infoXml = await politeFetchText(`${latest.dir}${name}`, {
          headers: { "user-agent": ua },
          timeoutMs: 20_000
        });
        infoRows = parse13FInfoTable(infoXml);
        if (infoRows.length > 0) break;
      }
      if (infoRows.length === 0) return 0;
      const tickers = await resolveCusipsToTickers(
        infoRows.map((r) => r.cusip),
        fetchImpl
      );
      const rows = infoRows.map((r) => ({
        id: createHash("sha256").update(`${latest.accession}:${r.cusip}`).digest("hex").slice(0, 32),
        filerCik: padCik(filer.cik),
        filerName: filer.short,
        periodEnd: period,
        accession: latest.accession,
        cusip: r.cusip,
        ticker: tickers[r.cusip] ?? lookupTickerByCusip(r.cusip) ?? "",
        issuerName: r.issuerName,
        titleOfClass: r.titleOfClass,
        shares: r.shares,
        valueUsd: r.valueThousands * 1000,
        sshPrnType: r.sshPrnType,
        fetchedAt
      }));
      replaceThirteenFFiling(rows);
      persistCorpusSnapshot(
        thirteenFWritePath(padCik(filer.cik), period),
        JSON.stringify({
          filerCik: padCik(filer.cik),
          filerName: filer.short,
          periodEnd: period,
          accession: latest.accession,
          fetchedAt,
          holdings: rows
        })
      );
      purgeInvalidThirteenFPeriods(padCik(filer.cik));
      okFilers.push(padCik(filer.cik));
      // 2026-09-27 B-3: make the holdings retrievable, not just countable. Best-effort and AFTER
      // the durable DB write, so an embed outage costs vectors, never the holdings.
      await storeThirteenFHoldingsDocument({
        filerCik: padCik(filer.cik),
        filerName: filer.short,
        periodEnd: period,
        accession: latest.accession,
        filedAt: pick13FFilingDate(indexJson),
        rows: rows.map((r) => ({
          issuerName: r.issuerName,
          titleOfClass: r.titleOfClass,
          cusip: r.cusip,
          ticker: r.ticker,
          shares: r.shares,
          valueUsd: r.valueUsd,
          sshPrnType: r.sshPrnType
        }))
      });
      return rows.length;
    } catch (error) {
      warning = error instanceof Error ? error.message : "13f fetch failed";
      return 0;
    }
  });
  ingested = results.reduce((s, n) => s + (n ?? 0), 0);
  const recordCount = countThirteenFHoldings();
  const ok = ingested > 0 || recordCount > 0;
  const prev = getThirteenFDataset();
  const dataset: ThirteenFDataset = {
    fetchedAt: ingested > 0 ? fetchedAt : prev?.fetchedAt ?? "",
    recordCount,
    filers: DEFAULT_13F_FILERS.length,
    okFilers
  };
  setInternalSetting(DATASET_KEY, dataset);
  audit("web_source_refresh", { id: "13f", ok, recordCount, fresh: ingested, okFilers: okFilers.length, warning });
  return { id: "13f", ok, recordCount, sources: ["sec-edgar"], fetchedAt: dataset.fetchedAt, warning };
}
