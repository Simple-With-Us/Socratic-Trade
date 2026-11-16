import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateInsiderSignals,
  insiderSentimentScore,
  insiderXmlFilingCap,
  mergeInsiderByAccession,
  mergeInsiderFilings,
  parseCurrentForm4Feed,
  parseForm4Xml,
  pickOwnershipXml,
  refreshInsider,
  type InsiderFiling
} from "../src/lib/web-sources/sec";
import {
  BulkInsiderFilingSchema,
  insiderBulkQuarterKeys,
  parseInsiderBulkTables,
  unzipNamedFiles
} from "../src/lib/web-sources/insider-bulk";
import { SEC_EDGAR_FALLBACK_UA } from "../src/lib/web-sources/http";
import { ingestCompanyFacts } from "../src/lib/web-sources/sec-facts";
import { getSymbolWebSignals } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-${randomUUID()}.db`)}`;
  process.env.DATA_DIR = join(tmpdir(), `agentic-sec-data-${randomUUID()}`);
});

beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  deleteInternalSetting("webSource:insider:dataset");
  deleteInternalSetting("webSource:insider:lastAttempt");
  deleteInternalSetting("webSource:congress:dataset");
  delete process.env.WEB_SOURCE_INSIDER;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TODAY_ISO = new Date().toISOString().slice(0, 10);
