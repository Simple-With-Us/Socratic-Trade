import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildThirteenFHoldingsText,
  parse13FInfoTable,
  parse13FPeriod,
  parseLatest13FFeed,
  pick13FFilingDate,
  pick13FXmls,
  previousQuarterEnd,
  getThirteenFSignals,
  isThirteenFRefreshDue,
  normalizeEdgarDate,
  THIRTEEN_F_EMBED_MAX_POSITIONS,
  xmlTagText
} from "../src/lib/web-sources/thirteen-f";
import {
  extractArkCsvHref,
  parseArkCsvDate,
  parseArkHoldingsCsv,
  previousArkAsOf,
  getArkSignals,
  isArkRefreshDue,
  resolveArkCsvUrl,
  ARK_FUNDS
} from "../src/lib/web-sources/ark-holdings";
import {
  replaceThirteenFFiling,
  replaceArkFundDay,
  upsertCusipTicker,
  purgeInvalidThirteenFPeriods,
  setInternalSetting
} from "../src/lib/db";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-idea-${randomUUID()}.db`)}`;
});

const INFO_XML = `<?xml version="1.0"?>
<informationTable>
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>2500000</value>
    <shrsOrPrnAmt><sshPrnamt>12000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
  <infoTable>
    <nameOfIssuer>TESLA INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>88160R101</cusip>
    <value>800000</value>
    <shrsOrPrnAmt><sshPrnamt>2000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
  </infoTable>
</informationTable>`;

const ARK_CSV = `date,fund,company,ticker,cusip,shares,market value ($),weight (%)
08/14/2026,ARKK,TESLA INC,TSLA,88160R101,"1,725,907","$586,739,343.72",9.16%
08/14/2026,ARKK,SHOPIFY INC - CLASS A,SHOP,82509L107,"1,829,471","$290,026,037.63",4.53%
`;

describe("13F parsers", () => {
  it("reads the latest 13F-HR accession from a company atom feed", () => {
    const atom = `<feed>
      <entry><link href="https://www.sec.gov/Archives/edgar/data/1067983/000095012326000111/0000950123-26-000111-index.htm"/></entry>
    </feed>`;
    expect(parseLatest13FFeed(atom)).toEqual({
      dir: "https://www.sec.gov/Archives/edgar/data/1067983/000095012326000111/",
      accession: "0000950123-26-000111"
    });
  });

  it("picks the information table XML", () => {
    const idx = { directory: { item: [{ name: "primary_doc.xml" }, { name: "form13fInfoTable.xml" }, { name: "R1.htm" }] } };
    expect(pick13FXmls(idx).infoTable).toBe("form13fInfoTable.xml");
    expect(pick13FXmls(idx).primary).toBe("primary_doc.xml");
  });

  it("parses period and info-table rows", () => {
    expect(parse13FPeriod("<reportCalendarOrQuarter>2026-03-31</reportCalendarOrQuarter>")).toBe("2026-03-31");
    expect(parse13FPeriod("<ns1:reportCalendarOrQuarter>06-30-2026</ns1:reportCalendarOrQuarter>")).toBe(
      "2026-06-30"
    );
    expect(normalizeEdgarDate("06-30-2026")).toBe("2026-06-30");
    expect(xmlTagText("<ns1:cusip>02079K305</ns1:cusip>", "cusip")).toBe("02079K305");
    const rows = parse13FInfoTable(INFO_XML);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cusip: "037833100", shares: 12_000_000, valueThousands: 2_500_000 });
    const nsRows = parse13FInfoTable(`<ns1:informationTable>
      <ns1:infoTable>
        <ns1:nameOfIssuer>ALPHABET INC</ns1:nameOfIssuer>
        <ns1:titleOfClass>CAP STK CL A</ns1:titleOfClass>
        <ns1:cusip>02079K305</ns1:cusip>
        <ns1:value>366304</ns1:value>
        <ns1:shrsOrPrnAmt><ns1:sshPrnamt>1025000</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>
      </ns1:infoTable>
    </ns1:informationTable>`);
    expect(nsRows).toHaveLength(1);
    expect(nsRows[0]).toMatchObject({ cusip: "02079K305", shares: 1_025_000, valueThousands: 366_304 });
  });

  it("picks unnamed information-table XML and does not treat form13f_YYYYMMDD as the cover", () => {
    const berkshire = {
      directory: { item: [{ name: "56757.xml" }, { name: "primary_doc.xml" }] }
    };
    expect(pick13FXmls(berkshire)).toEqual({ infoTable: "56757.xml", primary: "primary_doc.xml" });
    const druck = {
      directory: { item: [{ name: "form13f_20260630.xml" }, { name: "primary_doc.xml" }] }
    };
    expect(pick13FXmls(druck)).toEqual({ infoTable: "form13f_20260630.xml", primary: "primary_doc.xml" });
  });

  it("computes the prior quarter-end", () => {
    expect(previousQuarterEnd("2026-03-31")).toBe("2025-12-31");
    expect(previousQuarterEnd("2025-12-31")).toBe("2025-09-30");
  });

  it("emits an add bulletin when a tracked filer newly holds the name", () => {
    replaceThirteenFFiling([
      {
        id: "a1",
        filerCik: "0001067983",
        filerName: "Berkshire",
        periodEnd: "2026-03-31",
        accession: "acc-1",
        cusip: "037833100",
        ticker: "AAPL",
        issuerName: "APPLE INC",
        titleOfClass: "COM",
        shares: 12_000_000,
        valueUsd: 2_500_000_000,
        sshPrnType: "SH",
        fetchedAt: "2026-05-15T00:00:00Z"
      }
    ]);
    const signals = getThirteenFSignals(["AAPL", "MSFT"]);
    expect(signals.AAPL.bulletin).toMatch(/13F/);
    expect(signals.AAPL.bulletin).toMatch(/Berkshire/);
    expect(signals.MSFT).toBeUndefined();
  });
});

