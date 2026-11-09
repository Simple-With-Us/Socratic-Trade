import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CascadingEnrichmentProvider, type MarketEnrichmentProvider } from "../src/lib/data-providers";
import { resetDbForTesting } from "../src/lib/db";
import { __awaitPendingEnrichmentCoveragePersist } from "../src/lib/enrichment-coverage";

// Per repo convention every test file points DATABASE_URL at its own temp SQLite DB.
// A gather that completes builds an enrichment coverage report and persists it, so
// without this the suite writes rows into the shared, untracked file:./data/app.db.
const dbDir = mkdtempSync(join(tmpdir(), `enrichment-abort-${randomUUID()}-`));
const dbUrl = `file:${join(dbDir, "test.db")}`;
// The run's shared path is captured here, at module scope, before any hook can throw.  A capture
// inside beforeAll would be skipped whenever the differential assertion below fails, and the
// teardown would then read that missing capture as "the run had no DATABASE_URL" and delete the
// variable instead of restoring it.
const prevDb = process.env.DATABASE_URL;

// The override is applied in beforeAll rather than at module scope.  A module-scope assignment
// opens the window in which the environment points at this file's database at import time,
// before the afterAll below is registered, so a throw in between leaves the override installed
// with nothing to undo it.  Applying it here means the window opens only once this file's tests
// are about to run, and it is always closed by the afterAll below.
beforeAll(() => {
  // The differential assertion.  Under the old module-scope override this file's database was
  // already installed by the time this hook ran, so this fails and the old implementation is
  // caught here rather than passing silently.  Under the override below, the run's shared path is
  // still in place, so it passes.
  expect(process.env.DATABASE_URL).not.toBe(dbUrl);
  process.env.DATABASE_URL = dbUrl;
  resetDbForTesting();
});

afterAll(async () => {
  // The coverage persist is scheduled as a fire-and-forget dynamic import, and it resolves the
  // database it writes to when the write lands rather than when it was scheduled.  Wait for it
  // while this file's own database is still the target, or a write that is still in flight lands
  // in the database the worker is pointing at by then, which is the shared one.
  await __awaitPendingEnrichmentCoveragePersist();
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
