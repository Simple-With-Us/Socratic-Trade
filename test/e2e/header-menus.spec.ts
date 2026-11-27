import { expect, test, type Locator, type Page } from "@playwright/test";

// ST-4544: the header bar is overflow-x:auto (320px guard), which clips any
// absolutely positioned dropdown inside it to the bar height — the account
// dropdown "opened" in state but never showed, in Safari and Chrome alike.
// The panels now portal to <body> with fixed anchoring (useAnchoredMenu).
// These tests assert the strong condition: the open panel is not only in the
// DOM, its center actually hit-tests to the panel (a clipped panel fails
// this even though toBeVisible passes on its layout box).

async function acceptConsentIfShown(page: Page): Promise<void> {
  const consent = page.getByRole("dialog", { name: "Terms, Privacy, and Shared Data" });
  try {
    await consent.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return;
  }
  await consent.getByRole("button", { name: /Accept & Continue/ }).click();
  await expect(consent).toBeHidden({ timeout: 15_000 });
}

/** True when the point at the element's center (capped 24px down) hit-tests
 *  to the element itself, so nothing clips or covers it. */
async function isHittable(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(24, r.height / 2));
    return hit !== null && node.contains(hit as Node);
  });
}

/** Visible, then hit-testable.  isHittable reads elementFromPoint once, so poll it:
 *  a transient overlay or entry animation during render must not fail the test,
 *  the same way toBeVisible retries. */
async function expectHittable(el: Locator): Promise<void> {
  await expect(el).toBeVisible();
  await expect.poll(() => isHittable(el), { timeout: 5_000 }).toBe(true);
}

async function openConsole(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Socratic Trade").first()).toBeVisible({ timeout: 30_000 });
  await acceptConsentIfShown(page);
}

test("header account scope dropdown opens and is hittable", async ({ page }) => {
  await openConsole(page);
  await page.locator('button[title="Switch which account this console shows"]').click();
  await expectHittable(page.getByRole("dialog", { name: "Account scope" }));
});

// ST-4645 (audit W3): the bell no longer opens a preview dropdown.  It is a
// link to the Alerts Center, the one destination for the unread count, so
// assert it is reachable and lands there.
test("header alerts bell links to the Alerts Center", async ({ page }) => {
  await openConsole(page);
  const bell = page.getByRole("link", { name: /^Alerts Center/ });
  // Match the target, not the exact string, so an absolute URL or extra params still pass.
  await expect(bell).toHaveAttribute("href", /\/console\/activity.*[?&]tab=alerts/);
  await expectHittable(bell);
  await bell.click();
  // Same tolerance as the href pattern: extra params on the landing URL are still the Alerts Center.
  await expect(page).toHaveURL(/\/console\/activity([?&][^#]*)?$/);
  await expect(page).toHaveURL(/tab=alerts/);
});

test("header profile menu opens and is hittable", async ({ page }) => {
  await openConsole(page);
  // ST-4637: on phones the desktop account trigger stays in the DOM but hidden,
  // and account, theme, and sign-out live in the "More controls" overflow.
  // Use whichever menu trigger this viewport actually shows.
  // count() does not auto-wait, so wait for the trigger to render first and skip
  // only when it never appears (no signed-in identity), not when it renders late.
  const trigger = page.locator('button[aria-haspopup="menu"]').filter({ visible: true });
  try {
    // Short wait: identity-less environments fail fast instead of stalling 15s (Kody 68zis4).
    await trigger.first().waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    test.skip(true, "no signed-in identity in this environment");
  }
  await trigger.first().click();
  const panel = page.locator(".con-menu-drop").last();
  await expectHittable(panel);
});
