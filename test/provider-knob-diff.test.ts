import { describe, it, expect } from "vitest";
// @ts-expect-error - plain ESM helper, no type declarations (single-line so the directive covers the specifier)
import { ALLOWED_KEY_RE, isAllowedKey, isSafeValue, coerceValue, desiredMapForStatus, computeDesired, parseEnvLines, computeDiff, computePlan, formatPlanRecords } from "../scripts/provider-knob-diff.mjs";

describe("provider-knob-diff: key allow-list guard", () => {
  it("accepts the prefixed knob families", () => {
    for (const k of [
      "PROVIDER_QUOTA_TIINGO_PER_HOUR",
      "PROVIDER_QUOTA_TWELVEDATA_PER_MIN",
      "PROVIDER_RATE_LIMIT_FINNHUB_PER_MINUTE",
      "MASSIVE_REST_MAX_CALLS_PER_MINUTE",
      "MASSIVE_HISTORY_ENABLED",
    ]) {
      expect(isAllowedKey(k)).toBe(true);
    }
  });

  it("accepts the three exactly-anchored boolean/enum knobs", () => {
    expect(isAllowedKey("TIINGO_DROP_NEWS")).toBe(true);
    expect(isAllowedKey("FINNHUB_DROP_RECOMMENDATION")).toBe(true);
    expect(isAllowedKey("ALPACA_DATA_FEED")).toBe(true);
  });

  it("rejects anchored keys with any suffix (no substring escape)", () => {
    expect(isAllowedKey("TIINGO_DROP_NEWS_EXTRA")).toBe(false);
    expect(isAllowedKey("ALPACA_DATA_FEEDX")).toBe(false);
  });

  it("rejects unrelated / secret-shaped keys", () => {
    for (const k of ["OPENROUTER_API_KEY", "DATABASE_URL", "INFISICAL_CLIENT_SECRET", "PATH", "TIINGO_API_KEY", ""]) {
      expect(isAllowedKey(k)).toBe(false);
    }
    expect(isAllowedKey(undefined as unknown as string)).toBe(false);
    expect(isAllowedKey(123 as unknown as string)).toBe(false);
  });

  it("ALLOWED_KEY_RE is exported and anchored at start", () => {
    expect(ALLOWED_KEY_RE.source.startsWith("^")).toBe(true);
  });
});

describe("provider-knob-diff: value charset guard", () => {
  it("accepts real knob values", () => {
    for (const v of ["10000", "0", "true", "false", "sip", "iex", "0.5", "1000000", "a-b_c.d:e+f/g"]) {
      expect(isSafeValue(v)).toBe(true);
    }
  });

  it("rejects empty, whitespace, and shell-hostile values", () => {
    for (const v of ["", " ", "1; rm -rf /", "$(echo hi)", "a b", "`id`", '"x"', "a\nb", "a\tb"]) {
      expect(isSafeValue(v)).toBe(false);
    }
  });

  it("rejects over-long values", () => {
    expect(isSafeValue("1".repeat(257))).toBe(false);
    expect(isSafeValue("1".repeat(256))).toBe(true);
  });
});

describe("provider-knob-diff: coerceValue", () => {
  it("coerces scalars to strings", () => {
    expect(coerceValue("10000")).toBe("10000");
    expect(coerceValue(10000)).toBe("10000");
    expect(coerceValue(true)).toBe("true");
    expect(coerceValue(false)).toBe("false");
  });
  it("returns null for non-scalars and non-finite numbers", () => {
    expect(coerceValue(null)).toBeNull();
    expect(coerceValue(undefined)).toBeNull();
    expect(coerceValue({})).toBeNull();
    expect(coerceValue([])).toBeNull();
    expect(coerceValue(NaN)).toBeNull();
    expect(coerceValue(Infinity)).toBeNull();
  });
});

