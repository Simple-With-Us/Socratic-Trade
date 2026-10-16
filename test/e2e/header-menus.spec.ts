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

async function expectPanelHittable(panel: Locator): Promise<void> {
  await expect(panel).toBeVisible();
  const hittable = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(24, r.height / 2));
    return hit !== null && el.contains(hit as Node);
  });
  expect(hittable).toBe(true);
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

test("header notifications dropdown opens and is hittable", async ({ page }) => {
  await openConsole(page);
  await page.getByRole("button", { name: /^Notifications/ }).click();
  await expectPanelHittable(page.getByRole("dialog", { name: "Notifications" }));
});

test("header profile menu opens and is hittable", async ({ page }) => {
  await openConsole(page);
  const trigger = page.locator('button[aria-haspopup="menu"]');
  test.skip((await trigger.count()) === 0, "no signed-in identity in this environment");
  await trigger.first().click();
  const panel = page.locator(".con-menu-drop").last();
  await expectPanelHittable(panel);
});
