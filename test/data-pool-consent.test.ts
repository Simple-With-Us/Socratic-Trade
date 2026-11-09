import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-consent-${randomUUID()}.db`)}`;
});

describe("data-pool consent", () => {
  it("does not silently share for unset users; accept is per-user and versioned", async () => {
    const {
      getDataPoolConsent,
      setDataPoolConsent,
      hasDataPoolConsent,
      needsDataPoolConsent,
      DATA_POOL_CONSENT_VERSION
    } = await import("../src/lib/db");
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    expect(hasDataPoolConsent(userA)).toBe(false);
    expect(needsDataPoolConsent(userA)).toBe(true);
    expect(getDataPoolConsent(userA).accepted).toBe(false);
    expect(getDataPoolConsent(userA).version).toBe(0);

    const rec = setDataPoolConsent(userA, true);
    expect(rec.accepted).toBe(true);
    expect(rec.version).toBe(DATA_POOL_CONSENT_VERSION);
    expect(rec.acceptedAt).toBeTruthy();
    expect(hasDataPoolConsent(userA)).toBe(true);
    expect(needsDataPoolConsent(userA)).toBe(false);
    expect(hasDataPoolConsent(userB)).toBe(false);
    expect(needsDataPoolConsent(userB)).toBe(true);
  });

  it("requires the CURRENT consent version (a stale acceptance does not count)", async () => {
    const { setUserSetting, hasDataPoolConsent, needsDataPoolConsent } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;
    setUserSetting(user, "data_pool_consent", { accepted: true, acceptedAt: new Date().toISOString(), version: 0 });
    expect(hasDataPoolConsent(user)).toBe(false);
    expect(needsDataPoolConsent(user)).toBe(true);
  });

  it("a recorded decline does not resolve the mandatory gate or grant pooling", async () => {
    const { setDataPoolConsent, hasDataPoolConsent, needsDataPoolConsent } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;

    expect(needsDataPoolConsent(user)).toBe(true);

    setDataPoolConsent(user, false);
    expect(needsDataPoolConsent(user)).toBe(true);
    expect(hasDataPoolConsent(user)).toBe(false);

    setDataPoolConsent(user, true);
    expect(needsDataPoolConsent(user)).toBe(false);
    expect(hasDataPoolConsent(user)).toBe(true);
  });
});
