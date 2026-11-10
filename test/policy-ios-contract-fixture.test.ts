/**
 * web-ios-contract-drift (docs/reviews/2026-08-18-work-items.json): GET /api/policy nests
 * stopLossPct/trailingStopPct/shortStopLossPct under `riskRules` (src/lib/types.ts's RiskRules
 * interface), but the hand-mirrored Swift decoder (ios/SocraticTrade/DeskModels.swift's
 * FullPolicy) used to read them from a flat top-level container that doesn't exist in the real
 * payload — every iPhone Guardrails row rendered "—" for a configured stop.  Nothing pinned the
 * two sides together, so a future rename would silently blank the same fields again.
 *
 * This test is the SERVER half of that pin: it drives the real route handlers (not a hand-typed
 * literal) with known riskRules values, asserts the wire shape is what the Swift decoder must
 * match, and regenerates the checked-in fixture that
 * ios/SocraticTradeTests/DeskModelsTests.swift decodes with the REAL FullPolicy type.  Run
 * `npm test -- policy-ios-contract-fixture` after any change to RiskRules/TradingPolicy/the
 * policy route to refresh the fixture, then re-run the iOS test to confirm the Swift decoder
 * still matches.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Checked-in fixture consumed by ios/SocraticTradeTests/DeskModelsTests.swift as a bundled
// test resource (XcodeGen picks up non-Swift files under a folder `sources:` path as target
// resources automatically — see ios/project.yml's SocraticTradeTests target).
const FIXTURE_PATH = resolve(__dirname, "../ios/SocraticTradeTests/Fixtures/policy-contract.json");

// Deliberately distinct, non-default values so a decoder that reads the wrong key (or reads a
// default instead of the wire value) is caught rather than accidentally matching by coincidence.
const CONTRACT_RISK_RULES = {
  stopLossPct: 8,
  trailingStopPct: 3,
  shortStopLossPct: 5
};

beforeEach(() => {
  vi.resetModules();
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-policy-ios-contract-${randomUUID()}.db`)}`;
});

function putRiskRules() {
  return new Request("http://localhost/api/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ riskRules: CONTRACT_RISK_RULES })
  });
}

describe("GET /api/policy <-> ios FullPolicy contract fixture", () => {
  it("nests stopLossPct/trailingStopPct/shortStopLossPct under riskRules, not at the top level", async () => {
    const { PUT, GET } = await import("../app/api/policy/route");

    const putResponse = await PUT(putRiskRules());
    expect(putResponse.status).toBe(200);

    const getResponse = await GET(new Request("http://localhost/api/policy"));
    expect(getResponse.status).toBe(200);
    const policy = await getResponse.json();

    // The contract the Swift FullPolicy decoder must match.
    expect(policy.riskRules).toBeDefined();
    expect(policy.riskRules.stopLossPct).toBe(CONTRACT_RISK_RULES.stopLossPct);
    expect(policy.riskRules.trailingStopPct).toBe(CONTRACT_RISK_RULES.trailingStopPct);
    expect(policy.riskRules.shortStopLossPct).toBe(CONTRACT_RISK_RULES.shortStopLossPct);

    // Guards against the exact bug this cluster fixes: these must NOT also (or instead) appear
    // flattened at the top level, which is what the old Swift decoder assumed.
    expect(policy.stopLossPct).toBeUndefined();
    expect(policy.trailingStopPct).toBeUndefined();
    expect(policy.shortStopLossPct).toBeUndefined();

    // Regenerate the checked-in iOS fixture from the real route output (not a hand-typed
    // literal) so a future rename fails this assertion before it ever reaches Xcode.
    // ios/SocraticTradeTests/DeskModelsTests.swift decodes this exact file with FullPolicy
    // and asserts the same values — a future CI job can additionally `git diff --exit-code`
    // this path after this test runs to catch route-shape drift the moment it happens.
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    const serialized = `${JSON.stringify(policy, null, 2)}\n`;
    writeFileSync(FIXTURE_PATH, serialized, "utf8");
  });
});
