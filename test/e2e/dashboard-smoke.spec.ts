import { expect, test, type Page } from "@playwright/test";

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

test("dashboard loads the core trading workspace", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // First-paint budget 30s, not the 10s expect default: the intro shell renders no text until
  // /api/dashboard returns, whose upstreams are deadline-bounded at 4-8s EACH but awaited
  // sequentially (#1293) — 10-25s worst-case first paint on a shared CI runner is legitimate.
  // This test's intent is "app boots and renders", not a first-paint SLA (FLEET-INFRA-K:
  // 11 flakes/5 days were all this line timing out at 10s).
  await expect(page.getByText("Socratic Trade").first()).toBeVisible({ timeout: 30_000 });
  await acceptConsentIfShown(page);
  await expect(page.getByText("Portfolio").first()).toBeVisible();
  await expect(page.getByText("Decision").first()).toBeVisible();

  // Default mobile pins are Home / Proposals / Activity / Orders (MOBILE_TABS_MAX=4).
  // Scan lives in the More sheet. getByText("Scan").first() used to match the desktop
  // rail's hidden <span class="flex-1">Scan</span> on iPhone. #3097 opened More, then
  // the legal ConsentGate overlay (z-200) intercepted the click — smoke still red.
  // Dismiss consent first, then open More on the phone bar, else assert the rail link.
  const more = page.getByRole("button", { name: /^More$/ });
  if (await more.isVisible()) {
    await more.click();
    await expect(page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "Scan" })).toBeVisible();
  } else {
    await expect(page.getByRole("navigation", { name: "Console navigation" }).getByRole("link", { name: "Scan" })).toBeVisible();
  }

  await expect(page.getByRole("button", { name: /Run/i }).first()).toBeVisible();
  // Header kill switch: "Stop" while the system is active, "Start" while halted.
  await expect(page.getByRole("button", { name: /Start|Stop/i }).first()).toBeVisible();
});
