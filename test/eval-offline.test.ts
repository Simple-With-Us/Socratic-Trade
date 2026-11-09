/**
 * Hermetic vitest test for the offline eval harness.
 *
 * Runs the deterministic scorers + MockLLM end-to-end with no network and no API keys.
 * Mirrors the temp-SQLite beforeAll convention from test/chat-llm.test.ts.
 *
 * What is tested:
 *   1. Scorer unit tests — each scorer function in score.ts
 *   2. MockLLM end-to-end — every DATASET case runs through MockLLM and scores deterministically
 *   3. Per-provider summary — aggregate pass/score stats across the full dataset
 *   4. Threshold invariant — overall score meets PASS_THRESHOLD (0.75 default)
 *   5. Rubric-judge skip — scoreLlmJudge returns "skipped" when env vars are absent (offline)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../src/lib/db";
import { MockLLM } from "../src/lib/chat/llm";
import { SYSTEM_PROMPT } from "../src/lib/chat/prompt";
import type { LlmRunArgs } from "../src/lib/chat/types";
import { DATASET } from "../scripts/eval/dataset";
import {
  scoreContains,
  scoreNotContains,
  scoreRegex,
  scoreNotRegex,
  scoreEquals,
  scoreJsonShape,
  runExpectation,
  scoreCase,
  scoreLlmJudge,
} from "../scripts/eval/score";

// ── DB bootstrap (same pattern as test/chat-llm.test.ts) ─────────────────────
beforeAll(() => {
  process.env.DATABASE_URL = `file:${process.env.TMPDIR ?? "/tmp"}/eval-offline-test-${Date.now()}.db`;
  getDb();
  // Ensure no Langfuse calls go out during tests.
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  // Ensure no LLM-judge calls go out during tests.
  delete process.env.EVAL_JUDGE_API_KEY;
  delete process.env.EVAL_JUDGE_MODEL;
});

// ── Read-only tool stubs (mirrors run-offline.ts) ─────────────────────────────
const noopExecuteTool: LlmRunArgs["executeTool"] = async (name, input) => {
  switch (name) {
    case "get_quote":
      return { symbol: input.symbol, price_usd: 200, change_pct: 1.2, as_of: "2026-01-15T00:00:00Z", source: "stub", session: "regular" };
    case "create_alert":
      return { symbol: input.symbol, op: input.op, price: input.price };
    case "draft_order":
      return {
        draft_id: "draft-stub-001",
        symbol: input.symbol,
        side: input.side,
        qty: input.qty,
        order_type: input.order_type,
        limit_usd: input.limit_usd ?? null,
        rationale: input.rationale ?? "",
        account_label: "Eval Stub (paper)",
        is_real: false,
        blocked: false,
        warnings: [],
        executed: false as const,
      };
    case "kb_search": {
      const query = String(input.query ?? "").toLowerCase();
      const ticker = String(input.ticker ?? "");
      if (ticker === "AAPL" && /supply/.test(query)) {
        return {
          chunks: [
            {
              chunk_id: "AAPL-10K#c001",
              text: "Apple faces supply-chain and supplier-concentration risks that could affect revenue timing.",
              source: "sec",
              as_of: "2024-01-15",
            },
          ],
        };
      }
      return { chunks: [] };
    }
    case "watchlist_add":
      return { item: { symbol: input.symbol, deduped: false } };
    case "get_positions":
      return { positions: [] };
    case "get_portfolio":
      return { portfolio: { totalMarketValue: 10000, cash: 10000 } };
    case "list_watchlist":
      return { watchlist: [] };
    case "list_alerts":
      return { alerts: [] };
    default:
      return { error: `unknown tool: ${name}` };
  }
};

const baseMockArgs: LlmRunArgs = {
  system: SYSTEM_PROMPT,
  message: "Hello",
  tools: [],
  executeTool: noopExecuteTool,
};

// ════════════════════════════════════════════════════════════════════════════
// 1. Scorer unit tests
// ════════════════════════════════════════════════════════════════════════════

describe("eval-offline: scorer unit tests", () => {
  // scoreContains
  it("scoreContains: pass when substring present (case-insensitive)", () => {
    const r = scoreContains("Hello World", "hello");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
  it("scoreContains: fail when substring absent", () => {
    const r = scoreContains("Hello World", "goodbye");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });

  // scoreNotContains
  it("scoreNotContains: pass when substring absent", () => {
    const r = scoreNotContains("Hello World", "goodbye");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
  it("scoreNotContains: fail when substring present", () => {
    const r = scoreNotContains("Hello World", "hello");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });

  // scoreRegex
  it("scoreRegex: pass on matching pattern", () => {
    const r = scoreRegex("AAPL is at $200", "\\$\\d+", "");
    expect(r.pass).toBe(true);
  });
  it("scoreRegex: fail on non-matching pattern", () => {
    const r = scoreRegex("no numbers here", "\\$\\d+", "");
    expect(r.pass).toBe(false);
  });
  it("scoreRegex: case-insensitive flag works", () => {
    const r = scoreRegex("PLACED the order", "placed", "i");
    expect(r.pass).toBe(true);
  });
  it("scoreRegex: returns fail + detail on invalid regex", () => {
    const r = scoreRegex("anything", "[invalid", "");
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/invalid regex/i);
  });

  // scoreNotRegex
  it("scoreNotRegex: pass when pattern does not match", () => {
    const r = scoreNotRegex("draft prepared for review", "\\b(placed|executed|filled)\\b", "i");
    expect(r.pass).toBe(true);
  });
  it("scoreNotRegex: fail when pattern matches", () => {
    const r = scoreNotRegex("order was placed successfully", "\\b(placed|executed|filled)\\b", "i");
    expect(r.pass).toBe(false);
  });

  // scoreEquals
  it("scoreEquals: pass on exact match", () => {
    const r = scoreEquals("hello", "hello");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
  it("scoreEquals: fail on mismatch", () => {
    const r = scoreEquals("hello", "world");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
  });

  // scoreJsonShape
  it("scoreJsonShape: pass when all required keys present", () => {
    const r = scoreJsonShape(JSON.stringify({ pass: true, score: 1, detail: "ok" }), "pass,score,detail");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });
  it("scoreJsonShape: fail and partial score when some keys missing", () => {
    const r = scoreJsonShape(JSON.stringify({ pass: true }), "pass,score,detail");
    expect(r.pass).toBe(false);
    // 1 of 3 keys missing → score < 1
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
  it("scoreJsonShape: fail on non-JSON input", () => {
    const r = scoreJsonShape("not json", "pass,score");
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not valid JSON/i);
  });
  it("scoreJsonShape: fail on JSON array (not an object)", () => {
    const r = scoreJsonShape(JSON.stringify([1, 2, 3]), "pass");
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/not a JSON object/i);
  });

  // runExpectation dispatcher
  it("runExpectation: dispatches contains correctly", () => {
    const r = runExpectation("hello world", { type: "contains", value: "world" });
    expect(r.pass).toBe(true);
  });
  it("runExpectation: dispatches notContains correctly", () => {
    const r = runExpectation("hello world", { type: "notContains", value: "goodbye" });
    expect(r.pass).toBe(true);
  });
  it("runExpectation: dispatches regex correctly", () => {
    const r = runExpectation("hello world", { type: "regex", value: "world$", flags: "" });
    expect(r.pass).toBe(true);
  });
  it("runExpectation: dispatches notRegex correctly", () => {
    const r = runExpectation("hello world", { type: "notRegex", value: "^goodbye", flags: "" });
    expect(r.pass).toBe(true);
  });
  it("runExpectation: dispatches equals correctly", () => {
    const r = runExpectation("exact", { type: "equals", value: "exact" });
    expect(r.pass).toBe(true);
  });
  it("runExpectation: dispatches jsonShape correctly", () => {
    const r = runExpectation(JSON.stringify({ a: 1 }), { type: "jsonShape", value: "a" });
    expect(r.pass).toBe(true);
  });

  // scoreCase aggregation
  it("scoreCase: all pass → pass=true, score=1", () => {
    const cs = scoreCase("test-id", "hello world", [
      { type: "contains", value: "hello" },
      { type: "contains", value: "world" },
    ]);
    expect(cs.pass).toBe(true);
    expect(cs.score).toBe(1);
    expect(cs.checks).toHaveLength(2);
  });
  it("scoreCase: one failure → pass=false, score=0.5", () => {
    const cs = scoreCase("test-id", "hello world", [
      { type: "contains", value: "hello" },
      { type: "contains", value: "goodbye" }, // fails
    ]);
    expect(cs.pass).toBe(false);
    expect(cs.score).toBeCloseTo(0.5, 2);
  });
  it("scoreCase: empty expectations → pass=true, score=1", () => {
    const cs = scoreCase("test-id", "anything", []);
    expect(cs.pass).toBe(true);
    expect(cs.score).toBe(1);
    expect(cs.checks).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. LLM-judge skip (no env vars → must not call network)
// ════════════════════════════════════════════════════════════════════════════

describe("eval-offline: LLM judge offline skip", () => {
  it("scoreLlmJudge: skipped when no env vars configured", async () => {
    // EVAL_JUDGE_API_KEY and EVAL_JUDGE_MODEL are unset (cleared in beforeAll)
    const r = await scoreLlmJudge("some output", "some rubric", "test-case-id");
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/skipped/i);
    expect(r.score).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. MockLLM end-to-end: every DATASET case
// ════════════════════════════════════════════════════════════════════════════

describe("eval-offline: MockLLM dataset end-to-end", () => {
  const mock = new MockLLM();

  it("MockLLM modelName is 'mock'", () => {
    expect(mock.modelName).toBe("mock");
  });

  it("MockLLM run() requires no network (offline)", async () => {
    const result = await mock.run(baseMockArgs);
    expect(typeof result.text).toBe("string");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("MockLLM always prefixes with 'Mock Response: '", async () => {
    const result = await mock.run(baseMockArgs);
    expect(result.text).toMatch(/^Mock Response: /);
  });

  it("MockLLM always includes DISCLAIMER in output", async () => {
    const result = await mock.run(baseMockArgs);
    expect(result.text).toContain("general information, not personalized financial advice");
  });

  // Run each DATASET case individually so failures are clearly attributed.
  for (const evalCase of DATASET) {
    it(`[mock] ${evalCase.id} — passes all deterministic checks`, async () => {
      const args: LlmRunArgs = {
        system: SYSTEM_PROMPT,
        message: evalCase.input,
        tools: [],
        executeTool: noopExecuteTool,
      };

      const result = await mock.run(args);
      const cs = scoreCase(evalCase.id, result.text, evalCase.expectations);

      // Report failing checks in the assertion message for easy debugging.
      const failingDetails = cs.checks
        .filter((c) => !c.pass)
        .map((c) => `  ✗ ${c.type}: ${c.detail}`)
        .join("\n");

      expect(cs.pass, `Case "${evalCase.id}" failed:\n${failingDetails}\n\nOutput: ${result.text.slice(0, 500)}`).toBe(true);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Per-provider summary + threshold invariant
// ════════════════════════════════════════════════════════════════════════════

describe("eval-offline: provider summary + threshold", () => {
  it("mock provider aggregate score meets PASS_THRESHOLD (0.75)", async () => {
    const mock = new MockLLM();
    const scores: number[] = [];

    for (const evalCase of DATASET) {
      const args: LlmRunArgs = {
        system: SYSTEM_PROMPT,
        message: evalCase.input,
        tools: [],
        executeTool: noopExecuteTool,
      };
      const result = await mock.run(args);
      const cs = scoreCase(evalCase.id, result.text, evalCase.expectations);
      scores.push(cs.score);
    }

    const PASS_THRESHOLD = 0.75;
    const aggregate = scores.reduce((s, x) => s + x, 0) / scores.length;
    const passing = scores.filter((s) => s === 1).length;

    // This is the summary the runner prints; assert here so CI fails with context.
    expect(
      aggregate,
      `Aggregate score ${(aggregate * 100).toFixed(1)}% below threshold ${PASS_THRESHOLD * 100}%. ` +
        `Passing: ${passing}/${scores.length}`
    ).toBeGreaterThanOrEqual(PASS_THRESHOLD);
  });

  it("DATASET has at least 8 cases covering distinct task types", () => {
    expect(DATASET.length).toBeGreaterThanOrEqual(8);
    const tasks = new Set(DATASET.map((c) => c.task));
    // Must cover at minimum: chat, quote, intent-order, intent-kb, intent-advice, intent-alert, intent-watchlist
    for (const required of ["chat", "quote", "intent-order", "intent-kb", "intent-advice", "intent-alert", "intent-watchlist"]) {
      expect(tasks, `Missing required task type: ${required}`).toContain(required);
    }
  });

  it("each DATASET case has at least one expectation", () => {
    for (const c of DATASET) {
      expect(c.expectations.length, `Case "${c.id}" has no expectations`).toBeGreaterThan(0);
    }
  });

  it("all DATASET cases have unique ids", () => {
    const ids = DATASET.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
