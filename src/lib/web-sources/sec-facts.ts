import * as cheerio from "cheerio";
import { getDb } from "../db";
import { politeFetch } from "./http";
import { padCik } from "./sec-filings";
import { timeSync } from "../slow-sync-guard";
import crypto from "crypto";

const SEC_DATA_BASE = "https://data.sec.gov";

/** Single-row cache of the raw companyfacts JSON blob per CIK (segment column). */
export const SEC_COMPANYFACTS_CACHE_CONCEPT = "__companyfacts_json__";

// High-yield GAAP concepts for scanning
const targetConcepts = new Set([
  "Assets",
  "Liabilities",
  "AssetsCurrent",
  "LiabilitiesCurrent",
  "Revenues",
  "SalesRevenueNet",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "NetIncomeLoss",
  "OperatingIncomeLoss",
  "LongTermDebt",
  "ShortTermBorrowings"
]);

// IFRS equivalents for admitted foreign-issuer forms (20-F/40-F report under `facts.ifrs-full`,
// not `facts.us-gaap`). Concept names differ from US-GAAP; this is the ifrs-full counterpart set.
const ifrsTargetConcepts = new Set([
  "Assets",
  "Liabilities",
  "CurrentAssets",
  "CurrentLiabilities",
  "Revenue",
  "ProfitLoss",
  "ProfitLossFromOperatingActivities"
]);

