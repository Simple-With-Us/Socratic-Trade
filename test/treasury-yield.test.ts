import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTreasuryYieldCurve, parseTreasuryYieldCurveXml } from "../src/lib/market-signals/treasury";

function feedEntry(date: string, y3mo: number, y2: number, y10: number): string {
  return `<entry>
<content type="application/xml">
<m:properties>
<d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>
<d:BC_3MONTH m:type="Edm.Double">${y3mo}</d:BC_3MONTH>
<d:BC_2YEAR m:type="Edm.Double">${y2}</d:BC_2YEAR>
<d:BC_10YEAR m:type="Edm.Double">${y10}</d:BC_10YEAR>
</m:properties>
</content>
</entry>`;
}

function feed(entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title type="text">DailyTreasuryYieldCurveRateData</title>
${entries.join("\n")}
</feed>`;
}

describe("parseTreasuryYieldCurveXml", () => {
  it("parses dated rows in feed order", () => {
    const xml = feed([feedEntry("2026-07-01", 3.85, 4.17, 4.48), feedEntry("2026-07-02", 3.82, 4.14, 4.49)]);
    const rows = parseTreasuryYieldCurveXml(xml);
    expect(rows).toEqual([
      { date: "2026-07-01", y3mo: 3.85, y2: 4.17, y10: 4.48 },
      { date: "2026-07-02", y3mo: 3.82, y2: 4.14, y10: 4.49 }
    ]);
  });

  it("returns [] for an empty feed (no <entry> elements — e.g. a not-yet-published month)", () => {
    expect(parseTreasuryYieldCurveXml(feed([]))).toEqual([]);
  });

  it("skips a malformed entry missing NEW_DATE", () => {
    const xml = feed([
      `<entry><content type="application/xml"><m:properties><d:BC_10YEAR m:type="Edm.Double">4.5</d:BC_10YEAR></m:properties></content></entry>`,
      feedEntry("2026-07-02", 3.82, 4.14, 4.49)
    ]);
    expect(parseTreasuryYieldCurveXml(xml)).toEqual([{ date: "2026-07-02", y3mo: 3.82, y2: 4.14, y10: 4.49 }]);
  });
});

describe("fetchTreasuryYieldCurve", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the latest (last) row of the current month when published", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => feed([feedEntry("2026-07-01", 3.85, 4.17, 4.48), feedEntry("2026-07-31", 3.9, 4.2, 4.55)])
      })
    );
    const result = await fetchTreasuryYieldCurve(Date.UTC(2026, 6, 31));
    expect(result).toEqual({ asOf: "2026-07-31", y3mo: 3.9, y2: 4.2, y10: 4.55 });
  });

  it("falls back to the previous month when the current month has no rows yet", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("field_tdr_date_value_month=202608")) {
        return { ok: true, text: async () => feed([]) };
      }
      return { ok: true, text: async () => feed([feedEntry("2026-07-31", 3.85, 4.17, 4.48)]) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTreasuryYieldCurve(Date.UTC(2026, 7, 2)); // 2026-08-02
    expect(result).toEqual({ asOf: "2026-07-31", y3mo: 3.85, y2: 4.17, y10: 4.48 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when both months fail (never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchTreasuryYieldCurve(Date.UTC(2026, 7, 2))).toBeNull();
  });

  it("returns null on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await fetchTreasuryYieldCurve(Date.UTC(2026, 7, 2))).toBeNull();
  });
});
