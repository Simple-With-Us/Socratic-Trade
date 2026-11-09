/**
 * PR #7 merge-gate — structural assertions that the view→execution coupling is gone and
 * stays gone. A future edit that reintroduces the ambient mirror or the active-pointer
 * seed coercion fails these.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dbProfiles = readFileSync(new URL("../src/lib/db-profiles.ts", import.meta.url), "utf8");

describe("PR #7 merge-gate (view/execution decouple)", () => {
  it("the ambient mirrorPolicyToActiveAccount is gone (renamed to a config-only copy)", () => {
    expect(dbProfiles).not.toContain("mirrorPolicyToActiveAccount");
    expect(dbProfiles).toContain("copyPolicyConfigToActiveAccount");
  });

  it("the seed no longer coerces on the active-account (view) pointer", () => {
    // The old coercion was `account.id !== activeId && policy.systemState === "active"`.
    // The fail-closed seed must not reference an `activeId` view pointer at all.
    expect(dbProfiles).not.toMatch(/!==\s*activeId/);
    expect(dbProfiles).not.toContain("const activeId =");
  });

  it("applyProfileToAccount enforces write-time account ownership", () => {
    expect(dbProfiles).toContain("export function assertConnectedAccountOwnedByUser");
    expect(dbProfiles).toContain("assertConnectedAccountOwnedByUser(userId, connectedAccountId)");
  });
});
