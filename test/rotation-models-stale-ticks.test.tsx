import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RotationModelChecklist,
  staleRotationTickLabel,
  staleRotationTicks,
  toggleRotationModel
} from "../app/console/strategy/rotation-models";

// Kody review (ST-4589): stored policies are not migrated, so a rotation set can still hold an id
// that is no longer offered (a retired row such as muse-spark-1.3, or a never-catalog custom id).
// Every stored tick must be visible and clearable; rotation keeps ignoring it.
describe("Rotation Models checklist: ticks that are no longer offered", () => {
  const stored = ["gpt-6.1-sol", "muse-spark-1.3", "my-custom/model"];

  it("renders stored non-offered ids as ticked boxes under a No Longer Offered group", () => {
    const html = renderToStaticMarkup(
      <RotationModelChecklist id="green-rot" seatLabel="Green Team" value={stored} onChange={() => {}} status="idle" />
    );
    expect(html).toContain("No Longer Offered");
    expect(html).toContain("muse-spark-1.3 (retired — not served)");
    expect(html).toContain("my-custom/model (not in the catalog — not served)");
    // Rendered as a checked checkbox the owner can untick.
    expect(html).toMatch(/<input id="green-rot-stale-muse-spark-1\.3" type="checkbox"[^>]*checked/);
    expect(html).toContain("Ticks under No Longer Offered are never served; untick them or press Clear.");
  });

  it("omits the group when every tick is an offered row", () => {
    const html = renderToStaticMarkup(
      <RotationModelChecklist id="red-rot" seatLabel="Red Team" value={["gpt-6.1-sol"]} onChange={() => {}} status="idle" />
    );
    expect(html).not.toContain("No Longer Offered");
  });

  it("lists, labels and removes a stale tick", () => {
    expect(staleRotationTicks(stored)).toEqual(["muse-spark-1.3", "my-custom/model"]);
    expect(staleRotationTickLabel("muse-spark-1.3")).toBe("muse-spark-1.3 (retired — not served)");
    expect(toggleRotationModel(stored, "muse-spark-1.3", false)).toEqual(["gpt-6.1-sol", "my-custom/model"]);
    expect(toggleRotationModel(stored, "my-custom/model", false)).toEqual(["gpt-6.1-sol", "muse-spark-1.3"]);
  });
});
