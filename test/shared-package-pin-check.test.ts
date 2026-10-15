import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM operator helper, intentionally dependency-free (single-line so the directive covers the specifier)
import { comparePins, ctFetchProblem, ctHasNpmDep, gitRef, isGitHubRateLimit, lockResolvedSha, normVersion, packageSpec, parseProvenance, PKG, readTokenCandidates } from "../scripts/check-shared-package-pin.mjs";

describe("shared-package pin check (vendor-era triangle)", () => {
  it("normalizes git tag specs and lock SHAs", () => {
    expect(normVersion("github:jaywedgeworth22/congress-trading-shared#v2.5.2")).toBe("2.5.2");
    expect(gitRef("git+ssh://git@github.com/jaywedgeworth22/congress-trading-shared.git#b2847eb9b7839ad1241ee455a688ef0eec4ccdd6"))
      .toBe("b2847eb9b7839ad1241ee455a688ef0eec4ccdd6");
    expect(
      lockResolvedSha({
        packages: {
          [`node_modules/${PKG}`]: {
            resolved: "git+ssh://git@github.com/x/y.git#B2847EB9B7839AD1241EE455A688EF0EEC4CCDD6",
          },
        },
      })
    ).toBe("b2847eb9b7839ad1241ee455a688ef0eec4ccdd6");
  });

  it("parses provenance release and optional commit", () => {
    const parsed = parseProvenance(
      "- Immutable release: `v2.5.2`\n- Commit: `b2847eb9b7839ad1241ee455a688ef0eec4ccdd6`\n"
    );
    expect(parsed.release).toBe("v2.5.2");
    expect(parsed.commit).toBe("b2847eb9b7839ad1241ee455a688ef0eec4ccdd6");
    expect(parseProvenance("- Immutable release: `v2.5.2`\n").commit).toBe("");
  });

  it("reads the public repo with the Actions token before the shared user PAT", () => {
    expect(readTokenCandidates({
      GITHUB_TOKEN: "actions",
      GH_TOKEN: "actions",
      GH_PACKAGES_TOKEN: "pat",
    })).toEqual(["actions", "pat"]);
    expect(readTokenCandidates({ GH_PACKAGES_TOKEN: "pat" })).toEqual(["pat"]);
    const rateLimit = "API rate limit exceeded for user ID 12656028. (HTTP 403)";
    expect(isGitHubRateLimit(rateLimit)).toBe(true);
    expect(isGitHubRateLimit("HTTP 404 Not Found")).toBe(false);
    const problem = ctFetchProblem(rateLimit);
    expect(problem).toContain("GITHUB_TOKEN");
    expect(problem.includes("set GH_PACKAGES_TOKEN")).toBe(false);
    expect(ctFetchProblem("Not Found (HTTP 404)")).toContain("GH_PACKAGES_TOKEN");
    expect(comparePins({
      stSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
      umSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
      ctUnreadable: true,
      ctUnreadableDetail: problem,
    }).problems).toEqual([problem]);
  });

  it("fails when CT is unreadable or reintroduces an npm dep", () => {
    expect(
      comparePins({
        stSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
        umSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
        ctUnreadable: true,
      }).problems.some((p: string) => p.includes("GH_PACKAGES_TOKEN"))
    ).toBe(true);
    expect(
      ctHasNpmDep({ dependencies: { [PKG]: "github:x/y#v2.5.2" } }, { name: "root" })
    ).toBe(true);
    expect(ctHasNpmDep({ dependencies: { hono: "1" } }, { dependencies: {} })).toBe(false);
  });

  it("fails when ST/UM/CT versions diverge", () => {
    const { problems } = comparePins({
      stSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
      umSpec: "github:jaywedgeworth22/congress-trading-shared#v2.4.1",
      ctUnreadable: false,
      ctRelease: "v2.5.2",
      ctVendorVersion: "2.5.2",
      ctHasNpmDep: false,
    });
    expect(problems.some((p: string) => p.includes("ST pin"))).toBe(true);
  });

  it("accepts a matched triangle", () => {
    const sha = "b2847eb9b7839ad1241ee455a688ef0eec4ccdd6";
    const { problems } = comparePins({
      stSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
      umSpec: "github:jaywedgeworth22/congress-trading-shared#v2.5.2",
      stLockSha: sha,
      umLockSha: sha,
      ctUnreadable: false,
      ctRelease: "v2.5.2",
      ctCommit: sha,
      ctVendorVersion: "2.5.2",
      ctHasNpmDep: false,
    });
    expect(problems).toEqual([]);
    expect(packageSpec({ dependencies: { [PKG]: "github:x#v2.5.2" } })).toContain("v2.5.2");
  });
});
