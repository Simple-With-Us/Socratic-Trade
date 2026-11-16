import { describe, expect, it } from "vitest";
import type { TradingPolicy } from "../src/lib/types";
import {
  buildUniverseExtraPatch,
  discardAllDrafts,
  emptyUniverseDraft,
  type UniverseDraft
} from "../app/console/guardrails/universe-draft";

const policy: Pick<
  TradingPolicy,
  "includedIndices" | "additionalSymbols" | "blocklist" | "permittedOrderTypes" | "sellToFundBuy"
> = {
  includedIndices: ["sp500"],
  additionalSymbols: ["AAPL"],
  blocklist: ["GME"],
  permittedOrderTypes: ["market", "limit"],
  sellToFundBuy: "off"
};

describe("Guardrails universe Discard", () => {
  it("builds extraPatch from a dirty universeDraft", () => {
    const dirty: UniverseDraft = {
      includedIndices: ["sp500", "nasdaq100"],
      additionalSymbols: "AAPL, MSFT",
      blocklist: "GME AMC",
      permittedOrderTypes: ["market"],
      sellToFundBuy: "automated"
    };
    const patch = buildUniverseExtraPatch(dirty, policy);
    expect(patch.includedIndices).toEqual(["sp500", "nasdaq100"]);
    expect(patch.additionalSymbols).toEqual(["AAPL", "MSFT"]);
    expect(patch.blocklist).toEqual(["GME", "AMC"]);
    expect(patch.permittedOrderTypes).toEqual(["market"]);
    expect(patch.sellToFundBuy).toBe("automated");
  });

  it("discardAll resets universeDraft so the next commit has no universe extraPatch", () => {
    let fieldCleared = false;
    let universeDraft: UniverseDraft = {
      includedIndices: ["russell2000"],
      additionalSymbols: "TSLA",
      blocklist: "NVDA",
      permittedOrderTypes: ["limit"],
      sellToFundBuy: "propose"
    };

    discardAllDrafts(
      () => {
        fieldCleared = true;
      },
      (next) => {
        universeDraft = next;
      }
    );

    expect(fieldCleared).toBe(true);
    expect(universeDraft).toEqual(emptyUniverseDraft());
    expect(buildUniverseExtraPatch(universeDraft, policy)).toEqual({});
  });
});
