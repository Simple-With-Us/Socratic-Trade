import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFinraShortVolume, getShortVolumeSignals, refreshFinra } from "../src/lib/web-sources/finra";
import { getSymbolWebSignals } from "../src/lib/web-sources";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-finra-${randomUUID()}.db`)}`;
});

beforeEach(async () => {
  const { deleteInternalSetting } = await import("../src/lib/db");
  deleteInternalSetting("webSource:finra:dataset");
  deleteInternalSetting("webSource:finra:lastAttempt");
  delete process.env.WEB_SOURCE_FINRA;
});

afterEach(() => vi.unstubAllGlobals());

const FILE = `Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
20260616|AAA|600|0|1000|B,Q,N
20260616|BBB|100|0|1000|B,Q,N
20260616|BAD|5|0|0|B,Q,N
some footer line that is not data`;

describe("FINRA short-volume parser", () => {
  it("computes per-symbol short-volume ratio and skips bad rows", () => {
    const { asOf, ratios } = parseFinraShortVolume(FILE);
    expect(asOf).toBe("2026-06-16");
    expect(ratios.AAA).toBe(60); // 600/1000
    expect(ratios.BBB).toBe(10);
    expect(ratios.BAD).toBeUndefined(); // totalVol 0 -> skipped
  });
});

describe("getShortVolumeSignals", () => {
  it("flags elevated short pressure with a bulletin", async () => {
    const { setInternalSetting } = await import("../src/lib/db");
    setInternalSetting("webSource:finra:dataset", { ratios: { AAA: 60, BBB: 10 }, asOf: "2026-06-16", fetchedAt: new Date().toISOString(), recordCount: 2 });
    const signals = getShortVolumeSignals(["AAA", "BBB", "CCC"]);
    expect(signals.AAA).toMatchObject({ shortVolumeRatio: 60, elevated: true });
    expect(signals.AAA.bulletin).toContain("Short pressure");
    expect(signals.BBB.elevated).toBe(false);
    expect(signals.BBB.bulletin).toBeUndefined();
    expect(signals.CCC).toBeUndefined();
    // Overlay surfaces the ratio + only the elevated bulletin.
    const overlay = getSymbolWebSignals(["AAA", "BBB"]);
    expect(overlay.AAA?.shortVolumeRatio).toBe(60);
    expect(overlay.AAA?.bulletins.some((b) => b.includes("Short pressure"))).toBe(true);
    expect(overlay.BBB?.bulletins.length ?? 0).toBe(0);
  });
});

describe("refreshFinra (mocked fetch)", () => {
  it("fetches the latest file, parses, and persists", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("CNMSshvol")) return new Response(FILE, { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const result = await refreshFinra(Date.now(), true);
    expect(result.ok).toBe(true);
    expect(result.recordCount).toBe(2);
    expect(getSymbolWebSignals(["AAA"]).AAA?.shortVolumeRatio).toBe(60);
  });

  it("degrades to no records (keeps prior) when no file is available", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    const result = await refreshFinra(Date.now(), true);
    expect(result.ok).toBe(false);
  });
});
