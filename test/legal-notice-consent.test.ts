import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-legal-notice-${randomUUID()}.db`)}`;
});

describe("legal notice clickwrap", () => {
  it("is versioned and dismissed after accept; a second user stays independent", async () => {
    const {
      getLegalNoticeConsent,
      setLegalNoticeConsent,
      hasLegalNoticeConsent,
      needsLegalNoticeConsent,
      needsAppConsent
    } = await import("../src/lib/db");
    const { LEGAL_NOTICE_VERSION } = await import("../src/lib/legal-notice");
    const userA = `u-${randomUUID()}`;
    const userB = `u-${randomUUID()}`;

    expect(needsLegalNoticeConsent(userA)).toBe(true);
    expect(needsAppConsent(userA)).toBe(true);
    expect(getLegalNoticeConsent(userA).version).toBe(0);

    const rec = setLegalNoticeConsent(userA, true);
    expect(rec.accepted).toBe(true);
    expect(rec.version).toBe(LEGAL_NOTICE_VERSION);
    expect(rec.acceptedAt).toBeTruthy();
    expect(hasLegalNoticeConsent(userA)).toBe(true);
    expect(needsLegalNoticeConsent(userA)).toBe(false);

    expect(needsLegalNoticeConsent(userB)).toBe(true);
    expect(hasLegalNoticeConsent(userB)).toBe(false);
  });

  it("reopens when a prior accept is below the current version", async () => {
    const { setUserSetting, needsLegalNoticeConsent, hasLegalNoticeConsent } = await import("../src/lib/db");
    const user = `u-${randomUUID()}`;
    setUserSetting(user, "legal_notice_consent", {
      accepted: true,
      acceptedAt: new Date().toISOString(),
      version: 0
    });
    expect(hasLegalNoticeConsent(user)).toBe(false);
    expect(needsLegalNoticeConsent(user)).toBe(true);
  });
});