describe("provider-knob-diff: status -> knob map", () => {
  const knob = { PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000" };
  const free = { PROVIDER_QUOTA_TIINGO_PER_HOUR: "50" };
  it("active -> knobEnv", () => {
    expect(desiredMapForStatus({ status: "active", knobEnv: knob, freeTierKnobEnv: free })).toBe(knob);
  });
  it("canceled/paused -> freeTierKnobEnv", () => {
    expect(desiredMapForStatus({ status: "canceled", knobEnv: knob, freeTierKnobEnv: free })).toBe(free);
    expect(desiredMapForStatus({ status: "paused", knobEnv: knob, freeTierKnobEnv: free })).toBe(free);
  });
  it("considering / unknown -> null (skip)", () => {
    expect(desiredMapForStatus({ status: "considering", knobEnv: knob, freeTierKnobEnv: free })).toBeNull();
    expect(desiredMapForStatus({ status: "weird", knobEnv: knob, freeTierKnobEnv: free })).toBeNull();
  });
  it("null / non-object map -> null", () => {
    expect(desiredMapForStatus({ status: "active", knobEnv: null })).toBeNull();
    expect(desiredMapForStatus({ status: "canceled", freeTierKnobEnv: null })).toBeNull();
    expect(desiredMapForStatus({ status: "active", knobEnv: [] })).toBeNull();
    expect(desiredMapForStatus(null)).toBeNull();
  });
});

describe("provider-knob-diff: computeDesired", () => {
  it("merges allowed knobs by status and skips considering/null", () => {
    const subs = [
      { provider: { displayName: "Tiingo" }, name: "Power", status: "active", knobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000", TIINGO_DROP_NEWS: "false" }, freeTierKnobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "50", TIINGO_DROP_NEWS: "true" } },
      { provider: { displayName: "Finnhub" }, name: "Free", status: "canceled", knobEnv: null, freeTierKnobEnv: { FINNHUB_DROP_RECOMMENDATION: "false" } },
      { provider: { displayName: "FMP" }, name: "Premium", status: "considering", knobEnv: { PROVIDER_QUOTA_FMP_PER_MIN: "750" }, freeTierKnobEnv: null },
    ];
    const { desired, skipped } = computeDesired(subs);
    expect(desired).toEqual({
      PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000",
      TIINGO_DROP_NEWS: "false",
      FINNHUB_DROP_RECOMMENDATION: "false",
    });
    expect(skipped.some((s: { plan: string }) => s.plan === "FMP")).toBe(true);
  });

  it("rejects disallowed keys and unsafe values, never surfacing them in desired", () => {
    const subs = [
      { provider: { displayName: "Evil" }, name: "pwn", status: "active", knobEnv: { OPENROUTER_API_KEY: "sk-leak", PROVIDER_QUOTA_X: "1; rm -rf /", ALPACA_DATA_FEED: "sip" }, freeTierKnobEnv: null },
    ];
    const { desired, rejected } = computeDesired(subs);
    expect(desired).toEqual({ ALPACA_DATA_FEED: "sip" });
    expect(rejected.map((r: { key: string }) => r.key).sort()).toEqual(["OPENROUTER_API_KEY", "PROVIDER_QUOTA_X"]);
  });

  it("records a conflict and drops the key when two plans disagree on a value", () => {
    const subs = [
      { provider: { displayName: "A" }, status: "active", knobEnv: { MASSIVE_HISTORY_ENABLED: "true" } },
      { provider: { displayName: "B" }, status: "active", knobEnv: { MASSIVE_HISTORY_ENABLED: "false" } },
    ];
    const { desired, conflicts } = computeDesired(subs);
    expect("MASSIVE_HISTORY_ENABLED" in desired).toBe(false);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("keeps a key when two plans agree on the same value (idempotent)", () => {
    const subs = [
      { provider: { displayName: "A" }, status: "active", knobEnv: { MASSIVE_HISTORY_ENABLED: "true" } },
      { provider: { displayName: "B" }, status: "active", knobEnv: { MASSIVE_HISTORY_ENABLED: "true" } },
    ];
    const { desired, conflicts } = computeDesired(subs);
    expect(desired.MASSIVE_HISTORY_ENABLED).toBe("true");
    expect(conflicts.length).toBe(0);
  });

  it("flags a non-array payload as invalid", () => {
    expect(computeDesired({} as unknown as unknown[]).invalid).toBe(true);
    expect(computeDesired(null as unknown as unknown[]).invalid).toBe(true);
  });

  it("coerces numeric/boolean knob values to strings", () => {
    const subs = [{ provider: { displayName: "T" }, status: "active", knobEnv: { PROVIDER_QUOTA_TIINGO_PER_DAY: 100000, TIINGO_DROP_NEWS: false } }];
    const { desired } = computeDesired(subs);
    expect(desired).toEqual({ PROVIDER_QUOTA_TIINGO_PER_DAY: "100000", TIINGO_DROP_NEWS: "false" });
  });
});

describe("provider-knob-diff: parseEnvLines", () => {
  it("parses dotenv text, tolerating export/quotes/comments/blanks", () => {
    const text = [
      "# comment",
      "",
      "export PROVIDER_QUOTA_TIINGO_PER_HOUR=10000",
      'ALPACA_DATA_FEED="sip"',
      "TIINGO_DROP_NEWS='false'",
      "NOEQUALS",
    ].join("\n");
    expect(parseEnvLines(text)).toEqual({
      PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000",
      ALPACA_DATA_FEED: "sip",
      TIINGO_DROP_NEWS: "false",
    });
  });
  it("empty input -> empty object", () => {
    expect(parseEnvLines("")).toEqual({});
    expect(parseEnvLines(undefined as unknown as string)).toEqual({});
  });
});

describe("provider-knob-diff: computeDiff writes only diffs", () => {
  it("emits only changed keys and never removals", () => {
    const desired = { A: "2", B: "9", C: "1" };
    const current = { A: "1", B: "9", D: "7" };
    const diff = computeDiff(desired, current);
    // A changed (1->2); B unchanged (skipped); C absent from current (unset->1); D not in desired (never touched)
    expect(diff).toEqual([
      { key: "A", old: "1", new: "2" },
      { key: "C", old: null, new: "1" },
    ]);
  });

  it("treats absent current as an unset first-time write", () => {
    expect(computeDiff({ A: "1" }, {})).toEqual([{ key: "A", old: null, new: "1" }]);
    expect(computeDiff({ A: "1" }, undefined as unknown as Record<string, string>)).toEqual([{ key: "A", old: null, new: "1" }]);
  });

  it("compares as strings (no numeric coercion surprises)", () => {
    expect(computeDiff({ A: "10" }, { A: "10" })).toEqual([]);
  });
});

describe("provider-knob-diff: computePlan + formatPlanRecords", () => {
  const subs = [
    { provider: { displayName: "Tiingo" }, name: "Power", status: "active", knobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "10000", TIINGO_DROP_NEWS: "false" }, freeTierKnobEnv: { PROVIDER_QUOTA_TIINGO_PER_HOUR: "50", TIINGO_DROP_NEWS: "true" } },
  ];
  const current = { PROVIDER_QUOTA_TIINGO_PER_HOUR: "50", TIINGO_DROP_NEWS: "false" };

  it("produces changes with plan/status origin", () => {
    const plan = computePlan(subs, current);
    expect(plan.changes).toEqual([
      { key: "PROVIDER_QUOTA_TIINGO_PER_HOUR", old: "50", new: "10000", plan: "Tiingo", status: "active" },
    ]);
    expect(plan.desiredCount).toBe(2);
  });

  it("formats tab-delimited records with no empty fields", () => {
    const plan = computePlan(subs, {});
    const text = formatPlanRecords(plan);
    const lines = text.split("\n");
    for (const line of lines) {
      for (const field of line.split("\t")) {
        expect(field.length).toBeGreaterThan(0); // "-"/"(unset)" stand-ins guarantee non-empty
      }
    }
    // unset prior value becomes the "(unset)" token
    expect(lines.some((l: string) => l.startsWith("CHANGE\t") && l.includes("(unset)"))).toBe(true);
    expect(lines.some((l: string) => l.startsWith("SUMMARY\t"))).toBe(true);
  });
});