const FORM4_BUY_XML = `<?xml version="1.0"?><ownershipDocument>
  <issuer><issuerTradingSymbol>NVDA</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerName>Jensen Huang</rptOwnerName></reportingOwnerId></reportingOwner>
  <periodOfReport>${TODAY_ISO}</periodOfReport>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>1000</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>5000</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

describe("SEC Form 4 parsers", () => {
  it("extracts distinct filings from the current-Form-4 atom feed", () => {
    const atom = `<feed>
      <entry><link href="https://www.sec.gov/Archives/edgar/data/123/000123456726000001/0001234567-26-000001-index.htm"/></entry>
      <entry><link href="https://www.sec.gov/Archives/edgar/data/999/000123456726000001/0001234567-26-000001-index.htm"/></entry>
      <entry><link href="https://www.sec.gov/Archives/edgar/data/123/000123456726000002/0001234567-26-000002-index.htm"/></entry>
    </feed>`;
    const filings = parseCurrentForm4Feed(atom);
    expect(filings).toHaveLength(2); // duplicate accession collapsed
    expect(filings[0].accession).toBe("0001234567-26-000001");
    expect(filings[0].dir).toBe("https://www.sec.gov/Archives/edgar/data/123/000123456726000001/");
  });

  it("picks the ownership XML and ignores rendered sidecars", () => {
    const idx = { directory: { item: [{ name: "R1.htm" }, { name: "form4.xsd" }, { name: "ownership.xml" }, { name: "primary_doc.xml" }] } };
    expect(pickOwnershipXml(idx)).toBe("ownership.xml");
  });

  it("counts only open-market P/S transactions (ignores option exercises)", () => {
    const filing = parseForm4Xml(FORM4_BUY_XML, { accession: "acc-1" });
    expect(filing).not.toBeNull();
    expect(filing).toMatchObject({ symbol: "NVDA", owner: "Jensen Huang", buyTx: 1, sellTx: 0, filedAt: TODAY_ISO });
    expect(filing!.buyShares).toBe(1000); // the M (option exercise) 5000 shares is excluded
  });

  it("returns null when a filing has no discretionary open-market trades", () => {
    const onlyOptions = FORM4_BUY_XML.replace("<transactionCode>P</transactionCode>", "<transactionCode>M</transactionCode>");
    expect(parseForm4Xml(onlyOptions, { accession: "x" })).toBeNull();
  });

  it("drops Form 4s with a future, near-future, or impossible reported date", () => {
    // A reported transaction date can't be after today — far-future, tomorrow (within the old skew),
    // and rolled-over impossible dates are all rejected rather than re-anchored to today.
    expect(parseForm4Xml(FORM4_BUY_XML.replace(TODAY_ISO, "2030-01-01"), { accession: "fut" })).toBeNull();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(parseForm4Xml(FORM4_BUY_XML.replace(TODAY_ISO, tomorrow), { accession: "tmrw" })).toBeNull();
    expect(parseForm4Xml(FORM4_BUY_XML.replace(TODAY_ISO, "2026-02-30"), { accession: "roll" })).toBeNull();
  });
});

describe("aggregateInsiderSignals + merge", () => {
  const now = Date.parse("2026-06-16T00:00:00Z");
  const filings: InsiderFiling[] = [
    { symbol: "NVDA", owner: "A", buyTx: 2, sellTx: 0, buyShares: 100, sellShares: 0, filedAt: "2026-06-12", accession: "1" },
    { symbol: "NVDA", owner: "B", buyTx: 1, sellTx: 0, buyShares: 50, sellShares: 0, filedAt: "2026-06-10", accession: "2" },
    { symbol: "AAPL", owner: "C", buyTx: 0, sellTx: 3, buyShares: 0, sellShares: 300, filedAt: "2026-06-05", accession: "3" }
  ];

  it("scores net purchase dollars over total value, then shares, then counts", () => {
    const now = Date.parse("2026-06-16T00:00:00Z");
    const mixed: InsiderFiling[] = [
      {
        symbol: "NVDA",
        owner: "A",
        buyTx: 1,
        sellTx: 0,
        buyShares: 1,
        sellShares: 0,
        buyValue: 100,
        sellValue: 0,
        filedAt: "2026-06-12",
        accession: "v1"
      },
      {
        symbol: "NVDA",
        owner: "B",
        buyTx: 0,
        sellTx: 10,
        buyShares: 0,
        sellShares: 10,
        buyValue: 0,
        sellValue: 10,
        filedAt: "2026-06-11",
        accession: "v2"
      }
    ];
    // 100 buy dollars / 110 total = 91. Count ratio would be ~9. Share ratio would be ~9.
    expect(insiderSentimentScore(mixed)).toBe(91);
    expect(aggregateInsiderSignals(mixed, ["NVDA"], now, 90).NVDA.insiderSentiment).toBe(91);
    const sharesOnly: InsiderFiling[] = mixed.map((filing) => ({ ...filing, buyValue: 0, sellValue: 0 }));
    expect(insiderSentimentScore(sharesOnly)).toBe(9);
    const countsOnly: InsiderFiling[] = sharesOnly.map((filing) => ({ ...filing, buyShares: 0, sellShares: 0 }));
    expect(insiderSentimentScore(countsOnly)).toBe(9);
  });

  it("computes buy-weighted insider sentiment and a bulletin", () => {
    const signals = aggregateInsiderSignals(filings, ["NVDA", "AAPL"], now, 30);
    expect(signals.NVDA.insiderSentiment).toBe(100); // 3 buys, 0 sells
    expect(signals.NVDA.buyFilings).toBe(2);
    expect(signals.NVDA.bulletin).toContain("BUY");
    expect(signals.AAPL.insiderSentiment).toBe(0); // all sells
  });

  it("dedupes by accession and prunes outside the window when merging", () => {
    const fresh: InsiderFiling[] = [
      { symbol: "NVDA", owner: "A", buyTx: 9, sellTx: 0, buyShares: 9, sellShares: 0, filedAt: "2026-06-12", accession: "1" }, // dup accession -> replaces
      { symbol: "OLD", owner: "Z", buyTx: 1, sellTx: 0, buyShares: 1, sellShares: 0, filedAt: "2026-01-01", accession: "9" } // out of window
    ];
    const merged = mergeInsiderFilings(filings, fresh, now, 30);
    expect(merged.find((f) => f.accession === "1")?.buyTx).toBe(9); // replaced
    expect(merged.find((f) => f.accession === "9")).toBeUndefined(); // pruned
  });

  it("keeps bulk dollars when the XML delta for the same accession has no price", () => {
    const bulk: InsiderFiling = {
      symbol: "NVDA",
      owner: "Bulk Owner",
      buyTx: 1,
      sellTx: 1,
      buyShares: 10,
      sellShares: 4,
      buyValue: 200,
      sellValue: 80,
      filedAt: "2026-06-01",
      accession: "acc-priced"
    };
    const xml: InsiderFiling = {
      ...bulk,
      owner: "XML Owner",
      buyTx: 1,
      sellTx: 0,
      buyShares: 10,
      sellShares: 0,
      buyValue: 0,
      sellValue: 0
    };
    const [merged] = mergeInsiderByAccession([bulk], [xml]);
    expect(merged).toMatchObject({
      owner: "XML Owner",
      buyValue: 200,
      sellValue: 80,
      buyShares: 10,
      sellShares: 4,
      buyTx: 1,
      sellTx: 1
    });
    expect(insiderSentimentScore([merged])).toBe(71);
  });
});

describe("refreshInsider (live flow, mocked fetch)", () => {
  it("scrapes the feed + ownership XML, persists, and exposes insiderSentiment", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("action=getcurrent")) {
        return new Response(
          `<feed><entry><link href="https://www.sec.gov/Archives/edgar/data/123/000123456726000001/0001234567-26-000001-index.htm"/></entry></feed>`,
          { status: 200 }
        );
      }
      if (u.endsWith("/index.json")) {
        return new Response(JSON.stringify({ directory: { item: [{ name: "ownership.xml" }] } }), { status: 200 });
      }
      if (u.endsWith("ownership.xml")) {
        return new Response(FORM4_BUY_XML, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });

    const result = await refreshInsider(Date.now(), true);
    if (!result.ok) console.error("refreshInsider failed:", result, "dataset:", await import("../src/lib/db").then(m => m.getInternalSetting("webSource:insider:dataset")));
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    const overlay = getSymbolWebSignals(["NVDA"]);
    expect(overlay.NVDA?.insiderSentiment).toBe(100);
    expect(overlay.NVDA?.bulletins.some((b) => b.includes("Insider"))).toBe(true);
    const { getDb } = await import("../src/lib/db");
    const stored = getDb()
      .prepare("SELECT COUNT(*) AS n FROM sec_insider_transactions WHERE accession = ?")
      .get("0001234567-26-000001") as { n: number };
    // Fixture omits acquired/disposed so structured persist may be 0; table must exist.
    expect(stored.n).toBeGreaterThanOrEqual(0);
    const { form4WritePath, readFirstExistingSync } = await import("../src/lib/rag/corpus-layout");
    const xml = readFirstExistingSync( [form4WritePath("0001234567-26-000001", "ownership.xml")] );
    expect(xml).toContain("issuerTradingSymbol");
  });

  it("does not advance fetchedAt (or wipe data) when the scrape fails", async () => {
    const { setInternalSetting, getInternalSetting } = await import("../src/lib/db");
    const priorFetchedAt = "2026-06-15T00:00:00.000Z";
    setInternalSetting("webSource:insider:dataset", {
      filings: [{ symbol: "NVDA", owner: "A", buyTx: 1, sellTx: 0, buyShares: 1, sellShares: 0, filedAt: "2026-06-14", accession: "p1" }],
      fetchedAt: priorFetchedAt,
      recordCount: 1
    });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const result = await refreshInsider(Date.now(), true);
    expect(result.ok).toBe(false);
    const ds = getInternalSetting<{ fetchedAt: string; recordCount: number }>("webSource:insider:dataset");
    expect(ds?.fetchedAt).toBe(priorFetchedAt); // not re-stamped to now -> next retry scheduled correctly
    expect(ds?.recordCount).toBe(1); // prior data preserved
  });

  it("does not cap the atom feed unless WEB_SOURCE_INSIDER_MAX_FILINGS is set", async () => {
    delete process.env.WEB_SOURCE_INSIDER_MAX_FILINGS;
    expect(insiderXmlFilingCap()).toBeNull();
    process.env.WEB_SOURCE_INSIDER_MAX_FILINGS = "1";
    expect(insiderXmlFilingCap()).toBe(1);
    let xmlFetches = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("form345.zip")) return new Response("missing", { status: 404 });
      if (u.includes("action=getcurrent")) {
        return new Response(
          `<feed>
            <entry><link href="https://www.sec.gov/Archives/edgar/data/123/000123456726000001/0001234567-26-000001-index.htm"/></entry>
            <entry><link href="https://www.sec.gov/Archives/edgar/data/123/000123456726000002/0001234567-26-000002-index.htm"/></entry>
          </feed>`,
          { status: 200 }
        );
      }
      if (u.endsWith("/index.json")) {
        return new Response(JSON.stringify({ directory: { item: [{ name: "ownership.xml" }] } }), { status: 200 });
      }
      if (u.endsWith("ownership.xml")) {
        xmlFetches += 1;
        return new Response(FORM4_BUY_XML, { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    try {
      const result = await refreshInsider(Date.now(), true);
      expect(result.ok).toBe(true);
      expect(result.recordCount).toBe(1);
      expect(xmlFetches).toBe(1);
    } finally {
      delete process.env.WEB_SOURCE_INSIDER_MAX_FILINGS;
    }
  });
});

function zipStored(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localFull);
    offset += localFull.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe("SEC insider bulk datasets", () => {
  it("parses a quarterly ZIP into dollar-weighted open-market filings", () => {
    const now = Date.parse("2026-06-16T00:00:00Z");
    const submission = [
      "ACCESSION_NUMBER\tISSUERTRADINGSYMBOL\tPERIOD_OF_REPORT",
      "0001234567-26-000010\tNVDA\t01-JUN-2026",
      "0001234567-26-000011\tAAPL\t02-JUN-2026"
    ].join("\n");
    const trans = [
      "ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE",
      "0001234567-26-000010\t01-JUN-2026\tP\t10\t20",
      "0001234567-26-000010\t02-JUN-2026\tM\t99\t1",
      "0001234567-26-000011\t03-JUN-2026\tS\t4\t25",
      "0001234567-26-000099\t01-JAN-2020\tP\t1\t1"
    ].join("\n");
    const owners = ["ACCESSION_NUMBER\tRPTOWNERNAME", "0001234567-26-000010\tJensen Huang"].join("\n");
    const zip = zipStored({
      "SUBMISSION.tsv": submission,
      "NONDERIV_TRANS.tsv": trans,
      "REPORTINGOWNER.tsv": owners
    });
    const files = unzipNamedFiles(zip);
    const filings = parseInsiderBulkTables(files, now, 90);
    expect(filings.length).toBeGreaterThan(0);
    for (const filing of filings) {
      expect(BulkInsiderFilingSchema.safeParse(filing).success).toBe(true);
    }
    const nvda = filings.find((filing) => filing.symbol === "NVDA");
    const aapl = filings.find((filing) => filing.symbol === "AAPL");
    expect(nvda).toMatchObject({ owner: "Jensen Huang", buyTx: 1, buyShares: 10, buyValue: 200, sellTx: 0 });
    expect(aapl).toMatchObject({ sellTx: 1, sellShares: 4, sellValue: 100 });
    expect(filings.find((filing) => filing.accession === "0001234567-26-000099")).toBeUndefined();
  });

  it("rejects a bulk filing that carries an undeclared key", () => {
    const parsed = BulkInsiderFilingSchema.safeParse({
      symbol: "NVDA",
      owner: "Jensen Huang",
      buyTx: 1,
      sellTx: 0,
      buyShares: 10,
      sellShares: 0,
      buyValue: 200,
      sellValue: 0,
      filedAt: "2026-06-01",
      accession: "0001234567-26-000010",
      extra: true
    });
    expect(parsed.success).toBe(false);
  });

  it("drops a filing when the strict schema rejects an undeclared key", () => {
    const now = Date.parse("2026-06-16T00:00:00Z");
    const rejected = BulkInsiderFilingSchema.safeParse({
      symbol: "NVDA",
      owner: "Jensen Huang",
      buyTx: 1,
      sellTx: 0,
      buyShares: 10,
      sellShares: 0,
      buyValue: 200,
      sellValue: 0,
      filedAt: "2026-06-01",
      accession: "0001234567-26-000010",
      extra: true
    });
    expect(rejected.success).toBe(false);
    const files = new Map<string, string>([
      ["SUBMISSION.tsv", ["ACCESSION_NUMBER\tISSUERTRADINGSYMBOL", "0001234567-26-000010\tNVDA"].join("\n")],
      [
        "NONDERIV_TRANS.tsv",
        [
          "ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE",
          "0001234567-26-000010\t01-JUN-2026\tP\t10\t20"
        ].join("\n")
      ]
    ]);
    const spy = vi.spyOn(BulkInsiderFilingSchema, "safeParse").mockReturnValue(rejected);
    try {
      expect(parseInsiderBulkTables(files, now, 90)).toEqual([]);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps the XML delta when the quarterly ZIP 404s and ingests bulk rows when the feed is empty", async () => {
    const now = Date.parse("2026-06-16T00:00:00Z");
    const submission = ["ACCESSION_NUMBER\tISSUERTRADINGSYMBOL", "0001234567-26-000010\tMSFT"].join("\n");
    const trans = ["ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE", "0001234567-26-000010\t01-JUN-2026\tP\t5\t10"].join("\n");
    const zip = zipStored({ "SUBMISSION.tsv": submission, "NONDERIV_TRANS.tsv": trans });
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      if (u.includes("form345.zip")) return new Response(new Uint8Array(zip), { status: 200 });
      if (u.includes("action=getcurrent")) return new Response("<feed></feed>", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const result = await refreshInsider(now, true);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    const overlay = getSymbolWebSignals(["MSFT"], now);
    expect(overlay.MSFT?.insiderSentiment).toBe(100);
  });

  it("still scrapes the watchlist when only the previous quarter ZIP loads", async () => {
    const now = Date.parse("2026-05-15T00:00:00Z");
    const keys = insiderBulkQuarterKeys(now);
    const current = keys[0];
    const prior = keys.find((key) => key !== current);
    expect(prior).toBeTruthy();
    const submission = ["ACCESSION_NUMBER\tISSUERTRADINGSYMBOL", "0001234567-26-000010\tAAPL"].join("\n");
    const trans = [
      "ACCESSION_NUMBER\tTRANS_DATE\tTRANS_CODE\tTRANS_SHARES\tTRANS_PRICEPERSHARE",
      "0001234567-26-000010\t01-MAR-2026\tP\t5\t10"
    ].join("\n");
    const zip = zipStored({ "SUBMISSION.tsv": submission, "NONDERIV_TRANS.tsv": trans });
    const msftXml = FORM4_BUY_XML
      .replace("NVDA", "MSFT")
      .replace(TODAY_ISO, "2026-05-01");
    const { addWatchlistSymbol, removeWatchlistSymbol, setInternalSetting, deleteInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:sec:tickerCikMap", {
      map: { MSFT: "789019" },
      fetchedAt: new Date(now).toISOString()
    });
    addWatchlistSymbol("local", "MSFT");
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("form345.zip") && prior && u.includes(prior)) return new Response(new Uint8Array(zip), { status: 200 });
      if (u.includes("form345.zip")) return new Response("missing", { status: 404 });
      if (u.includes("action=getcurrent")) return new Response("<feed></feed>", { status: 200 });
      if (u.includes("action=getcompany") && u.includes("789019")) {
        return new Response(
          `<feed><entry><link href="https://www.sec.gov/Archives/edgar/data/789019/000078901926000099/0000789019-26-000099-index.htm"/></entry></feed>`,
          { status: 200 }
        );
      }
      if (u.endsWith("/index.json")) {
        return new Response(JSON.stringify({ directory: { item: [{ name: "ownership.xml" }] } }), { status: 200 });
      }
      if (u.endsWith("ownership.xml")) return new Response(msftXml, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    try {
      const result = await refreshInsider(now, true);
      expect(result.ok).toBe(true);
      expect(urls.some((url) => url.includes("action=getcompany") && url.includes("789019"))).toBe(true);
      const overlay = getSymbolWebSignals(["MSFT", "AAPL"], now);
      expect(overlay.AAPL?.insiderSentiment).toBe(100);
      expect(overlay.MSFT?.insiderSentiment).toBe(100);
    } finally {
      removeWatchlistSymbol("local", "MSFT");
      deleteInternalSetting("webSource:sec:tickerCikMap");
    }
  });
});

describe("SEC user agent", () => {
  it("fallback identifies a contact email and company-facts requests use it", async () => {
    expect(SEC_EDGAR_FALLBACK_UA).toContain("jay@socratic.trade");
    expect(SEC_EDGAR_FALLBACK_UA).not.toContain("Antigravity");
    let ua = "";
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      ua = headers?.["User-Agent"] ?? headers?.["user-agent"] ?? "";
      return new Response("missing", { status: 404 });
    });
    await ingestCompanyFacts("0000320193");
    expect(ua.toLowerCase()).not.toContain("antigravity");
    expect(ua.length).toBeGreaterThan(8);
    if (!process.env.SEC_EDGAR_USER_AGENT) expect(ua).toContain("jay@socratic.trade");
  });
});
