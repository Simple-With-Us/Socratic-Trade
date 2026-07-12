import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateInsiderSignals,
  mergeInsiderFilings,
  parseCurrentForm4Feed,
  parseForm4Xml,
  pickOwnershipXml,
  refreshInsider,
  type InsiderFiling
} from "../src/lib/web-sources/sec";
import { getSymbolWebSignals } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  deleteInternalSetting("webSource:insider:dataset");
  deleteInternalSetting("webSource:insider:lastAttempt");
  deleteInternalSetting("webSource:congress:dataset");
  delete process.env.WEB_SOURCE_INSIDER;
});

afterEach(() => vi.unstubAllGlobals());

const FORM4_BUY_XML = `<?xml version="1.0"?><ownershipDocument>
  <issuer><issuerTradingSymbol>NVDA</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerName>Jensen Huang</rptOwnerName></reportingOwnerId></reportingOwner>
  <periodOfReport>2026-06-12</periodOfReport>
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
    expect(filing).toMatchObject({ symbol: "NVDA", owner: "Jensen Huang", buyTx: 1, sellTx: 0, filedAt: "2026-06-12" });
    expect(filing!.buyShares).toBe(1000); // the M (option exercise) 5000 shares is excluded
  });

  it("returns null when a filing has no discretionary open-market trades", () => {
    const onlyOptions = FORM4_BUY_XML.replace("<transactionCode>P</transactionCode>", "<transactionCode>M</transactionCode>");
    expect(parseForm4Xml(onlyOptions, { accession: "x" })).toBeNull();
  });

  it("drops Form 4s with a future, near-future, or impossible reported date", () => {
    // A reported transaction date can't be after today — far-future, tomorrow (within the old skew),
    // and rolled-over impossible dates are all rejected rather than re-anchored to today.
    expect(parseForm4Xml(FORM4_BUY_XML.replace("2026-06-12", "2030-01-01"), { accession: "fut" })).toBeNull();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(parseForm4Xml(FORM4_BUY_XML.replace("2026-06-12", tomorrow), { accession: "tmrw" })).toBeNull();
    expect(parseForm4Xml(FORM4_BUY_XML.replace("2026-06-12", "2026-02-30"), { accession: "roll" })).toBeNull();
  });
});

describe("aggregateInsiderSignals + merge", () => {
  const now = Date.parse("2026-06-16T00:00:00Z");
  const filings: InsiderFiling[] = [
    { symbol: "NVDA", owner: "A", buyTx: 2, sellTx: 0, buyShares: 100, sellShares: 0, filedAt: "2026-06-12", accession: "1" },
    { symbol: "NVDA", owner: "B", buyTx: 1, sellTx: 0, buyShares: 50, sellShares: 0, filedAt: "2026-06-10", accession: "2" },
    { symbol: "AAPL", owner: "C", buyTx: 0, sellTx: 3, buyShares: 0, sellShares: 300, filedAt: "2026-06-05", accession: "3" }
  ];

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
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(1);
    const overlay = getSymbolWebSignals(["NVDA"]);
    expect(overlay.NVDA?.insiderSentiment).toBe(100);
    expect(overlay.NVDA?.bulletins.some((b) => b.includes("Insider"))).toBe(true);
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
});
