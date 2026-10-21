import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CascadingEnrichmentProvider, type MarketEnrichmentProvider } from "../src/lib/data-providers";
import { resetDbForTesting } from "../src/lib/db";

// Per repo convention every test file points DATABASE_URL at its own temp SQLite DB.
// A gather that completes builds an enrichment coverage report and persists it, so
// without this the suite writes rows into the shared, untracked file:./data/app.db.
const dbDir = mkdtempSync(join(tmpdir(), `enrichment-abort-${randomUUID()}-`));
const prevDb = process.env.DATABASE_URL;
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;

beforeAll(() => {
  resetDbForTesting();
});

afterAll(() => {
  resetDbForTesting();
  if (prevDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDb;
  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("CascadingEnrichmentProvider gather abort", () => {
  it("forwards the gather signal into the keyed wave and stops when it fires", async () => {
    const controller = new AbortController();
    let paidSignal: AbortSignal | undefined;
    const free: MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      costTier: "free",
      async enrich() {
        return {};
      }
    };
    const paid: MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      costTier: "paid",
      suppliesFields: ["peRatio"],
      async enrich(_symbols, context) {
        paidSignal = context?.signal;
        return new Promise((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("aborted")),
            { once: true }
          );
        });
      }
    };

    const cascade = new CascadingEnrichmentProvider([free, paid]);
    const pending = cascade.enrich(["AAPL"], { signal: controller.signal });
    pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(paidSignal).toBe(controller.signal);
    });
    controller.abort(new Error("strategy gather timeout"));
    await expect(pending).rejects.toThrow("strategy gather timeout");
  });

  it("skips the keyed wave when remaining gather budget is below the keyed minimum", async () => {
    let paidCalled = false;
    const free: MarketEnrichmentProvider = {
      name: "yahoo-finance",
      configured: true,
      costTier: "free",
      async enrich() {
        return {};
      }
    };
    const paid: MarketEnrichmentProvider = {
      name: "finnhub",
      configured: true,
      costTier: "paid",
      suppliesFields: ["peRatio"],
      async enrich() {
        paidCalled = true;
        return { AAPL: { peRatio: 18 } };
      }
    };

    const cascade = new CascadingEnrichmentProvider([free, paid]);
    await cascade.enrich(["AAPL"], { deadlineAt: Date.now() + 1_000 });
    expect(paidCalled).toBe(false);
  });
});
