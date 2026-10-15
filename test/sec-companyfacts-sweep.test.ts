import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyVersionedMigrations, getDb } from "../src/lib/db";
import {
  isSecCompanyFactsSweepDue,
  resetSecCompanyFactsSweepStateForTests,
  runSecCompanyFactsSweep
} from "../src/lib/web-sources/sec-companyfacts-sweep";

vi.mock("../src/lib/rag/demand-first-symbols", () => ({
  rankDemandFirstSymbols: () => ["AAPL", "MSFT"]
}));

vi.mock("../src/lib/web-sources/sec8k", () => ({
  loadTickerCikMap: async () => ({ AAPL: "320193", MSFT: "789019" })
}));

vi.mock("../src/lib/web-sources/sec-facts", () => ({
  fetchAndCacheCompanyFacts: vi.fn(async () => undefined)
}));

import { fetchAndCacheCompanyFacts } from "../src/lib/web-sources/sec-facts";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-sec-sweep-${randomUUID()}.db`)}`;
  applyVersionedMigrations(getDb());
});

afterEach(() => {
  resetSecCompanyFactsSweepStateForTests();
  vi.mocked(fetchAndCacheCompanyFacts).mockClear();
  delete process.env.SEC_COMPANYFACTS_SWEEP_PER_TICK;
});

describe("sec companyfacts nightly sweep", () => {
  it("is due until the UTC day is marked complete", () => {
    const noonUtc = Date.parse("2026-10-14T12:00:00.000Z");
    expect(isSecCompanyFactsSweepDue(noonUtc)).toBe(true);
  });

  it("fetches a batch and advances the cursor", async () => {
    process.env.SEC_COMPANYFACTS_SWEEP_PER_TICK = "1";
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const first = await runSecCompanyFactsSweep(now);
    expect(first).toMatchObject({ attempted: 1, succeeded: 1, completed: false, cursor: 1 });
    expect(fetchAndCacheCompanyFacts).toHaveBeenCalledTimes(1);

    const second = await runSecCompanyFactsSweep(now);
    expect(second).toMatchObject({ attempted: 1, succeeded: 1, completed: true, cursor: 2 });
    expect(isSecCompanyFactsSweepDue(now)).toBe(false);
  });

  it("advances the cursor past a symbol whose companyfacts fetch throws", async () => {
    process.env.SEC_COMPANYFACTS_SWEEP_PER_TICK = "2";
    vi.mocked(fetchAndCacheCompanyFacts)
      .mockRejectedValueOnce(new Error("edgar 500"))
      .mockResolvedValue(undefined);
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const first = await runSecCompanyFactsSweep(now);
    expect(first).toMatchObject({ attempted: 1, succeeded: 0, cursor: 1, completed: false });
    expect(isSecCompanyFactsSweepDue(now)).toBe(false);

    const afterBackoff = now + 60 * 60_000;
    const second = await runSecCompanyFactsSweep(afterBackoff);
    expect(second).toMatchObject({ attempted: 1, succeeded: 1, cursor: 2, completed: true });
    expect(fetchAndCacheCompanyFacts).toHaveBeenCalledTimes(2);
  });
});
