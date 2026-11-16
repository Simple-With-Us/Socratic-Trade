import { describe, expect, it } from "vitest";
import { extractJsonPayload } from "../src/lib/llm-call";

// Root-cause coverage for the gemini-3.5-flash silent-failure (single-adversary-consolidation §4.1/R9):
// a fenced or prose-wrapped LLM reply must still yield parseable JSON, and a broken reply must NOT
// be coerced into fabricated valid JSON — the caller's JSON.parse should still reject it.
describe("extractJsonPayload", () => {
  it("passes bare JSON through unchanged", () => {
    const s = '{"rejected":false,"reason":"ok"}';
    expect(extractJsonPayload(s)).toBe(s);
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ rejected: false, reason: "ok" });
  });

  it("strips a ```json fenced block (the gemini failure mode)", () => {
    const wrapped = '```json\n{"verdict":"approve-at-half","reason":"sizing"}\n```';
    expect(JSON.parse(extractJsonPayload(wrapped))).toEqual({ verdict: "approve-at-half", reason: "sizing" });
  });

  it("strips a bare ``` fence with no language tag", () => {
    expect(JSON.parse(extractJsonPayload('```\n{"a":1}\n```'))).toEqual({ a: 1 });
  });

  it("extracts JSON embedded in prose", () => {
    const prose = 'Sure! Here is my verdict:\n{"verdict":"reject","reason":"overbought"}\nHope that helps.';
    expect(JSON.parse(extractJsonPayload(prose))).toEqual({ verdict: "reject", reason: "overbought" });
  });

  it("does not miscount braces inside string values", () => {
    const s = '{"reason":"breaks } below { support","rejected":true}';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ reason: "breaks } below { support", rejected: true });
  });

  it("handles nested objects and arrays", () => {
    const s = 'noise {"a":{"b":[1,2,{"c":3}]},"d":"}"} trailing';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ a: { b: [1, 2, { c: 3 }] }, d: "}" });
  });

  it("extracts an array root", () => {
    expect(JSON.parse(extractJsonPayload('```json\n[{"x":1},{"y":2}]\n```'))).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("is not greedy across multiple JSON-looking blocks (R9)", () => {
    // Greedy first-to-last slicing would grab '{"a":1} ... {"b":2}' and fail to parse.
    const s = '{"a":1} and separately {"b":2}';
    expect(JSON.parse(extractJsonPayload(s))).toEqual({ a: 1 });
  });

  it("returns non-JSON text unchanged so the caller's JSON.parse fails loudly (never fabricates)", () => {
    const refusal = "I can't help with that request.";
    expect(extractJsonPayload(refusal)).toBe(refusal);
    expect(() => JSON.parse(extractJsonPayload(refusal))).toThrow();
  });

  it("does NOT repair by default — a truncated object stays unparseable (fail-closed for safety sites)", () => {
    // Codex P1/P2, PR #1696: global repair turned truncated Red Team approvals and revalidation
    // withdrawals from fail-closed "unavailable" into fail-open acceptance. Repair is opt-in.
    const truncated = '{"verdict":"approve","reason":"cut off here';
    expect(() => JSON.parse(extractJsonPayload(truncated))).toThrow();
  });

  it("heals a truncated/unbalanced object with jsonrepair ONLY when repair is opted in", () => {
    const truncated = '{"verdict":"approve","reason":"cut off here';
    expect(JSON.parse(extractJsonPayload(truncated, { repair: true }))).toEqual({ verdict: "approve", reason: "cut off here" });
  });

  it("repairs style defects (single quotes, trailing commas) under repair without changing content", () => {
    const sloppy = "{'a': 1, 'b': [1, 2,],}";
    expect(JSON.parse(extractJsonPayload(sloppy, { repair: true }))).toEqual({ a: 1, b: [1, 2] });
    expect(() => JSON.parse(extractJsonPayload(sloppy))).toThrow(); // and stays strict by default
  });

  it("repairs single-quoted payloads from the FULL text, preserving string values containing '}' (Codex round 9)", () => {
    // firstBalancedJson only understands double-quoted strings — it would slice this payload at
    // the '}' inside the rationale, silently truncating it before repair.
    const singleQuoted = "{'proposals': [{'symbol': 'AAPL', 'rationale': 'breaks out of the {wedge} pattern', 'confidenceScore': 70}]}";
    const parsed = JSON.parse(extractJsonPayload(singleQuoted, { repair: true })) as {
      proposals: Array<{ rationale: string }>;
    };
    expect(parsed.proposals[0].rationale).toBe("breaks out of the {wedge} pattern");
  });

  it("returns unrepairable text unchanged even with repair on, so the caller fails loudly", () => {
    const refusal = "I can't help with that request.";
    expect(extractJsonPayload(refusal, { repair: true })).not.toContain("{");
    expect(() => JSON.parse(extractJsonPayload(refusal, { repair: true }))).toThrow();
  });
});
