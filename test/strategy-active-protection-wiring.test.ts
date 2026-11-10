import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketScan } from "../src/lib/types";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-protection-wiring-${randomUUID()}.db`)}`;
});

type Candidate = MarketScan["topCandidates"][number];

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    symbol: "TEST",
    price: 100,
    asOf: "2026-07-15T14:30:00.000Z",
    ...overrides
  } as Candidate;
}

describe("compactCandidateForPrompt ATR wiring (Phase A3)", () => {
  it("includes atrStopPct when precomputed map is provided", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const precomputed = { TEST: 6.42 };
    const compact = compactCandidateForPrompt(
      candidate({ symbol: "TEST", price: 100 }),
      0,
      precomputed
    );
    expect(compact.atrStopPct).toBe(6.42);
  });

  it("omits atrStopPct when not in map or map is missing", async () => {
    const { compactCandidateForPrompt } = await import("../src/lib/strategy");
    const compact = compactCandidateForPrompt(candidate({ symbol: "TEST", price: 100 }), 0);
    expect("atrStopPct" in compact).toBe(false);
  });
});
