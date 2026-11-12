import { describe, it, expect, beforeAll, vi } from "vitest";
import { getDb, applyVersionedMigrations } from "../src/lib/db";
import {
  parseAndSaveForm4,
  formatCompanyFactsEvidenceCard,
  ingestCompanyFacts,
  readCompanyFactsCache,
  SEC_COMPANYFACTS_CACHE_CONCEPT,
  upsertCompanyFactsCache
} from "../src/lib/web-sources/sec-facts";
import { politeFetch } from "../src/lib/web-sources/http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-facts-${randomUUID()}.db`)}`;
  const db = getDb();
  applyVersionedMigrations(db);
});

vi.mock("../src/lib/web-sources/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/web-sources/http")>();
  return {
    ...actual,
    politeFetch: vi.fn(),
    BROWSER_UA: "Mozilla/5.0 test"
  };
});

describe("SEC Facts and Insider Transactions Ingestion (P4)", () => {
  it("should parse and save Form 4 XML insider transactions correctly", () => {
    const db = getDb();
    const xmlContent = `
      <reportingOwner>
        <reportingOwnerId>
          <rptOwnerName>Tim Cook</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
          <isOfficer>true</isOfficer>
          <officerTitle>Chief Executive Officer</officerTitle>
        </reportingOwnerRelationship>
      </reportingOwner>
      <periodOfReport>
        <value>2026-07-15</value>
      </periodOfReport>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>2026-07-15</value></transactionDate>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>10000</value></transactionShares>
          <transactionPricePerShare><value>190.50</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
      <nonDerivativeTransaction>
        <securityTitle><value>Common Stock</value></securityTitle>
        <transactionDate><value>2026-07-15</value></transactionDate>
        <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>5000</value></transactionShares>
          <transactionPricePerShare><value>120.00</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
    `;

    const count = parseAndSaveForm4(xmlContent, "0000320193", "0000320193-26-000010");
    expect(count).toBe(2);

    const rows = db.prepare("SELECT * FROM sec_insider_transactions WHERE cik = '0000320193' ORDER BY side DESC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      insider_name: "Tim Cook",
      relationship: "Chief Executive Officer",
      side: "sell",
      shares: 10000,
      price: 190.50
    });
    expect(rows[1]).toMatchObject({
      insider_name: "Tim Cook",
      side: "buy",
      shares: 5000,
      price: 120.00
    });
  });

  it("should accept numeric XML booleans, keep transaction codes, and honor doc-level 10b5-1", () => {
    const db = getDb();
    const xmlContent = `
      <aff10b5One>1</aff10b5One>
      <reportingOwner>
        <reportingOwnerId>
          <rptOwnerName>Jane Officer</rptOwnerName>
        </reportingOwnerId>
        <reportingOwnerRelationship>
          <isOfficer>1</isOfficer>
        </reportingOwnerRelationship>
      </reportingOwner>
      <periodOfReport>2026-07-16</periodOfReport>
      <nonDerivativeTransaction>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>100</value></transactionShares>
          <transactionPricePerShare><value>10.00</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
    `;

    const count = parseAndSaveForm4(xmlContent, "0000111111", "0000111111-26-000001");
    expect(count).toBe(1);

    const row = db.prepare("SELECT * FROM sec_insider_transactions WHERE accession = '0000111111-26-000001'").get() as any;
    // <isOfficer>1</isOfficer> is a valid XML boolean — untitled officer must classify as Officer.
    expect(row.relationship).toBe("Officer");
    // periodOfReport as DIRECT element text (real ownership XML shape) is read correctly.
    expect(row.period_of_report).toBe("2026-07-16");
    // The SEC transaction code is preserved so downstream can distinguish P/S trades from grants.
    expect(row.transaction_code).toBe("S");
    // No transaction-level rule10b51Transaction — the document-level <aff10b5One>1 applies.
    expect(row.is_10b5_1).toBe(1);
  });

  it("should record every reporting owner on jointly filed Form 4s", () => {
    const db = getDb();
    const xmlContent = `
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>Trust A</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship>
      </reportingOwner>
      <reportingOwner>
        <reportingOwnerId><rptOwnerName>Fund B</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship>
      </reportingOwner>
      <periodOfReport>2026-07-16</periodOfReport>
      <nonDerivativeTransaction>
        <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
        <transactionAmounts>
          <transactionShares><value>500</value></transactionShares>
          <transactionPricePerShare><value>20.00</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
        </transactionAmounts>
      </nonDerivativeTransaction>
    `;

    parseAndSaveForm4(xmlContent, "0000222222", "0000222222-26-000002");

    const rows = db.prepare("SELECT insider_name, relationship FROM sec_insider_transactions WHERE accession = '0000222222-26-000002' ORDER BY insider_name ASC").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].insider_name).toBe("Fund B");
    expect(rows[1].insider_name).toBe("Trust A");
    expect(rows[1].relationship).toBe("Director");
  });

  it("should ingest IFRS facts for foreign issuers and propagate operational failures", async () => {
    const db = getDb();
    const mockIfrsFacts = {
      cik: 999999,
      facts: {
        "ifrs-full": {
          Revenue: {
            units: {
              USD: [
                {
                  val: 5000000000,
                  accn: "0000999999-26-000001",
                  fy: 2025,
                  fp: "FY",
                  form: "20-F",
                  filed: "2026-03-31",
                  end: "2025-12-31",
                  frame: "CY2025"
                }
              ]
            }
          }
        }
      }
    };

    vi.mocked(politeFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockIfrsFacts
    } as any);

    await ingestCompanyFacts("0000999999");
    const rows = db
      .prepare("SELECT * FROM sec_facts WHERE cik = '0000999999' AND concept != ?")
      .all(SEC_COMPANYFACTS_CACHE_CONCEPT) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ concept: "Revenue", value: 5000000000 });

    // Transient server errors must PROPAGATE (worker retry path), not be swallowed.
    vi.mocked(politeFetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error"
    } as any);
    await expect(ingestCompanyFacts("0000999999")).rejects.toThrow(/Failed to fetch company facts/);

    // The explicit 404 no-data case stays silent.
    vi.mocked(politeFetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found"
    } as any);
    await expect(ingestCompanyFacts("0000999999")).resolves.toBeUndefined();
  });

  it("should ingest company facts from EDGAR API and record them in database", async () => {
    const db = getDb();
    const mockFacts = {
      cik: 320193,
      entityName: "Apple Inc.",
      facts: {
        dei: {
          EntityRegistrantName: {
            units: { pure: [] }
          }
        },
        "us-gaap": {
          Assets: {
            units: {
              USD: [
                {
                  val: 350000000000,
                  accn: "0000320193-26-000010",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-10-31",
                  end: "2025-10-31",
                  frame: "CY2025"
                }
              ]
            }
          },
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  val: 100000000000,
                  accn: "0000320193-26-000010",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2025-10-31",
                  end: "2025-10-31",
                  frame: "CY2025"
                }
              ]
            }
          }
        }
      }
    };

    vi.mocked(politeFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockFacts
    } as any);

    await ingestCompanyFacts("0000320193");

    const cached = readCompanyFactsCache("0000320193");
    expect(cached?.json).toContain('"Assets"');

    const rows = db
      .prepare("SELECT * FROM sec_facts WHERE cik = '0000320193' AND concept != ? ORDER BY concept ASC")
      .all(SEC_COMPANYFACTS_CACHE_CONCEPT) as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      concept: "Assets",
      value: 350000000000,
      period: "CY2025"
    });
    expect(rows[1]).toMatchObject({
      concept: "NetIncomeLoss",
      value: 100000000000,
      period: "CY2025"
    });

    const card = formatCompanyFactsEvidenceCard("0000320193");
    expect(card).toContain("Assets: 350,000,000,000 USD");
    expect(card).toContain("NetIncomeLoss: 100,000,000,000 USD");
    expect(card).not.toContain(SEC_COMPANYFACTS_CACHE_CONCEPT);
  });

  it("keeps sibling concepts when one unit value is not an array", async () => {
    const db = getDb();
    const mockFacts = {
      cik: 141414,
      entityName: "Malformed Units Inc.",
      facts: {
        "us-gaap": {
          Assets: {
            units: {
              USD: [
                {
                  val: 42,
                  accn: "0000141414-26-000001",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2026-02-01",
                  end: "2025-12-31",
                  frame: "CY2025"
                }
              ],
              // Non-array unit value.  Must not reject Assets or the rest of the document.
              shares: { val: 1 }
            }
          },
          BrokenConcept: {
            units: "not-a-record"
          },
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  val: 7,
                  accn: "0000141414-26-000001",
                  fy: 2025,
                  fp: "FY",
                  form: "10-K",
                  filed: "2026-02-01",
                  end: "2025-12-31",
                  frame: "CY2025"
                }
              ]
            }
          }
        }
      }
    };

    vi.mocked(politeFetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockFacts), { status: 200 })
    );

    await ingestCompanyFacts("0000141414");
    const rows = db
      .prepare("SELECT concept, value FROM sec_facts WHERE cik = '0000141414' AND concept != ? ORDER BY concept ASC")
      .all(SEC_COMPANYFACTS_CACHE_CONCEPT) as Array<{ concept: string; value: number }>;
    expect(rows).toEqual([
      { concept: "Assets", value: 42 },
      { concept: "NetIncomeLoss", value: 7 }
    ]);

    // A `facts` value that is not an object still propagates (worker retry).  It is not a silent skip.
    vi.mocked(politeFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ facts: 1 }), { status: 200 })
    );
    await expect(ingestCompanyFacts("0000141414")).rejects.toThrow();
  });

  it("round-trips companyfacts JSON through the SQLite cache helpers", () => {
    const payload = JSON.stringify({ facts: { "us-gaap": { Assets: { units: { USD: [] } } } } });
    const fetchedAt = "2026-10-14T12:00:00.000Z";
    upsertCompanyFactsCache("320193", payload, fetchedAt);
    expect(readCompanyFactsCache("320193")).toEqual({ json: payload, fetchedAt });
  });
});
