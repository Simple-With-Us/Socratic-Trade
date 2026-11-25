// RAG outcome-lift scorecard (ST-4678): the pure aggregation module plus the read-only SQLite reader.
// Verifies the bucket split (RAG retrieval vs none), the horizon mapping (1d / 5d=1w / holding), the
// per-cell mean/median/win-rate/count and normal-approximation CI, and that the reader selects only
// matured CLOSED decisions (placed/filled + won/lost/flat) — never open or blocked/rejected rows.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  extractHorizonReturns,
  hasRagRetrieval,
  summarizeBucket,
  summarizeRagOutcomeLift,
  type LiftDecisionInput,
  type LiftHorizon,
  type LiftBucket
} from "../scripts/eval/rag-outcome-lift-score";
import { readLiftDecisions } from "../scripts/eval/rag-outcome-lift";

const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-rag-outcome-lift-${randomUUID()}.db`)}`;
});

afterAll(() => {
  // Kody rule: restore mutated test configuration so later files never inherit the temp URL.
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("hasRagRetrieval", () => {
  it("classifies a decision by whether its attributions include a retrieved chunk", () => {
    expect(hasRagRetrieval([])).toBe(false);
    expect(hasRagRetrieval(undefined)).toBe(false);
    expect(hasRagRetrieval(null)).toBe(false);
    expect(hasRagRetrieval([{ symbol: "AAPL", text: "t", contribution: "c", chunkId: "v1" }])).toBe(true);
    expect(hasRagRetrieval([{ symbol: "AAPL", text: "t", contribution: "c", evidenceRef: "ev1" }])).toBe(true);
    expect(hasRagRetrieval([{ symbol: "AAPL", text: "t", contribution: "c", docType: "10-k" }])).toBe(true);
    // An attribution with no chunk ref / evidence ref / doc type / source is not a retrieval.
    expect(hasRagRetrieval([{ symbol: "AAPL", text: "t", contribution: "c" }])).toBe(false);
  });
});

describe("extractHorizonReturns", () => {
  it("maps persisted horizons to 1d/5d/holding and skips unresolved or intraday rows", () => {
    const returns = extractHorizonReturns({
      status: "won",
      returnPct: 4.2,
      outcomes: [
        { horizon: "1d", returnPct: 1.5, resolution: "ok" },
        { horizon: "1w", returnPct: 3.0, resolution: "ok" },
        { horizon: "1h", returnPct: 0.5, resolution: "ok" }, // intraday — not a scorecard horizon
        { horizon: "1w", returnPct: 99, resolution: "unresolvable" } // skipped, never overwrites 5d
      ]
    });
    expect(returns).toEqual({ holding: 4.2, "1d": 1.5, "5d": 3.0 });
    expect(extractHorizonReturns(undefined)).toEqual({});
    expect(extractHorizonReturns(null)).toEqual({});
    expect(extractHorizonReturns({ status: "open", outcomes: [] })).toEqual({});
    // A non-finite headline return is not fabricated into the holding leg.
    expect(extractHorizonReturns({ status: "won", returnPct: Number.NaN, outcomes: [] })).toEqual({});
  });
});

describe("summarizeRagOutcomeLift", () => {
  const cell = (stats: ReturnType<typeof summarizeRagOutcomeLift>, horizon: LiftHorizon, bucket: LiftBucket) =>
    stats.find((s) => s.horizon === horizon && s.bucket === bucket)!;

  it("splits decisions by RAG bucket and summarizes each horizon", () => {
    const decisions: LiftDecisionInput[] = [
      { hasRag: true, returns: { "1d": 2, "5d": 4, holding: 6 } },
      { hasRag: true, returns: { "1d": -1, "5d": 2, holding: 3 } },
      { hasRag: true, returns: { "1d": 3, holding: 5 } }, // no resolved 5d
      { hasRag: false, returns: { "1d": -2, "5d": -3, holding: -4 } },
      { hasRag: false, returns: { "1d": 1, "5d": -1, holding: 0 } }
    ];
    const stats = summarizeRagOutcomeLift(decisions);
    expect(stats).toHaveLength(6); // 3 horizons x 2 buckets

    // rag 1d: [2, -1, 3] -> mean 1.3333, median 2, wins 2/3.
    expect(cell(stats, "1d", "rag").count).toBe(3);
    expect(cell(stats, "1d", "rag").mean).toBeCloseTo(1.3333, 3);
    expect(cell(stats, "1d", "rag").median).toBe(2);
    expect(cell(stats, "1d", "rag").wins).toBe(2);
    expect(cell(stats, "1d", "rag").winRate).toBeCloseTo(0.6667, 3);
    expect(cell(stats, "1d", "rag").ci95).not.toBeNull();

    // rag 5d: [4, 2] -> mean 3, median 3, wins 2 (the third decision had no 5d row).
    expect(cell(stats, "5d", "rag").count).toBe(2);
    expect(cell(stats, "5d", "rag").mean).toBe(3);
    expect(cell(stats, "5d", "rag").median).toBe(3);

    // no-rag holding: [-4, 0] -> mean -2, median -2, wins 0 (0 is not a win).
    expect(cell(stats, "holding", "no-rag").count).toBe(2);
    expect(cell(stats, "holding", "no-rag").mean).toBe(-2);
    expect(cell(stats, "holding", "no-rag").wins).toBe(0);
    expect(cell(stats, "holding", "no-rag").winRate).toBe(0);
  });

  it("reports null statistics and no CI for an empty or single-sample cell", () => {
    const empty = summarizeBucket("1d", "rag", []);
    expect(empty).toMatchObject({ count: 0, wins: 0, mean: null, median: null, winRate: null, ci95: null });
    const single = summarizeBucket("1d", "rag", [5]);
    expect(single.count).toBe(1);
    expect(single.mean).toBe(5);
    expect(single.median).toBe(5);
    expect(single.winRate).toBe(1);
    expect(single.ci95).toBeNull();
  });

  it("computes a symmetric 95% normal-approximation CI on the mean for n >= 2", () => {
    // [2, 4]: mean 3, sample stddev sqrt(2), SE = sqrt(2)/sqrt(2) = 1, half-width 1.96.
    const stats = summarizeBucket("5d", "rag", [2, 4]);
    expect(stats.mean).toBe(3);
    expect(stats.ci95).toEqual([1.04, 4.96]);
  });
});

describe("readLiftDecisions (read-only SQLite)", () => {
  it("selects only matured closed decisions and maps bucket + horizon returns", () => {
    const dbPath = join(tmpdir(), `agentic-rag-lift-read-${randomUUID()}.db`);
    const db = new Database(dbPath);
    db.exec(
      `CREATE TABLE socratic_decisions (
        id TEXT, user_id TEXT, status TEXT, rag_attributions TEXT, outcome TEXT, created_at TEXT
      )`
    );
    const insert = db.prepare(
      "INSERT INTO socratic_decisions (id, user_id, status, rag_attributions, outcome, created_at) VALUES (?,?,?,?,?,?)"
    );
    const ragAttr = JSON.stringify([{ symbol: "AAPL", text: "t", contribution: "c", chunkId: "v1" }]);
    const noAttr = JSON.stringify([]);
    const wonOutcome = JSON.stringify({
      status: "won",
      returnPct: 5,
      outcomes: [
        { horizon: "1d", returnPct: 2, resolution: "ok" },
        { horizon: "1w", returnPct: 4, resolution: "ok" }
      ]
    });
    const lostOutcome = JSON.stringify({
      status: "lost",
      returnPct: -3,
      outcomes: [{ horizon: "1d", returnPct: -1, resolution: "ok" }]
    });
    const openOutcome = JSON.stringify({ status: "open", outcomes: [] });
    insert.run("d1", "u1", "placed", ragAttr, wonOutcome, "2026-06-01"); // matured closed, rag
    insert.run("d2", "u1", "filled", noAttr, lostOutcome, "2026-06-02"); // matured closed, no-rag
    insert.run("d3", "u1", "placed", ragAttr, openOutcome, "2026-06-03"); // excluded: still open
    insert.run("d4", "u1", "blocked", ragAttr, wonOutcome, "2026-06-04"); // excluded: not closed
    insert.run("d5", "u2", "placed", noAttr, wonOutcome, "2026-06-05"); // matured closed, other user
    db.close();

    const all = readLiftDecisions(dbPath, undefined, 100);
    expect(all).toHaveLength(3); // d1, d2, d5 — d3 (open) and d4 (blocked) excluded

    const u1 = readLiftDecisions(dbPath, "u1", 100);
    expect(u1).toHaveLength(2);
    expect(u1).toContainEqual({ hasRag: true, returns: { holding: 5, "1d": 2, "5d": 4 } });
    expect(u1).toContainEqual({ hasRag: false, returns: { holding: -3, "1d": -1 } });

    // The full scorecard over the read rows splits cleanly into the two buckets.
    const stats = summarizeRagOutcomeLift(u1);
    const ragHolding = stats.find((s) => s.horizon === "holding" && s.bucket === "rag")!;
    const noRagHolding = stats.find((s) => s.horizon === "holding" && s.bucket === "no-rag")!;
    expect(ragHolding.mean).toBe(5);
    expect(noRagHolding.mean).toBe(-3);
  });
});