import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchStub = vi.hoisted(() => ({
  urls: [] as string[],
  impl: undefined as undefined | ((url: string) => Promise<Response>)
}));

vi.mock("../src/lib/data-providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/data-providers")>();
  return {
    ...actual,
    fetchWithRetry: async (url: string) => {
      fetchStub.urls.push(url);
      if (fetchStub.impl) return fetchStub.impl(url);
      throw new Error(`unexpected ROIC HTTP in archive-resume test: ${url}`);
    }
  };
});

const BODY =
  "This is a cached ROIC earnings-call transcript used to prove the Individual archive " +
  "does not re-list or re-fetch a call that already lives in earningscalls_transcripts. ".repeat(4);

describe("ROIC Individual archive resume", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "roic-artifacts-"));

  beforeAll(() => {
    vi.stubEnv("DATABASE_URL", `file:${join(tmpdir(), `agentic-roic-archive-${randomUUID()}.db`)}`);
    vi.stubEnv("DATA_DIR", dataDir);
    vi.stubEnv("ROIC_API_KEY", "test-roic-archive-key");
    vi.stubEnv("ROIC_TRANSCRIPTS_MAX_PER_RUN", "8");
    vi.stubEnv("ROIC_TRANSCRIPTS_QUARTERS_PER_SYMBOL", "20");
  });

  beforeEach(() => {
    fetchStub.urls = [];
    fetchStub.impl = undefined;
  });

  afterEach(() => {
    fetchStub.urls = [];
    fetchStub.impl = undefined;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("writes artifacts and resumes from them without ROIC HTTP", async () => {
    const { persistRoicTranscriptLocally, roicItemFromLocalCache } = await import(
      "../src/lib/web-sources/roic-transcripts"
    );
    const { writeRoicCallIndexArtifact, readRoicTranscriptArtifact, countRoicTranscriptArtifactFiles } =
      await import("../src/lib/roic-archive-artifacts");
    const { setInternalSetting } = await import("../src/lib/db-settings");

    persistRoicTranscriptLocally({
      symbol: "AAPL",
      year: 2026,
      quarter: 2,
      date: "2026-05-01",
      content: BODY,
      turns: []
    });
    const fromDisk = readRoicTranscriptArtifact("AAPL", 2026, 2);
    expect(fromDisk?.content).toContain("cached ROIC");
    expect(countRoicTranscriptArtifactFiles(dataDir)).toBe(1);

    writeRoicCallIndexArtifact({
      symbol: "AAPL",
      identifier: "NASDAQ:AAPL",
      fetchedAt: "2026-08-17T00:00:00.000Z",
      calls: [
        { year: 2026, quarter: 2, date: "2026-05-01" },
        { year: 2026, quarter: 1, date: "2026-02-01" }
      ]
    });

    const { getDb } = await import("../src/lib/db");
    getDb().prepare("DELETE FROM earningscalls_transcripts").run();
    const hydrated = roicItemFromLocalCache("AAPL", 2026, 2);
    expect(hydrated?.content.length).toBeGreaterThan(200);

    persistRoicTranscriptLocally({
      symbol: "AAPL",
      year: 2026,
      quarter: 1,
      date: "2026-02-01",
      content: BODY,
      turns: []
    });

    setInternalSetting("webSource:roicTranscripts:cursor", {
      queue: ["AAPL"],
      updatedAt: "2026-08-17T12:00:00.000Z",
      phase: "archive"
    });
    setInternalSetting("webSource:roicTranscripts:lastCompleteAt", null);

    const { refreshRoicTranscriptsIfDue, summarizeRoicArchiveCoverage } = await import(
      "../src/lib/web-sources/roic-transcripts"
    );
    const result = await refreshRoicTranscriptsIfDue({
      force: true,
      symbols: ["AAPL"],
      phase: "archive",
      now: Date.parse("2026-08-18T01:00:00.000Z")
    });

    expect(fetchStub.urls).toEqual([]);
    expect(result.skippedAlreadyStored).toBeGreaterThan(0);
    expect(result.attempted).toBe(0);
    expect(result.phase).toBe("archive");

    const coverage = summarizeRoicArchiveCoverage({
      universe: ["AAPL", "MSFT"],
      depth: 20
    });
    expect(coverage.transcriptsWithContent).toBe(2);
    expect(coverage.symbolsWithContent).toBe(1);
    expect(coverage.artifactFiles).toBe(2);
    expect(coverage.universeUncovered).toBe(1);
    expect(coverage.thinSymbols[0]).toEqual({ symbol: "AAPL", count: 2 });
  });

  it("lists once for a partial symbol then skips the cached newest period", async () => {
    const { persistRoicTranscriptLocally } = await import("../src/lib/web-sources/roic-transcripts");
    persistRoicTranscriptLocally({
      symbol: "IBM",
      year: 2026,
      quarter: 2,
      date: "2026-04-23",
      content: BODY,
      turns: []
    });

    fetchStub.impl = async (url: string) => {
      if (url.includes("/earnings-calls?") && url.includes("IBM")) {
        return new Response(
          JSON.stringify({
            data: [
              { symbol: "NYSE:IBM", fiscal_year: 2026, fiscal_quarter: 2, date: "2026-04-23" },
              { symbol: "NYSE:IBM", fiscal_year: 2026, fiscal_quarter: 1, date: "2026-01-29" }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/earnings-calls/") && url.includes("2026") && url.includes("fiscal_quarter=1")) {
        return new Response(
          JSON.stringify({
            symbol: "NYSE:IBM",
            fiscal_year: 2026,
            fiscal_quarter: 1,
            date: "2026-01-29",
            content: BODY
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ROIC URL ${url}`);
    };

    const { refreshRoicTranscriptsIfDue } = await import("../src/lib/web-sources/roic-transcripts");
    const result = await refreshRoicTranscriptsIfDue({
      force: true,
      symbols: ["IBM"],
      phase: "archive",
      now: Date.parse("2026-08-18T01:00:00.000Z")
    });

    expect(fetchStub.urls.some((url) => url.includes("/earnings-calls?"))).toBe(true);
    expect(fetchStub.urls.some((url) => url.includes("fiscal_quarter=2"))).toBe(false);
    expect(fetchStub.urls.filter((url) => url.includes("/earnings-calls/")).length).toBe(1);
    expect(result.skippedAlreadyStored).toBeGreaterThan(0);
    expect(result.cachedLocally + result.ingested).toBeGreaterThan(0);

    fetchStub.urls = [];
    fetchStub.impl = async (url: string) => {
      throw new Error(`re-walked cached IBM: ${url}`);
    };
    const second = await refreshRoicTranscriptsIfDue({
      force: true,
      symbols: ["IBM"],
      phase: "archive",
      now: Date.parse("2026-08-18T01:05:00.000Z")
    });
    expect(fetchStub.urls).toEqual([]);
    expect(second.attempted).toBe(0);
    expect(second.skippedAlreadyStored).toBeGreaterThan(0);
  });
});
