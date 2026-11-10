import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-placement-guard-${randomUUID()}.db`)}`;
});

describe("freshPlacementBlockReason owner Approve vs autonomous", () => {
  it("lets owner Approve open in Exit-only while the agent stays barred", async () => {
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { setPolicy } = await import("../src/lib/db");
    const { freshPlacementBlockReason } = await import("../src/lib/system-state-placement-guard");
    const userId = `guard-close-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, systemState: "close_only" }, userId);

    expect(freshPlacementBlockReason({ userId, side: "buy" })).toContain("Only closing orders");
    expect(freshPlacementBlockReason({ userId, side: "short" })).toContain("Only closing orders");
    expect(freshPlacementBlockReason({ userId, side: "sell" })).toBeUndefined();
    expect(
      freshPlacementBlockReason({ userId, side: "buy", source: "owner_approval" })
    ).toBeUndefined();
    expect(
      freshPlacementBlockReason({ userId, side: "short", source: "owner_approval" })
    ).toBeUndefined();
    expect(
      freshPlacementBlockReason({ userId, side: "sell", source: "owner_approval" })
    ).toBeUndefined();
  });

  it("still blocks owner Approve when halted or winding down an opening", async () => {
    const { DEFAULT_POLICY } = await import("../src/lib/defaults");
    const { setPolicy } = await import("../src/lib/db");
    const { freshPlacementBlockReason } = await import("../src/lib/system-state-placement-guard");
    const haltedUser = `guard-halt-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, systemState: "halted" }, haltedUser);
    expect(
      freshPlacementBlockReason({ userId: haltedUser, side: "buy", source: "owner_approval" })
    ).toContain("halted");
    expect(
      freshPlacementBlockReason({ userId: haltedUser, side: "sell", source: "owner_approval" })
    ).toContain("halted");

    const windUser = `guard-liq-${randomUUID()}`;
    setPolicy({ ...DEFAULT_POLICY, systemState: "liquidating" }, windUser);
    expect(
      freshPlacementBlockReason({ userId: windUser, side: "buy", source: "owner_approval" })
    ).toContain("Only closing orders");
    expect(
      freshPlacementBlockReason({ userId: windUser, side: "sell", source: "owner_approval" })
    ).toBeUndefined();
  });
});