/** SEC XML encodes booleans as either "true"/"false" or the equally valid "1"/"0". */
function xmlBoolean(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Ingest all facts for a CIK from data.sec.gov/api/xbrl/companyfacts
 * and store them inside SQLite `sec_facts`.
 */
export async function ingestCompanyFacts(cik: string): Promise<void> {
  const db = getDb();
  const paddedCik = padCik(cik);
  const url = `${SEC_DATA_BASE}/api/xbrl/companyfacts/CIK${paddedCik}.json`;

  try {
    const res = await politeFetch(url, {
      headers: { "User-Agent": "Antigravity/1.0 (jay@socratic.trade)" }
    });
    if (!res.ok) {
      if (res.status === 404) return; // No facts available for CIK
      throw new Error(`Failed to fetch company facts: ${res.statusText}`);
    }

    let jsonText: string;
    if (typeof res.text === "function") {
      jsonText = await res.text();
    } else if (typeof res.json === "function") {
      const parsed = await res.json();
      jsonText = JSON.stringify(parsed);
    } else {
      throw new Error("Failed to read company facts response body");
    }
    upsertCompanyFactsCache(paddedCik, jsonText, new Date().toISOString());
    const data = JSON.parse(jsonText) as any;
    // 20-F/40-F issuers reporting under IFRS expose concepts under `facts.ifrs-full` rather than
    // `facts.us-gaap` — both taxonomies are supported inputs (the periodic-form allowlist below
    // admits 20-F/40-F), so a missing US-GAAP namespace alone is not "no data".
    const taxonomies: Array<{ name: string; facts: Record<string, unknown>; targets: Set<string> }> = [];
    if (data?.facts?.["us-gaap"]) taxonomies.push({ name: "us-gaap", facts: data.facts["us-gaap"], targets: targetConcepts });
    if (data?.facts?.["ifrs-full"]) taxonomies.push({ name: "ifrs-full", facts: data.facts["ifrs-full"], targets: ifrsTargetConcepts });
    if (taxonomies.length === 0) {
      return; // genuinely no supported taxonomy — expected no-data case
    }

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO sec_facts (
        id, cik, accession, concept, value, unit, period, start_date, end_date, accepted_at, segment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Synchronous triple-nested walk over every concept x unit x entry of a multi-MB
    // companyfacts JSON inside ONE transaction — a prime event-loop-pin suspect in the
    // 2026-08-10 stall incident; timeSync makes prod name it if so.
    timeSync("ingestCompanyFacts.factsTransaction", `cik ${paddedCik}`, () => db.transaction(() => {
      for (const { name: taxonomyName, facts: taxonomyFacts, targets } of taxonomies) {
      for (const [concept, conceptData] of Object.entries(taxonomyFacts)) {
        if (!targets.has(concept)) continue;
        const units = (conceptData as any).units;
        if (!units || typeof units !== "object") continue;

        for (const [unitName, unitEntries] of Object.entries(units)) {
          if (!Array.isArray(unitEntries)) {
            continue;
          }

          for (const entry of unitEntries) {
            if (!entry || typeof entry !== "object") {
              continue;
            }
            const val = (entry as any).val;
            const accession = (entry as any).accn;
            const end = (entry as any).end;
            const form = (entry as any).form;
            const filed = (entry as any).filed;

            // Only care about periodic forms
            if (!form || !["10-K", "10-Q", "20-F", "40-F"].includes(form)) {
              continue;
            }
            if (typeof val !== "number" || Number.isNaN(val) || !accession || !end) {
              continue;
            }

            const period = (entry as any).frame || `${(entry as any).fy || ""}-${(entry as any).fp || ""}`;
            const start = (entry as any).start || null;
            const accepted = (entry as any).filed;
            if (!accepted) continue;
            const segment = (entry as any).segment ? JSON.stringify((entry as any).segment) : null;

            // Generate deterministic ID
            const id = crypto.createHash("sha256")
              .update(`${paddedCik}:${accession}:${taxonomyName}:${concept}:${period}:${segment || ""}`)
              .digest("hex");

            insertStmt.run(
              id,
              paddedCik,
              accession,
              concept,
              val,
              unitName,
              period,
              start,
              end,
              accepted,
              segment
            );
          }
        }
      }
      }
    })());
  } catch (err: any) {
    // Only the explicit 404 no-data path above is swallowed. Operational failures — transient
    // SEC 429/500s, JSON parse errors, SQLite insert failures — must PROPAGATE so the ingest
    // worker's lease/retry (and eventually dead-letter) path re-runs this stage, instead of the
    // task silently advancing past facts extraction with no structured facts forever.
    console.error(`[sec-facts] Failed to ingest facts for CIK ${cik}:`, err?.message ?? err);
    throw err;
  }
}

/**
 * Parses Form 4 XML string using cheerio and writes entries into `sec_insider_transactions`.
 */
export function parseAndSaveForm4(
  xmlContent: string,
  cik: string,
  accession: string,
  symbol = ""
): number {
  const db = getDb();
  const $ = cheerio.load(xmlContent, { xmlMode: true });
  const paddedCik = padCik(cik);

  // Jointly filed Form 4s (trusts, funds, co-reporting insiders) carry multiple <reportingOwner>
  // elements — record every owner and attribute each transaction to each of them, with the owner
  // identity part of the row identity. SEC XML booleans are validly "1"/"0" as well as
  // "true"/"false" (xmlBoolean accepts both).
  const owners = $("reportingOwner").toArray().map((ownerEl) => {
    const name = $(ownerEl).find("reportingOwnerId > rptOwnerName").first().text().trim();
    const isOfficer = xmlBoolean($(ownerEl).find("reportingOwnerRelationship > isOfficer").first().text());
    const officerTitle = $(ownerEl).find("reportingOwnerRelationship > officerTitle").first().text().trim();
    const isDirector = xmlBoolean($(ownerEl).find("reportingOwnerRelationship > isDirector").first().text());
    const relationship = officerTitle || (isOfficer ? "Officer" : isDirector ? "Director" : "Ten Percent Owner");
    return { name, relationship };
  });
  if (owners.length === 0) {
    owners.push({ name: "", relationship: "Ten Percent Owner" });
  }

  // Real ownership XML encodes periodOfReport as direct element text; synthetic fixtures may nest
  // a <value> child. `.text()` covers both (it concatenates descendant text), trimmed.
  const periodOfReport = $("periodOfReport").first().text().trim();

  // Document-level Rule 10b5-1 checkbox (<aff10b5One>, present since the 2023 amendments) — used
  // as the fallback when a transaction carries no transaction-level indicator.
  const docLevel10b51 = xmlBoolean($("aff10b5One").first().text());

  let count = 0;

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO sec_insider_transactions (
      id, cik, accession, insider_name, relationship, side, shares, price, period_of_report, is_10b5_1, transaction_code, symbol
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    $("nonDerivativeTransaction, derivativeTransaction").each((_, el) => {
      const sharesVal = $(el).find("transactionAmounts > transactionShares > value").text().trim();
      const priceVal = $(el).find("transactionAmounts > transactionPricePerShare > value").text().trim();
      const ad = $(el).find("transactionAmounts > transactionAcquiredDisposedCode > value").text().trim(); // A or D
      // Preserve the SEC transaction code (P/S = open-market trades; A/M/G/F/... = grants,
      // exercises, gifts, tax withholding). side below is only the acquired/disposed axis, so
      // downstream insider evidence needs this code to distinguish real trades from non-trade
      // events (the legacy sec.ts parser limits trading signals to codes P and S).
      const transactionCode = $(el).find("transactionCoding > transactionCode").first().text().trim();
      const tx10b51Raw = $(el).find("transactionCoding > rule10b51Transaction").first().text().trim();
      const is10b5_1 = (tx10b51Raw ? xmlBoolean(tx10b51Raw) : docLevel10b51) ? 1 : 0;

      if (!sharesVal || !ad) return;

      const shares = parseFloat(sharesVal);
      const price = priceVal ? parseFloat(priceVal) : 0;
      if (Number.isNaN(shares) || shares <= 0) return;
      if (Number.isNaN(price) || price < 0) return;
      const side = ad === "D" ? "sell" : "buy";

      for (const owner of owners) {
        // deterministic ID for duplicate prevention — includes the owner so jointly filed
        // transactions keep one row per reporting owner.
        const id = crypto.createHash("sha256")
          .update(`${accession}:${owner.name}:${count}:${shares}:${price}:${side}`)
          .digest("hex");

        insertStmt.run(
          id,
          paddedCik,
          accession,
          owner.name,
          owner.relationship,
          side,
          shares,
          price,
          periodOfReport,
          is10b5_1,
          transactionCode,
          symbol.trim().toUpperCase()
        );
      }
      count++;
    });
  })();

  return count;
}

/** Persist the full companyfacts JSON for scan-path reads (nightly sweep + ingest worker). */
export function upsertCompanyFactsCache(cik: string, jsonText: string, fetchedAt: string): void {
  const paddedCik = padCik(cik);
  const id = crypto.createHash("sha256").update(`companyfacts-cache:${paddedCik}`).digest("hex");
  const endDate = fetchedAt.slice(0, 10);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sec_facts (
        id, cik, accession, concept, value, unit, period, start_date, end_date, accepted_at, segment
      ) VALUES (?, ?, 'cache', ?, 1, 'json', 'cache', NULL, ?, ?, ?)`
    )
    .run(id, paddedCik, SEC_COMPANYFACTS_CACHE_CONCEPT, endDate, fetchedAt, jsonText);
}

/** Read cached companyfacts JSON for a CIK (written by ingest / nightly sweep). */
export function readCompanyFactsCache(cik: string): { json: string; fetchedAt: string } | undefined {
  const paddedCik = padCik(cik);
  const row = getDb()
    .prepare(
      `SELECT segment, accepted_at FROM sec_facts WHERE cik = ? AND concept = ? LIMIT 1`
    )
    .get(paddedCik, SEC_COMPANYFACTS_CACHE_CONCEPT) as { segment: string | null; accepted_at: string } | undefined;
  if (!row?.segment) return undefined;
  return { json: row.segment, fetchedAt: row.accepted_at };
}

/**
 * Fetch companyfacts from EDGAR, cache the JSON in `sec_facts`, and ingest structured rows.
 * Used by the nightly sweep; scan-path enrichment reads the cache only.
 */
export async function fetchAndCacheCompanyFacts(cik: string): Promise<void> {
  await ingestCompanyFacts(cik);
}

/**
 * Format structured facts for a symbol into a clean narrative Evidence Card for the LLM prompt.
 */
export function formatCompanyFactsEvidenceCard(cik: string): string {
  const db = getDb();
  const paddedCik = padCik(cik);

  const facts = db.prepare(`
    SELECT concept, value, unit, period, end_date, accepted_at
    FROM sec_facts
    WHERE cik = ?
    ORDER BY end_date DESC, accepted_at DESC
    LIMIT 50
  `).all(paddedCik) as Array<{
    concept: string;
    value: number;
    unit: string;
    period: string;
    end_date: string;
    accepted_at: string;
  }>;

  if (facts.length === 0) return "";

  const lines = [`[SEC Structured Financial Facts for CIK ${paddedCik}]`];
  for (const f of facts) {
    lines.push(`- ${f.concept}: ${f.value.toLocaleString()} ${f.unit} (${f.period || f.end_date}) [filed: ${f.accepted_at}]`);
  }
  return lines.join("\n");
}

/**
 * Format structured Form 4 insider transactions for a symbol into a clean narrative Evidence Card.
 */
export function formatInsiderTransactionsEvidenceCard(cik: string, symbol?: string): string {
  const db = getDb();
  const paddedCik = padCik(cik);
  const ticker = (symbol ?? "").trim().toUpperCase();

  const txs = db.prepare(`
    SELECT insider_name, relationship, side, shares, price, period_of_report, is_10b5_1, transaction_code, accession
    FROM sec_insider_transactions
    WHERE transaction_code IN ('P', 'S')
      AND (cik = ? OR (? != '' AND symbol = ?))
    ORDER BY period_of_report DESC, price DESC
    LIMIT 30
  `).all(paddedCik, ticker, ticker) as Array<{
    insider_name: string;
    relationship: string;
    side: string;
    shares: number;
    price: number;
    period_of_report: string;
    is_10b5_1: number;
    transaction_code: string;
    accession: string;
  }>;

  if (txs.length === 0) return "";

  const lines = [`[SEC Insider Transactions (Form 4) for ${ticker || `CIK ${paddedCik}`}]`];
  for (const t of txs) {
    const codeLabel = t.transaction_code || "?";
    lines.push(
      `- ${t.period_of_report}: ${t.insider_name} (${t.relationship}) ${t.side.toUpperCase()} ${t.shares.toLocaleString()} shares @ $${t.price.toFixed(2)} [code: ${codeLabel}] (10b5-1: ${t.is_10b5_1 ? "Yes" : "No"}) [acc: ${t.accession}]`
    );
  }
  return lines.join("\n");
}

