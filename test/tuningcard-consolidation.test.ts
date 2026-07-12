import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  STRATEGY_CONSOLIDATION_OVERRIDE_KEY,
  isStrategyConsolidationEnabled
} from "../app/nav-destinations";

function memStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return { getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null) };
}

const source = readFileSync(new URL("../app/dashboard-client.tsx", import.meta.url), "utf8");

describe("TuningCard de-dup precondition (PR #6)", () => {
  // Exit criterion 1: both parents pass an IDENTICAL live baseline before either
  // render site is collapsed — otherwise a patch could diff against a stale
  // prompt. Asserted structurally against the source so a future edit that makes
  // one site read a different (stale) prompt/policy fails this test.
  const renderSites = source.match(/<TuningCard\b[^>]*\/>/g) ?? [];

  it("has exactly two TuningCard render sites, no third consumer", () => {
    expect(renderSites).toHaveLength(2);
  });

  it("both sites diff against the LIVE prompt and policy (identical baseline)", () => {
    for (const site of renderSites) {
      expect(site).toContain("currentPrompt={snapshot.strategyPrompt}");
      expect(site).toContain("currentPolicy={policy}");
      expect(site).toContain("proposal={strategyTuning}");
      expect(site).toContain("onApply={applyStrategyTuning}");
      expect(site).toContain("onDiscard={discardStrategyTuning}");
    }
  });

  it("gates the Studio-modal duplicate behind STRATEGY_CONSOLIDATION (rollback is a flag flip)", () => {
    expect(source).toContain("strategyConsolidation ? (");
    expect(source).toContain("isStrategyConsolidationEnabled(");
  });
});

describe("STRATEGY_CONSOLIDATION flag (PR #6)", () => {
  const original = process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION;
    else process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION = original;
  });

  it("defaults off", () => {
    delete process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION;
    expect(isStrategyConsolidationEnabled(memStorage())).toBe(false);
    expect(isStrategyConsolidationEnabled(null)).toBe(false);
  });

  it("localStorage override wins over env", () => {
    process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION = "1";
    expect(isStrategyConsolidationEnabled(memStorage({ [STRATEGY_CONSOLIDATION_OVERRIDE_KEY]: "off" }))).toBe(false);
    expect(isStrategyConsolidationEnabled(memStorage({ [STRATEGY_CONSOLIDATION_OVERRIDE_KEY]: "on" }))).toBe(true);
  });

  it("honors the env default with no override", () => {
    process.env.NEXT_PUBLIC_STRATEGY_CONSOLIDATION = "true";
    expect(isStrategyConsolidationEnabled(memStorage())).toBe(true);
  });
});
