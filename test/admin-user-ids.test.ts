import { afterEach, describe, expect, it, vi } from "vitest";

import { userIdForEmail } from "../src/lib/auth/identity";
import { listAdminUserIds } from "../src/lib/admin-user-ids";

describe("listAdminUserIds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("always includes local and maps the primary operator onto it", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
    vi.stubEnv("ADMIN_USER_EMAILS", "");
    expect(listAdminUserIds()).toEqual(["local"]);
    expect(userIdForEmail("owner@example.com")).toBe("local");
  });

  it("adds extra ADMIN_USER_EMAILS as their own ids", () => {
    vi.stubEnv("PRIMARY_USER_EMAIL", "owner@example.com");
    vi.stubEnv("PRIMARY_USER_EMAIL_ALIASES", "");
    vi.stubEnv("ADMIN_USER_EMAILS", "staff@example.com");
    const ids = listAdminUserIds();
    expect(ids).toContain("local");
    expect(ids).toContain(userIdForEmail("staff@example.com"));
    expect(ids).toHaveLength(2);
  });
});
