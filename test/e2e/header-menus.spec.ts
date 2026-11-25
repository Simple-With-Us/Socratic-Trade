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

async function expectPanelHittable(panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  expect(await isHittable(panel)).toBe(true);
}

async function openConsole(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Socratic Trade").first()).toBeVisible({ timeout: 30_000 });
  await acceptConsentIfShown(page);
}

test("header account scope dropdown opens and is hittable", async ({ page }) => {
  await openConsole(page);
  await page.locator('button[title="Switch which account this console shows"]').click();
  await expectPanelHittable(page.getByRole("dialog", { name: "Account scope" }));
});

// ST-4645 (audit W3): the bell no longer opens a preview dropdown.  It is a
// link to the Alerts Center, the one destination for the unread count, so
// assert it is reachable and lands there.
test("header alerts bell links to the Alerts Center", async ({ page }) => {
  await openConsole(page);
  const bell = page.getByRole("link", { name: /^Alerts Center/ });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAttribute("href", "/console/activity?tab=alerts");
  expect(await isHittable(bell)).toBe(true);
  await bell.click();
  await expect(page).toHaveURL(/\/console\/activity\?tab=alerts/);
});

test("header profile menu opens and is hittable", async ({ page }) => {
  await openConsole(page);
  // ST-4637: on phones the desktop account trigger stays in the DOM but hidden,
  // and account, theme, and sign-out live in the "More controls" overflow.
  // Use whichever menu trigger this viewport actually shows.
  const trigger = page.locator('button[aria-haspopup="menu"]').filter({ visible: true });
  test.skip((await trigger.count()) === 0, "no signed-in identity in this environment");
  await trigger.first().click();
  const panel = page.locator(".con-menu-drop").last();
  await expectPanelHittable(panel);
});
