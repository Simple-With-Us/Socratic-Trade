/**
 * Deterministic and LLM-judge scorers for the eval harness.
 *
 * All deterministic scorers run offline with no network and no API keys.
 * The LLM-judge scorer is a no-op / skipped when no API key is configured.
 *
 * Each scorer returns: { pass: boolean; score: number; detail: string }
 *   - pass:  whether this check is considered passing
 *   - score: 0.0–1.0 (1.0 = fully passing, 0.0 = failing)
 *   - detail: human-readable explanation for the test summary table
 */

import { isReasoningModel, LLM_TIMEOUT_MS } from "../../src/lib/llm-request";
import { extractLlmUsage, recordLlmUsage } from "../../src/lib/llm-usage";
import type { Expectation } from "./dataset";

export interface ScoreResult {
  pass: boolean;
  /** Normalized 0.0–1.0. */
  score: number;
  /** Human-readable explanation included in the summary table. */
  detail: string;
}

// ── Deterministic scorers ────────────────────────────────────────────────────

/** Case-insensitive substring check. */
export function scoreContains(output: string, value: string): ScoreResult {
  try {
    const pass = output.toLowerCase().includes(value.toLowerCase());
    return { pass, score: pass ? 1 : 0, detail: pass ? `contains "${value}"` : `missing "${value}"` };
  } catch (e) {
    return { pass: false, score: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Output must NOT contain the substring (case-insensitive). */
export function scoreNotContains(output: string, value: string): ScoreResult {
  try {
    const found = output.toLowerCase().includes(value.toLowerCase());
    const pass = !found;
    return { pass, score: pass ? 1 : 0, detail: pass ? `correctly absent "${value}"` : `unexpectedly contains "${value}"` };
  } catch (e) {
    return { pass: false, score: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Regex match. `flags` defaults to empty string (case-sensitive unless caller passes "i"). */
export function scoreRegex(output: string, pattern: string, flags = ""): ScoreResult {
  try {
    const re = new RegExp(pattern, flags);
    const pass = re.test(output);
    return { pass, score: pass ? 1 : 0, detail: pass ? `matches /${pattern}/${flags}` : `no match for /${pattern}/${flags}` };
  } catch (e) {
    return { pass: false, score: 0, detail: `invalid regex /${pattern}/${flags}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Output must NOT match the regex. */
export function scoreNotRegex(output: string, pattern: string, flags = ""): ScoreResult {
  try {
    const re = new RegExp(pattern, flags);
    const found = re.test(output);
    const pass = !found;
    return { pass, score: pass ? 1 : 0, detail: pass ? `correctly does not match /${pattern}/${flags}` : `unexpectedly matched /${pattern}/${flags}` };
  } catch (e) {
    return { pass: false, score: 0, detail: `invalid regex /${pattern}/${flags}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Exact string equality check. */
export function scoreEquals(output: string, expected: string): ScoreResult {
  try {
    const pass = output === expected;
    const preview = expected.length > 60 ? `${expected.slice(0, 57)}...` : expected;
    return { pass, score: pass ? 1 : 0, detail: pass ? `equals expected value` : `expected "${preview}", got "${output.slice(0, 60)}"` };
  } catch (e) {
    return { pass: false, score: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * JSON shape check: parse `output` as JSON, verify all required keys are present at the top level.
 * `requiredKeys` is a comma-separated list of key names, e.g. "pass,score,detail".
 */
export function scoreJsonShape(output: string, requiredKeys: string): ScoreResult {
  const keys = requiredKeys.split(",").map((k) => k.trim()).filter(Boolean);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (e) {
    return { pass: false, score: 0, detail: `output is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { pass: false, score: 0, detail: `output is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})` };
  }
  const obj = parsed as Record<string, unknown>;
  const missing = keys.filter((k) => !(k in obj));
  const pass = missing.length === 0;
  return {
    pass,
    score: pass ? 1 : 1 - missing.length / keys.length,
    detail: pass ? `has all required keys: ${keys.join(", ")}` : `missing keys: ${missing.join(", ")}`,
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Run a single deterministic expectation against an output string.
 * Returns { pass, score, detail } regardless of check type.
 */
export function runExpectation(output: string, expectation: Expectation): ScoreResult {
  switch (expectation.type) {
    case "contains":
      return scoreContains(output, expectation.value);
    case "notContains":
      return scoreNotContains(output, expectation.value);
    case "regex":
      return scoreRegex(output, expectation.value, expectation.flags ?? "");
    case "notRegex":
      return scoreNotRegex(output, expectation.value, expectation.flags ?? "");
    case "equals":
      return scoreEquals(output, expectation.value);
    case "jsonShape":
      return scoreJsonShape(output, expectation.value);
    default: {
      // Exhaustive guard — TypeScript will warn if a new CheckType is added without handling it here.
      const _: never = expectation.type;
      return { pass: false, score: 0, detail: `unknown check type: ${String(_)}` };
    }
  }
}

// ── Per-case aggregation ─────────────────────────────────────────────────────

export interface CaseScore {
  caseId: string;
  /** Whether all expectations passed. */
  pass: boolean;
  /** Average score across all expectations (0.0–1.0). */
  score: number;
  /** Per-expectation detail entries. */
  checks: Array<{ type: string; pass: boolean; score: number; detail: string }>;
}

/**
 * Run all deterministic expectations for a single eval case against the given output.
 * Returns a CaseScore aggregating all check results.
 */
export function scoreCase(caseId: string, output: string, expectations: Expectation[]): CaseScore {
  if (expectations.length === 0) {
    return { caseId, pass: true, score: 1, checks: [] };
  }
  const checks = expectations.map((exp) => {
    const result = runExpectation(output, exp);
    return { type: exp.type, pass: result.pass, score: result.score, detail: result.detail };
  });
  const avgScore = checks.reduce((sum, c) => sum + c.score, 0) / checks.length;
  const allPass = checks.every((c) => c.pass);
  return { caseId, pass: allPass, score: avgScore, checks };
}

// ── Optional LLM-judge scorer ────────────────────────────────────────────────

/**
 * LLM-judge scorer: uses a real LLM to evaluate output against a rubric string.
 * ONLY invoked when EVAL_JUDGE_API_KEY and EVAL_JUDGE_MODEL are set in the environment.
 * Returns { pass: false, score: 0, detail: "skipped (no judge configured)" } when offline.
 *
 * This is intentionally a minimal implementation — a yes/no verdict from the judge model.
 * Extend with a 1-5 scale if you need graded rubric scoring.
 */
export async function scoreLlmJudge(output: string, rubric: string, caseId: string): Promise<ScoreResult> {
  const apiKey = process.env.EVAL_JUDGE_API_KEY;
  const model = process.env.EVAL_JUDGE_MODEL;

  if (!apiKey || !model) {
    return { pass: false, score: 0, detail: "skipped (no judge configured — set EVAL_JUDGE_API_KEY + EVAL_JUDGE_MODEL)" };
  }

  const prompt = [
    `You are an eval judge. Assess whether the following LLM output satisfies the rubric.`,
    ``,
    `RUBRIC: ${rubric}`,
    ``,
    `OUTPUT: ${output}`,
    ``,
    `Reply with exactly one line: "PASS" or "FAIL", followed by a brief reason (max 80 chars).`,
  ].join("\n");

  // Reasoning models (gpt-5/o-series) reject `max_tokens` — use `max_completion_tokens` instead.
  const tokenParam = isReasoningModel(model) ? { max_completion_tokens: 64 } : { max_tokens: 64 };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, ...tokenParam, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { pass: false, score: 0, detail: `judge error ${res.status}: ${text.slice(0, 120)}` };
    }
    const payload = await res.json();
    // Every LLM call is hardwired into the usage ledger + external telemetry (owner directive),
    // including this dev/CI-only judge. Runs against whatever DATABASE_URL is set — intended.
    // recordLlmUsage never throws, but wrapped anyway so a ledger hiccup can never fail an eval run.
    try {
      recordLlmUsage({
        userId: "local",
        provider: "openai",
        model,
        context: "eval-judge",
        keySource: "operator",
        ...extractLlmUsage(payload)
      });
    } catch {
      /* usage ledger is best-effort; never break the eval run */
    }
    const data = payload as { choices?: Array<{ message?: { content?: string } }> };
    const verdict = (data?.choices?.[0]?.message?.content ?? "").trim();
    const pass = /^PASS\b/i.test(verdict);
    const reason = verdict.replace(/^(PASS|FAIL)\s*/i, "").trim().slice(0, 120) || "(no reason given)";
    return { pass, score: pass ? 1 : 0, detail: `judge[${caseId}]: ${pass ? "PASS" : "FAIL"} — ${reason}` };
  } catch (e) {
    return { pass: false, score: 0, detail: `judge exception: ${e instanceof Error ? e.message : String(e)}` };
  }
}