describe("ARK parsers", () => {
  it("parses official ARK CSV rows and dates", () => {
    expect(parseArkCsvDate("08/14/2026")).toBe("2026-08-14");
    const rows = parseArkHoldingsCsv(ARK_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fund: "ARKK", ticker: "TSLA", weightPct: 9.16, shares: 1_725_907 });
  });

  it("extracts the official CSV href from holdings HTML", () => {
    const href = extractArkCsvHref(
      `<a href="https://assets.ark-funds.com/fund-documents/funds-etf-csv/ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv" download>`
    );
    expect(href).toContain("ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv");
  });

  it("picks the previous as-of date", () => {
    expect(previousArkAsOf("2026-08-14", ["2026-08-13", "2026-08-12", "2026-08-14"])).toBe("2026-08-13");
  });

  it("emits an ARK bulletin for a held ticker", () => {
    upsertCusipTicker("88160R101", "TSLA", "ark-csv", "2026-08-15T00:00:00Z");
    replaceArkFundDay([
      {
        id: "k1",
        asOf: "2026-08-14",
        fund: "ARKK",
        ticker: "TSLA",
        company: "TESLA INC",
        cusip: "88160R101",
        shares: 1_725_907,
        marketValueUsd: 586_739_343.72,
        weightPct: 9.16,
        fetchedAt: "2026-08-15T00:00:00Z"
      }
    ]);
    const signals = getArkSignals(["TSLA", "MSFT"]);
    expect(signals.TSLA.bulletin).toMatch(/ARK/);
    expect(signals.TSLA.bulletin).toMatch(/ARKK|held/);
    expect(signals.MSFT).toBeUndefined();
  });

  it("stays due when ARK last wrote an empty dataset", () => {
    setInternalSetting("webSource:ark:lastAttempt", "2020-01-01T00:00:00.000Z");
    setInternalSetting("webSource:ark:dataset", {
      fetchedAt: "2026-08-15T22:06:00.179Z",
      recordCount: 0
    });
    expect(isArkRefreshDue(Date.parse("2026-08-16T12:00:00.000Z"))).toBe(true);
  });

  it("retries an empty ARK book after 2 minutes instead of 1 hour", () => {
    setInternalSetting("webSource:ark:lastAttempt", "2026-08-16T20:56:13.903Z");
    setInternalSetting("webSource:ark:dataset", { fetchedAt: "", recordCount: 0 });
    expect(isArkRefreshDue(Date.parse("2026-08-16T20:57:00.000Z"))).toBe(false);
    expect(isArkRefreshDue(Date.parse("2026-08-16T20:59:00.000Z"))).toBe(true);
  });

  it("uses the official CSV fallback when the document table is blocked", async () => {
    const url = await resolveArkCsvUrl(ARK_FUNDS[0], async () => {
      throw new Error("HTTP 403");
    });
    expect(url).toContain("ARK_INNOVATION_ETF_ARKK_HOLDINGS.csv");
  });
});

