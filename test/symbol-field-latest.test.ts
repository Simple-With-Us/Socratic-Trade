/**
 * Durable shared symbol_field_latest store — per-field as_of + fetched_at.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resetDbForTesting } from "../src/lib/db";

describe("symbol_field_latest", () => {
  let dir: string;
  let prevDb: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), `symbol-field-latest-${randomUUID()}-`));
    prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `file:${join(dir, "test.db")}`;
    resetDbForTesting();
  });

  afterEach(() => {
    resetDbForTesting();
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("stores each field with its own as_of and fetched_at and never clobbers newer with older", async () => {
    const {
      upsertSymbolFieldLatest,
      getSymbolFieldLatest,
      getSymbolFieldLatestBySymbol,
      recordsFromEnrichmentMap,
      marketQuoteSummariesFromFieldStore,
      encodeFieldValue
    } = await import("../src/lib/db-fundamentals");
    const { getDb, getSchemaVersion } = await import("../src/lib/db");
    const db = getDb();
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(68);

    expect(encodeFieldValue(28.5)).toBe("28.5");
    expect(encodeFieldValue("Technology")).toBe(JSON.stringify("Technology"));
    expect(encodeFieldValue([])).toBeNull();

    const written = upsertSymbolFieldLatest([
      {
        symbol: "AAPL",
        field: "peRatio",
        valueJson: "28.5",
        source: "yahoo-finance",
        asOf: "2026-08-05T14:00:00.000Z",
        fetchedAt: "2026-08-05T14:05:00.000Z"
      },
      {
        symbol: "AAPL",
        field: "sector",
        valueJson: JSON.stringify("Technology"),
        source: "roic",
        asOf: "2026-08-01T00:00:00.000Z",
        fetchedAt: "2026-08-05T14:05:00.000Z"
      },
      {
        symbol: "MSFT",
        field: "peRatio",
        valueJson: "35",
        source: "finnhub",
        asOf: "2026-08-05T13:00:00.000Z",
        fetchedAt: "2026-08-05T13:01:00.000Z"
      }
    ]);
    expect(written).toBe(3);

    // Older write must not overwrite newer peRatio.
    const older = upsertSymbolFieldLatest([
      {
        symbol: "AAPL",
        field: "peRatio",
        valueJson: "1",
        source: "stale-provider",
        asOf: "2026-08-04T00:00:00.000Z",
        fetchedAt: "2026-08-05T12:00:00.000Z" // earlier than 14:05
      }
    ]);
    expect(older).toBe(0);

    const rows = getSymbolFieldLatest(["AAPL", "MSFT"]);
    const aaplPe = rows.find((r) => r.symbol === "AAPL" && r.field === "peRatio");
    expect(aaplPe?.value).toBe(28.5);
    expect(aaplPe?.asOf).toBe("2026-08-05T14:00:00.000Z");
    expect(aaplPe?.fetchedAt).toBe("2026-08-05T14:05:00.000Z");
    expect(aaplPe?.source).toBe("yahoo-finance");

    const aaplSector = rows.find((r) => r.symbol === "AAPL" && r.field === "sector");
    expect(aaplSector?.value).toBe("Technology");
    // Sector has a DIFFERENT as_of than peRatio — per-field timestamps.
    expect(aaplSector?.asOf).toBe("2026-08-01T00:00:00.000Z");
    expect(aaplSector?.fetchedAt).toBe("2026-08-05T14:05:00.000Z");

    // Newer write wins.
    upsertSymbolFieldLatest([
      {
        symbol: "AAPL",
        field: "peRatio",
        valueJson: "30",
        source: "roic",
        asOf: "2026-08-05T15:00:00.000Z",
        fetchedAt: "2026-08-05T15:01:00.000Z"
      }
    ]);
    const after = getSymbolFieldLatest(["AAPL"]).find((r) => r.field === "peRatio");
    expect(after?.value).toBe(30);
    expect(after?.source).toBe("roic");
    expect(after?.asOf).toBe("2026-08-05T15:00:00.000Z");

    // Symbols not in today's scan still return last known fields.
    const bySym = getSymbolFieldLatestBySymbol(["MSFT"]);
    expect(bySym.MSFT.peRatio.value).toBe(35);

    // recordsFromEnrichmentMap preserves observation stamps per field.
    const fromCascade = recordsFromEnrichmentMap(
      {
        JNJ: {
          peRatio: 15.2,
          sector: "Healthcare",
          sources: { peRatio: "yahoo-finance", sector: "sec-xbrl" },
          fieldObservations: {
            peRatio: {
              value: 15.2,
              source: "yahoo-finance",
              asOf: "2026-08-05T10:00:00.000Z",
              fetchedAt: "2026-08-05T10:01:00.000Z"
            },
            sector: {
              value: "Healthcare",
              source: "sec-xbrl",
              asOf: "2026-07-01T00:00:00.000Z",
              fetchedAt: "2026-08-05T10:01:00.000Z"
            }
          }
        }
      },
      "2026-08-05T10:01:00.000Z"
    );
    upsertSymbolFieldLatest(fromCascade);
    const jnj = getSymbolFieldLatest(["JNJ"]);
    expect(jnj.find((r) => r.field === "peRatio")?.asOf).toBe("2026-08-05T10:00:00.000Z");
    expect(jnj.find((r) => r.field === "sector")?.asOf).toBe("2026-07-01T00:00:00.000Z");

    const summaries = marketQuoteSummariesFromFieldStore(["AAPL", "JNJ"]);
    expect(summaries.AAPL.peRatio).toBe(30);
    expect(summaries.AAPL.fieldObservations?.peRatio?.fetchedAt).toBe("2026-08-05T15:01:00.000Z");
    expect(summaries.JNJ.sector).toBe("Healthcare");
    expect(summaries.JNJ.fieldObservations?.sector?.asOf).toBe("2026-07-01T00:00:00.000Z");

    const withAnalyst = recordsFromEnrichmentMap(
      {
        AAPL: {
          analystRating: "Buy",
          analystBySource: {
            fmp: { score: 80, label: "Buy", counts: { strongBuy: 2, buy: 1, hold: 0, sell: 0, strongSell: 0 } },
          },
          sources: { analystRating: "fmp" },
        },
      },
      "2026-08-05T16:00:00.000Z"
    );
    expect(withAnalyst.some((r) => r.field === "analystBySource")).toBe(true);
  });

  it("mergeQuoteSeedsFieldLevel prefers filled newer per-field values", async () => {
    const { mergeQuoteSeedsFieldLevel } = await import("../src/lib/market");
    const store = {
      AAPL: {
        symbol: "AAPL",
        price: 200,
        score: 70,
        peRatio: 28,
        sources: { peRatio: "yahoo-finance" },
        fieldObservations: {
          peRatio: {
            value: 28,
            source: "yahoo-finance",
            asOf: "2026-08-05T12:00:00.000Z",
            fetchedAt: "2026-08-05T12:00:00.000Z",
            status: "ok" as const
          }
        }
      }
    };
    const blankAudit = {
      AAPL: {
        symbol: "AAPL",
        price: 201,
        score: 71
        // no peRatio — must not wipe store
      }
    };
    const merged = mergeQuoteSeedsFieldLevel(store as never, blankAudit as never);
    expect(merged.AAPL.peRatio).toBe(28);
    expect(merged.AAPL.price).toBe(201); // newer audit price when present
  });

  it("getSymbolLatestPrices returns only the 'price' field with its own as_of, skipping invalid values", async () => {
    const { upsertSymbolFieldLatest, getSymbolLatestPrices } = await import("../src/lib/db-fundamentals");

    upsertSymbolFieldLatest([
      {
        symbol: "MSFT",
        field: "price",
        valueJson: "378.1",
        source: "yahoo-finance",
        asOf: "2026-08-07T13:00:00.000Z",
        fetchedAt: "2026-08-07T13:01:00.000Z"
      },
      {
        // Non-price fields must never leak into the price map.
        symbol: "MSFT",
        field: "peRatio",
        valueJson: "35",
        source: "yahoo-finance",
        asOf: "2026-08-07T13:00:00.000Z",
        fetchedAt: "2026-08-07T13:01:00.000Z"
      },
      {
        // Non-positive stored price is skipped (never surface a fabricated 0).
        symbol: "ZERO",
        field: "price",
        valueJson: "0",
        source: "yahoo-finance",
        asOf: "2026-08-07T13:00:00.000Z",
        fetchedAt: "2026-08-07T13:01:00.000Z"
      },
      {
        // Non-numeric stored price is skipped.
        symbol: "BAD",
        field: "price",
        valueJson: JSON.stringify("not-a-number"),
        source: "yahoo-finance",
        asOf: "2026-08-07T13:00:00.000Z",
        fetchedAt: "2026-08-07T13:01:00.000Z"
      }
    ]);

    const prices = getSymbolLatestPrices(["msft", "ZERO", "BAD", "UNSEEN"]);
    expect(prices).toEqual({
      MSFT: { price: 378.1, asOf: "2026-08-07T13:00:00.000Z", source: "yahoo-finance" }
    });
    expect(getSymbolLatestPrices([])).toEqual({});
  });
});
