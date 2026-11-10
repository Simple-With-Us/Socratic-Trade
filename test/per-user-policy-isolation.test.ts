/**
 * Two-user isolation test (M3 — per-user policy scoping).
 *
 * Verifies that policy, strategy prompt, and strategy profiles for one user are
 * completely invisible to a second user. Each user's data lives solely in
 * user_settings / strategy_profiles rows keyed by user_id.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-per-user-isolation-${randomUUID()}.db`)}`;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("per-user policy isolation (M3)", () => {
  const userA = `user-a-${randomUUID()}`;
  const userB = `user-b-${randomUUID()}`;

  it("each user gets independent policy values", async () => {
    const { getPolicy, setPolicy } = await import("../src/lib/db");

    // User A gets a distinct maxOrderNotional.
    setPolicy({ ...getPolicy(userA), maxOrderNotional: 1111 }, userA);
    // User B gets a different maxOrderNotional.
    setPolicy({ ...getPolicy(userB), maxOrderNotional: 2222 }, userB);

    expect(getPolicy(userA).maxOrderNotional).toBe(1111);
    expect(getPolicy(userB).maxOrderNotional).toBe(2222);
    expect(getPolicy(userA).maxOrderNotional).not.toBe(getPolicy(userB).maxOrderNotional);
  });

  it("each user gets an independent strategy prompt", async () => {
    const { getStrategyPrompt, setStrategyPrompt } = await import("../src/lib/db");

    setStrategyPrompt("Prompt for user A", userA);
    setStrategyPrompt("Prompt for user B", userB);

    expect(getStrategyPrompt(userA)).toBe("Prompt for user A");
    expect(getStrategyPrompt(userB)).toBe("Prompt for user B");
    expect(getStrategyPrompt(userA)).not.toBe(getStrategyPrompt(userB));
  });

  it("profiles created for user A are invisible to user B and vice-versa", async () => {
    const { createStrategyProfile, listStrategyProfiles } = await import("../src/lib/db");

    const profileA = createStrategyProfile({ name: "Profile-A-Only" }, userA);
    const profileB = createStrategyProfile({ name: "Profile-B-Only" }, userB);

    const listA = listStrategyProfiles(userA);
    const listB = listStrategyProfiles(userB);

    // User A's list contains the profile created for A.
    expect(listA.some((p) => p.id === profileA.id)).toBe(true);
    // User A's list does NOT contain user B's profile.
    expect(listA.some((p) => p.id === profileB.id)).toBe(false);

    // User B's list contains the profile created for B.
    expect(listB.some((p) => p.id === profileB.id)).toBe(true);
    // User B's list does NOT contain user A's profile.
    expect(listB.some((p) => p.id === profileA.id)).toBe(false);
  });

  it("deleteStrategyProfile reassigns active to the oldest remaining profile", async () => {
    const { createStrategyProfile, activateStrategyProfile, deleteStrategyProfile, listStrategyProfiles } = await import("../src/lib/db");

    const userC = `user-c-${randomUUID()}`;
    const older = createStrategyProfile({ name: "Older" }, userC);
    const newer = createStrategyProfile({ name: "Newer" }, userC);

    // Activate the newer profile, then delete it — active should fall back to older.
    activateStrategyProfile(newer.id, userC);
    deleteStrategyProfile(newer.id, userC);

    const remaining = listStrategyProfiles(userC);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(older.id);
    expect(remaining[0].active).toBe(true);
  });

  it("deleteStrategyProfile throws 404 for a profile belonging to a different user", async () => {
    const { createStrategyProfile, deleteStrategyProfile } = await import("../src/lib/db");

    const userD = `user-d-${randomUUID()}`;
    const userE = `user-e-${randomUUID()}`;
    const profile = createStrategyProfile({ name: "D's profile" }, userD);

    // userE should not be able to delete userD's profile.
    expect(() => deleteStrategyProfile(profile.id, userE)).toThrow("Strategy profile not found.");
  });

  it("a second allowed email maps to an isolated userId and isolated consent", async () => {
    const { userIdForEmail, isEmailAllowed } = await import("../src/lib/auth/identity");
    const {
      setPolicy,
      getPolicy,
      setDataPoolConsent,
      hasDataPoolConsent,
      setLegalNoticeConsent,
      hasLegalNoticeConsent
    } = await import("../src/lib/db");

    vi.stubEnv("ALLOWED_EMAILS", "friend@example.com,family@example.com");
    expect(isEmailAllowed("friend@example.com")).toBe(true);
    expect(isEmailAllowed("family@example.com")).toBe(true);

    const friend = userIdForEmail("friend@example.com");
    const family = userIdForEmail("family@example.com");
    expect(friend).not.toBe("local");
    expect(family).not.toBe("local");
    expect(friend).not.toBe(family);

    setPolicy({ ...getPolicy(friend), maxOrderNotional: 3333 }, friend);
    setPolicy({ ...getPolicy(family), maxOrderNotional: 4444 }, family);
    setDataPoolConsent(friend, true);
    setLegalNoticeConsent(friend, true);

    expect(getPolicy(friend).maxOrderNotional).toBe(3333);
    expect(getPolicy(family).maxOrderNotional).toBe(4444);
    expect(hasDataPoolConsent(friend)).toBe(true);
    expect(hasDataPoolConsent(family)).toBe(false);
    expect(hasLegalNoticeConsent(friend)).toBe(true);
    expect(hasLegalNoticeConsent(family)).toBe(false);
  });

  it("deleteStrategyProfile with no remaining profiles leaves no active profile", async () => {
    const { createStrategyProfile, deleteStrategyProfile, listStrategyProfiles } = await import("../src/lib/db");

    const userF = `user-f-${randomUUID()}`;
    const only = createStrategyProfile({ name: "Only Profile", active: true }, userF);
    deleteStrategyProfile(only.id, userF);

    const remaining = listStrategyProfiles(userF);
    expect(remaining).toHaveLength(0);
  });
});