describe("13F refresh due + leftover purge", () => {
  it("stays due when a prior run missed filers or used a CIK as the period", () => {
    setInternalSetting("webSource:13f:lastAttempt", "2020-01-01T00:00:00.000Z");
    setInternalSetting("webSource:13f:dataset", {
      fetchedAt: "2026-08-15T22:06:00.179Z",
      recordCount: 210,
      filers: 12
    });
    expect(isThirteenFRefreshDue(Date.parse("2026-08-16T12:00:00.000Z"))).toBe(true);
    replaceThirteenFFiling([
      {
        id: "bad-period",
        filerCik: "0001656456",
        filerName: "Tepper",
        periodEnd: "0001656456",
        accession: "acc-bad",
        cusip: "037833100",
        ticker: "AAPL",
        issuerName: "APPLE INC",
        titleOfClass: "COM",
        shares: 1,
        valueUsd: 1,
        sshPrnType: "SH",
        fetchedAt: "2026-08-15T22:06:00.179Z"
      }
    ]);
    expect(purgeInvalidThirteenFPeriods("0001656456")).toBeGreaterThan(0);
  });
});

// 2026-09-27 B-3: 13F holdings used to be DB rows plus a text bulletin with no storeDocument call
// anywhere in the file, so the positions were invisible to retrieval. These cover the two pure
// pieces of the embedding path (the text builder and the filing-date picker); the storeDocument
// call itself is best-effort and covered by the worker's own embedding tests.
describe("13F holdings retrieval document (2026-09-27 B-3)", () => {
  const rows = Array.from({ length: THIRTEEN_F_EMBED_MAX_POSITIONS + 5 }, (_, i) => ({
    issuerName: `Issuer ${i}`,
    titleOfClass: "COM",
    cusip: `000000000${String(i).padStart(3, "0")}`,
    ticker: i === 0 ? "AAA" : "",
    shares: 1_000_000 * (i + 1),
    valueUsd: 1_000_000_000 - i * 1_000_000,
    sshPrnType: "SH"
  }));

  it("ranks by reported value, caps the position list, and states the rest as a count", () => {
    const text = buildThirteenFHoldingsText({
      filerName: "Example Capital",
      periodEnd: "2026-09-30",
      rows
    });
    expect(text).toContain("Example Capital 13F-HR holdings for the quarter ended 2026-09-30");
    expect(text).toContain(`${rows.length} reported positions`);
    // Highest value first, so the chunk budget buys the positions that actually matter.
    const appleLine = text.indexOf("Issuer 0");
    const lastLine = text.indexOf(`Issuer ${THIRTEEN_F_EMBED_MAX_POSITIONS - 1}`);
    expect(appleLine).toBeGreaterThan(-1);
    expect(appleLine).toBeLessThan(lastLine);
    expect(text).toContain("and 5 further positions below the top");
    expect(text).not.toContain(`Issuer ${THIRTEEN_F_EMBED_MAX_POSITIONS + 4}`);
    // The 45-day lag is stated in the text itself so a retrieved chunk cannot read as point-in-time.
    expect(text).toContain("up to 45 days before the filing date");
  });

  it("honours an explicit position cap", () => {
    const text = buildThirteenFHoldingsText({
      filerName: "Example Capital",
      periodEnd: "2026-09-30",
      rows,
      maxPositions: 2
    });
    expect(text).toContain("Issuer 0");
    expect(text).toContain("Issuer 1");
    expect(text).not.toContain("Issuer 2");
  });

  it("reads the filing date from the EDGAR directory, never the period end", () => {
    const index = {
      directory: {
        item: [
          { name: "primary_doc.xml", "last-modified": "2026-11-02T21:07:19.000Z" },
          { name: "infotable.xml", "last-modified": "2026-11-14T16:20:00.000Z" }
        ]
      }
    };
    expect(pick13FFilingDate(index)).toBe("2026-11-14T16:20:00.000Z");
    expect(pick13FFilingDate({ directory: { item: [] } })).toBeUndefined();
    expect(pick13FFilingDate({})).toBeUndefined();
  });
});
